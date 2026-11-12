import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { arkAddress, conditionField, parseArkAddress, xOnly } from "@hive/ark";
import { hex, unhex } from "@hive/kit";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { Transaction } from "@scure/btc-signer";
import { encodeInvoice } from "./bolt11.js";
import type { FakeNetwork } from "./fake-network.js";

const encodePsbt = (tx: Transaction) => Buffer.from(tx.toPSBT()).toString("base64");

/**
 * An in-memory stand-in for lnurl-server 0.3.x and the swap behind it: the
 * wallet session, address registration with an Arkade destination, LUD-16 pay
 * metadata, both payment rails and LUD-21 verify. "Paying" mints the treasury
 * coin through a transaction shaped like the real arrival, so classification
 * runs on the same leaf scripts as on regtest.
 */
export interface LnurlStub {
  baseUrl: string;
  /** Answers a dishonest or misconfigured server could give, applied to later callbacks. */
  misbehave: { invoicePrefix?: string; verifyHash?: string; verifyHost?: string };
  payInvoice(invoice: string): Promise<void>;
  sweep(destinationScript: string): Promise<void>;
  close(): Promise<void>;
}

type Payment = {
  rail: "lightning" | "arkade";
  amountSats: number;
  preimage: Buffer;
  settled: boolean;
  invoice?: string;
  destinationScript?: string;
  reference?: string;
};

/** A valid x-only key: random bytes are not always a curve point. */
const point = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));

const leaf = (prefix: string, hash20: Uint8Array, operator: string) =>
  unhex(`${prefix}a914${hex(hash20)}876920${operator}ad20${point()}ac`);

/**
 * A one-input transaction paying `value` to `script` through a preimage leaf, as
 * a covenant claim or sweep does, and the checkpoint it spends: like every Arkade
 * transaction, the arrival spends a checkpoint output, and the checkpoint spends
 * the paying script.
 */
export function arrivalTransaction(args: {
  kind: "swap-claim" | "destination-sweep";
  script: string;
  value: number;
  preimage: Uint8Array;
  operatorKey: string;
  sourceScript?: string;
}): { tx: Transaction; checkpoint: Transaction } {
  const hash20 = ripemd160(createHash("sha256").update(args.preimage).digest());
  const script = leaf(args.kind === "swap-claim" ? "82012088" : "", hash20, args.operatorKey);
  const amount = BigInt(args.value);
  const checkpoint = new Transaction({ version: 3, allowUnknownOutputs: true });
  checkpoint.addInput({
    txid: randomBytes(32),
    index: 0,
    witnessUtxo: { script: unhex(args.sourceScript ?? `5120${point()}`), amount },
  });
  checkpoint.addOutput({ script: unhex(`5120${point()}`), amount });
  const tx = new Transaction({
    version: 3,
    allowUnknown: true,
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });
  tx.addInput({
    txid: unhex(checkpoint.id),
    index: 0,
    witnessUtxo: { script: checkpoint.getOutput(0).script!, amount },
    tapLeafScript: [
      [
        { version: 0xc0, internalKey: unhex(args.operatorKey), merklePath: [randomBytes(32)] },
        Uint8Array.of(...script, 0xc0),
      ],
    ],
  });
  tx.updateInput(0, { unknown: [conditionField([args.preimage])] });
  tx.addOutput({ script: unhex(args.script), amount });
  return { tx, checkpoint };
}

