import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArkAddress } from "@hive/ark";
import {
  ensure,
  Fault,
  hexField,
  nowIso,
  readBoundedResponse,
  readJsonIfPresent,
  readPrivateJson,
  stateExists,
  writeOnce,
  writePrivateOnce,
} from "@hive/kit";
import { decodeInvoice, type InvoiceNetwork, type HiveNetwork } from "@hive/protocol";

/**
 * The hive's Lightning address on lnurl-server (ArkLabsHQ/lnurl-server 0.3.x).
 *
 * The treasury address is the registered Arkade destination, so a Lightning
 * payment ends as a solver-funded swap claimed straight to the treasury script,
 * and a payment on the Arkade rail lands on a per-payment covenant destination
 * that can only be swept to the treasury. The receiver key both name is the
 * stewards' MuSig2 aggregate. Nothing here is credit: a contribution counts only
 * once its treasury output is observed (`contributions.ts`).
 */
export interface IntakeEndpoint {
  /** lnurl-server's public origin: `http://localhost:9090` on regtest, `https://lnurl.mutinynet.arkade.sh` on Mutinynet. */
  baseUrl: string;
  username: string;
}

export interface IntakeRegistration {
  schema: "hive-intake/v4";
  lightningAddress: string;
  endpoint: IntakeEndpoint;
  treasuryAddress: string;
  treasuryScript: string;
  intakeKey: string;
  registeredAt: string;
}

export type IntakeRail = "lightning" | "arkade";

/** One payment request handed to a contributor, kept so its observed output can be attributed. */
export interface IntakeRequest {
  schema: "hive-intake-request/v4";
  id: string;
  rail: IntakeRail;
  amountSats: number;
  requestedAt: string;
  verify: string;
  /** Lightning: the BOLT11 invoice and its payment hash. */
  invoice?: string;
  paymentHash?: string;
  /** Arkade rail: the per-payment destination and its script. */
  destination?: string;
  destinationScript?: string;
}

export interface IntakeSettlement {
  settled: boolean;
  preimage?: string;
  paymentReference?: string | null;
}

type Fetch = typeof fetch;
const MAX_RESPONSE = 64 * 1024;
const MSAT_PER_SAT = 1000;

async function getJson(
  fetcher: Fetch,
  url: URL,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const text = (await readBoundedResponse(response, MAX_RESPONSE)).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Fault("INTAKE_RESPONSE", `${url.pathname} answered ${response.status} without JSON`);
  }
  return { status: response.status, body };
}