export async function startLnurlStub(fake: FakeNetwork): Promise<LnurlStub> {
  const operatorKey = hex(xOnly(fake.serverKey));
  const tokens = new Set<string>();
  const addresses = new Map<string, { token: string; arkadeAddress?: string }>();
  const payments = new Map<string, Payment>();
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const readBody = async (request: import("node:http").IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return text ? (JSON.parse(text) as Record<string, string>) : {};
  };
  const treasuryOf = (username: string) => {
    const address = addresses.get(username)?.arkadeAddress;
    if (!address) throw new Error("no destination");
    return parseArkAddress(address).pkScript;
  };
  const misbehave: LnurlStub["misbehave"] = {};
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const host = (request.headers.host ?? "localhost").replace(/:\d+$/, "");
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (request.method === "POST" && url.pathname === "/lnurl/session") {
      const token = hex(randomBytes(32));
      tokens.add(token);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: session_created\ndata: ${JSON.stringify({ sessionId: hex(randomBytes(16)), token })}\n\n`,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/lnurl/address") {
      const body = await readBody(request);
      if (!tokens.has(body.token ?? "")) return json(response, 401, { error: "Unauthorized" });
      if (addresses.has(body.username!)) return json(response, 409, { error: "taken" });
      addresses.set(body.username!, { token: body.token! });
      return json(response, 201, {
        lightningAddress: `${body.username}@${host}`,
        username: body.username,
        status: "active",
      });
    }
    if (request.method === "GET" && url.pathname === "/lnurl/address") {
      return json(
        response,
        200,
        [...addresses]
          .filter(([, a]) => a.token === bearer)
          .map(([username]) => ({ username, status: "active" })),
      );
    }
    const arkade = /^\/lnurl\/address\/([^/]+)\/arkade$/.exec(url.pathname);
    if (request.method === "POST" && arkade) {
      const body = await readBody(request);
      const entry = addresses.get(arkade[1]!);
      if (!entry || entry.token !== bearer) return json(response, 404, { error: "not owned" });
      entry.arkadeAddress = body.arkadeAddress;
      return json(response, 200, { ok: true });
    }
    const meta = /^\/\.well-known\/lnurlp\/([^/]+)(\/callback)?$/.exec(url.pathname);
    if (request.method === "GET" && meta) {
      const username = meta[1]!;
      if (!addresses.get(username)?.arkadeAddress)
        return json(response, 200, { status: "ERROR", reason: "offline" });
      if (!meta[2]) {
        return json(response, 200, {
          tag: "payRequest",
          // Like lnurl-server, the callback carries the host without its port.
          callback: `http://${host}/.well-known/lnurlp/${username}/callback`,
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          metadata: "[]",
          paymentOptions: [
            { id: "lightning", type: "lightning" },
            { id: "arkade", type: "arkade" },
          ],
        });
      }
      const amountSats = Number(url.searchParams.get("amount")) / 1000;
      const preimage = randomBytes(32);
      const origin = `http://localhost:${(server.address() as { port: number }).port}`;
      if (url.searchParams.get("paymentOption") === "arkade") {
        const id = hex(randomBytes(16));
        const destinationScript = `5120${point()}`;
        payments.set(id, { rail: "arkade", amountSats, preimage, settled: false, destinationScript });
        return json(response, 200, {
          status: "OK",
          paymentOption: "arkade",
          paymentDestination: arkAddress("regtest", fake.serverKey, destinationScript),
          verify: `${origin}/lnurl/verify/${id}`,
        });
      }
      const paymentHash = createHash("sha256").update(preimage).digest("hex");
      const invoice = encodeInvoice({
        prefix: misbehave.invoicePrefix ?? "bcrt",
        amount: `${amountSats * 10}n`,
        paymentHash,
        createdAt: Math.floor(Date.now() / 1000),
      });
      payments.set(paymentHash, { rail: "lightning", amountSats, preimage, settled: false, invoice });
      void treasuryOf(username);
      return json(response, 200, {
        pr: invoice,
        routes: [],
        verify: `${misbehave.verifyHost ? `http://${misbehave.verifyHost}` : origin}/lnurl/verify/${misbehave.verifyHash ?? paymentHash}`,
      });
    }
    const verify = /^\/lnurl\/verify\/([0-9a-f]+)$/.exec(url.pathname);
    if (request.method === "GET" && verify) {
      const payment = payments.get(verify[1]!);
      if (!payment) return json(response, 404, { status: "ERROR" });
      return payment.rail === "lightning"
        ? json(response, 200, {
            status: "OK",
            settled: payment.settled,
            ...(payment.settled ? { preimage: hex(payment.preimage) } : {}),
            pr: payment.invoice,
          })
        : json(response, 200, {
            status: "OK",
            settled: payment.settled,
            paymentOption: "arkade",
            paymentReference: payment.reference ?? null,
          });
    }
    json(response, 404, { error: "Not found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as { port: number }).port;
  const treasury = () => treasuryOf([...addresses.keys()][0]!);
  return {
    baseUrl: `http://localhost:${port}`,
    misbehave,
    async payInvoice(invoice) {
      const payment = [...payments.values()].find((p) => p.invoice === invoice);
      if (!payment) throw new Error("unknown invoice");
      const { tx, checkpoint } = arrivalTransaction({
        kind: "swap-claim",
        script: treasury(),
        value: payment.amountSats,
        preimage: payment.preimage,
        operatorKey,
      });
      fake.remember(checkpoint.id, encodePsbt(checkpoint));
      fake.mint(treasury(), payment.amountSats, { source: { txid: tx.id, psbt: encodePsbt(tx) } });
      payment.settled = true;
    },
    async sweep(destinationScript) {
      const payment = [...payments.values()].find((p) => p.destinationScript === destinationScript);
      if (!payment) throw new Error("unknown destination");
      const { tx, checkpoint } = arrivalTransaction({
        kind: "destination-sweep",
        script: treasury(),
        value: payment.amountSats,
        preimage: payment.preimage,
        operatorKey,
        sourceScript: destinationScript,
      });
      fake.remember(checkpoint.id, encodePsbt(checkpoint));
      fake.mint(treasury(), payment.amountSats, { source: { txid: tx.id, psbt: encodePsbt(tx) } });
      payment.settled = true;
      payment.reference = tx.id;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