/** Open a wallet session and read its first event, then close the stream. */
async function openSession(fetcher: Fetch, base: URL): Promise<{ sessionId: string; token: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(new URL("/lnurl/session", base), {
      method: "POST",
      headers: { accept: "text/event-stream" },
      redirect: "error",
      signal: controller.signal,
    });
    ensure(response.ok && response.body, "INTAKE_SESSION", `status ${response.status}`);
    const reader = response.body.getReader();
    let buffer = "";
    while (buffer.length < MAX_RESPONSE) {
      const next = await reader.read();
      if (next.done) break;
      buffer += Buffer.from(next.value).toString("utf8");
      const match = /event: session_created\r?\ndata: (.*)\r?\n/.exec(buffer);
      if (!match) continue;
      const created = JSON.parse(match[1]!) as { sessionId?: unknown; token?: unknown };
      ensure(
        typeof created.sessionId === "string" &&
          typeof created.token === "string" &&
          created.token.length >= 16,
        "INTAKE_SESSION",
      );
      return { sessionId: created.sessionId, token: created.token };
    }
    throw new Fault("INTAKE_SESSION", "no session_created event");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function baseOf(endpoint: IntakeEndpoint): URL {
  const base = new URL(endpoint.baseUrl);
  ensure(base.protocol === "https:" || base.protocol === "http:", "INVALID", "lnurl-server URL");
  ensure(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(endpoint.username), "INVALID", "username");
  return base;
}

/**
 * Register the hive's Lightning address with the treasury as its Arkade
 * destination. Idempotent: a saved registration is returned after checking it
 * names the same treasury and key. The session token is the only credential and
 * stays in the private `tokenPath`.
 */
export async function registerIntake(args: {
  endpoint: IntakeEndpoint;
  treasuryAddress: string;
  intakeKey: string;
  statePath: string;
  tokenPath: string;
  operatorKey: string;
  fetch?: Fetch;
}): Promise<IntakeRegistration> {
  const fetcher = args.fetch ?? fetch;
  const base = baseOf(args.endpoint);
  const decoded = parseArkAddress(args.treasuryAddress);
  ensure(
    decoded.serverKey === args.operatorKey,
    "INTAKE_DESTINATION",
    "treasury address names another Operator",
  );
  const treasuryScript = decoded.pkScript;
  const saved = readJsonIfPresent<IntakeRegistration>(args.statePath);
  if (saved) {
    ensure(
      saved.treasuryAddress === args.treasuryAddress &&
        saved.intakeKey === args.intakeKey &&
        saved.endpoint.baseUrl === args.endpoint.baseUrl &&
        saved.endpoint.username === args.endpoint.username,
      "INTAKE_CHANGED",
    );
    return saved;
  }
  const session = stateExists(args.tokenPath)
    ? readPrivateJson<{ sessionId: string; token: string }>(args.tokenPath)
    : writePrivateOnce(args.tokenPath, await openSession(fetcher, base));
  const claimed = await getJson(fetcher, new URL("/lnurl/address", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: session.token, username: args.endpoint.username }),
  });
  const domain = base.hostname;
  // A resumed registration may find the address already claimed by this same token.
  const listed =
    claimed.status === 201
      ? []
      : ((
          await getJson(fetcher, new URL("/lnurl/address", base), {
            headers: { authorization: `Bearer ${session.token}` },
          })
        ).body as { username?: string; status?: string }[]);
  ensure(
    claimed.status === 201 ||
      (Array.isArray(listed) &&
        listed.some((a) => a.username === args.endpoint.username && a.status === "active")),
    "INTAKE_ADDRESS",
    `status ${claimed.status}`,
  );
  const address = `${args.endpoint.username}@${domain}`;
  const destination = await getJson(
    fetcher,
    new URL(`/lnurl/address/${args.endpoint.username}/arkade`, base),
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ arkadeAddress: args.treasuryAddress, claimPublicKey: args.intakeKey }),
    },
  );
  ensure(destination.status === 200, "INTAKE_DESTINATION", `status ${destination.status}`);
  const pay = await payRequest(args.endpoint, fetcher);
  ensure(
    pay.options.includes("lightning") && pay.options.includes("arkade"),
    "INTAKE_OPTIONS",
    "offline receive is not enabled for the address",
  );
  return writeOnce<IntakeRegistration>(args.statePath, {
    schema: "hive-intake/v4",
    lightningAddress: address,
    endpoint: args.endpoint,
    treasuryAddress: args.treasuryAddress,
    treasuryScript,
    intakeKey: args.intakeKey,
    registeredAt: nowIso(),
  });
}

/** LUD-16 pay metadata, with the callback resolved against the configured origin. */
export async function payRequest(
  endpoint: IntakeEndpoint,
  fetcher: Fetch = fetch,
): Promise<{ callback: URL; minSats: number; maxSats: number; options: string[] }> {
  const base = baseOf(endpoint);
  const { status, body } = await getJson(fetcher, new URL(`/.well-known/lnurlp/${endpoint.username}`, base));
  const meta = body as {
    tag?: string;
    callback?: string;
    minSendable?: number;
    maxSendable?: number;
    paymentOptions?: { id?: string }[];
  };
  ensure(
    status === 200 && meta.tag === "payRequest" && typeof meta.callback === "string",
    "INTAKE_PAY_REQUEST",
  );
  // lnurl-server builds the callback from the request host without its port; keep the path only.
  const advertised = new URL(meta.callback);
  ensure(advertised.hostname === base.hostname, "INTAKE_PAY_REQUEST", "callback on another host");
  return {
    callback: new URL(`${advertised.pathname}${advertised.search}`, base),
    minSats: Math.ceil(Number(meta.minSendable) / MSAT_PER_SAT),
    maxSats: Math.floor(Number(meta.maxSendable) / MSAT_PER_SAT),
    options: (meta.paymentOptions ?? []).map((option) => String(option.id)),
  };
}

/** Mutinynet is a signet: its invoices carry the `lntbs` prefix. */
const INVOICE_NETWORK: Record<HiveNetwork, InvoiceNetwork> = {
  regtest: "regtest",
  mutinynet: "signet",
  bitcoin: "bitcoin",
};

/**
 * Ask the hive's address for one payment, as any payer would, and keep the
 * request so the treasury output it produces can be attributed exactly: by
 * payment hash on Lightning, by destination script on the Arkade rail.
 */
export async function requestContribution(args: {
  endpoint: IntakeEndpoint;
  network: HiveNetwork;
  rail: IntakeRail;
  amountSats: number;
  operatorKey: string;
  requestsDirectory: string;
  fetch?: Fetch;
}): Promise<IntakeRequest> {
  const fetcher = args.fetch ?? fetch;
  const pay = await payRequest(args.endpoint, fetcher);
  ensure(
    Number.isSafeInteger(args.amountSats) && args.amountSats >= pay.minSats && args.amountSats <= pay.maxSats,
    "INTAKE_AMOUNT",
  );
  ensure(pay.options.includes(args.rail), "INTAKE_OPTIONS", `${args.rail} is not offered`);
  const url = new URL(pay.callback);
  url.searchParams.set("amount", String(args.amountSats * MSAT_PER_SAT));
  if (args.rail === "arkade") url.searchParams.set("paymentOption", "arkade");
  const { status, body } = await getJson(fetcher, url);
  const answer = body as {
    status?: string;
    reason?: string;
    pr?: string;
    verify?: string;
    paymentDestination?: string;
  };
  ensure(
    status === 200 && answer.status !== "ERROR" && typeof answer.verify === "string",
    "INTAKE_CALLBACK",
    answer.reason,
  );
  // Like the callback, the LUD-21 status URL is read only from the configured origin.
  const advertised = new URL(answer.verify);
  const reference = /^\/lnurl\/verify\/([0-9a-f]{32,64})$/.exec(advertised.pathname);
  ensure(
    advertised.hostname === baseOf(args.endpoint).hostname && reference && !advertised.search,
    "INTAKE_CALLBACK",
    "unexpected verify URL",
  );
  const verify = new URL(advertised.pathname, baseOf(args.endpoint));
  const id = randomUUID();
  const record: IntakeRequest = {
    schema: "hive-intake-request/v4",
    id,
    rail: args.rail,
    amountSats: args.amountSats,
    requestedAt: nowIso(),
    verify: verify.href,
  };
  if (args.rail === "lightning") {
    ensure(typeof answer.pr === "string", "INTAKE_CALLBACK", "no invoice");
    const invoice = decodeInvoice(answer.pr);
    ensure(
      invoice.network === INVOICE_NETWORK[args.network],
      "INTAKE_INVOICE",
      "invoice for another network",
    );
    ensure(
      invoice.amountSats === args.amountSats,
      "INTAKE_INVOICE",
      "invoice amount differs from the request",
    );
    // The status URL must follow the invoice's own payment hash, or a settled payment could not be attributed.
    ensure(
      hexField(reference[1], 32, "payment hash") === invoice.paymentHash,
      "INTAKE_INVOICE",
      "verify URL names another payment",
    );
    record.invoice = answer.pr;
    record.paymentHash = invoice.paymentHash;
  } else {
    ensure(typeof answer.paymentDestination === "string", "INTAKE_CALLBACK", "no destination");
    const destination = parseArkAddress(answer.paymentDestination);
    ensure(
      destination.serverKey === args.operatorKey,
      "INTAKE_DESTINATION",
      "destination names another Operator",
    );
    record.destination = answer.paymentDestination;
    record.destinationScript = destination.pkScript;
  }
  return writeOnce(resolve(args.requestsDirectory, `${id}.json`), record);
}

/** LUD-21 status. A settled Lightning payment must reveal the preimage of its payment hash. */
export async function intakeSettlement(
  request: IntakeRequest,
  fetcher: Fetch = fetch,
): Promise<IntakeSettlement> {
  const { status, body } = await getJson(fetcher, new URL(request.verify));
  const answer = body as {
    status?: string;
    settled?: boolean;
    preimage?: string;
    paymentReference?: string | null;
  };
  ensure(status === 200 && answer.status === "OK" && typeof answer.settled === "boolean", "INTAKE_VERIFY");
  if (request.rail === "lightning" && answer.settled) {
    const preimage = hexField(answer.preimage, 32, "preimage");
    ensure(
      createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") === request.paymentHash,
      "INTAKE_VERIFY",
      "preimage does not match the payment hash",
    );
    return { settled: true, preimage };
  }
  return { settled: answer.settled, paymentReference: answer.paymentReference ?? null };
}
