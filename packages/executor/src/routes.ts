import { attachPrevArkTxs, type PrevTxSource, Transaction } from "@arkade-os/sdk";
import { ensure, faultCode, sha256Hex } from "@hive/kit";
import { base64, hex } from "@scure/base";
import { buildSpend, type CovenantSpend } from "./spend.js";

/**
 * What a delegatee needs to execute a spend: its template, the variables, the
 * coins, until when, and the exit-leaf key's signature over all of it.
 */
export interface SpendRequest {
  templateId: string;
  variables: Record<string, string>;
  outpoints: string[];
  expiresAt: number;
  pubkey: string;
  signature: string;
}

/** The existing delegatee request identity; checked before accepting its acknowledgement. */
export function requestFingerprint(request: SpendRequest): string {
  const sorted = Object.fromEntries(Object.entries(request.variables).sort(([a], [b]) => (a < b ? -1 : 1)));
  return sha256Hex(`${request.templateId}\0${JSON.stringify(sorted)}\0${request.outpoints.join(",")}`);
}

/**
 * One spend, in every form a route may need. `txid` is what each route
 * builds: the router recognizes the outcome by it, whoever executed.
 */
export interface Action {
  txid: string;
  /** For routes that build the transaction themselves. */
  spend?: CovenantSpend;
  /** For a delegatee. */
  request?: SpendRequest;
  /** Local posting deadline. It does not revoke signatures a service already emitted. */
  validUntil: number;
}

/** Desk is an internal provider fallback, never a deployment route setting. */
export type RouteName = "self" | "delegatee" | "desk";

export interface RouteContext {
  signal: AbortSignal;
  deadline: number;
  remainingMs(): number;
  recheckPostable(): void;
  beforePost(): Promise<void>;
}

/** Only a locally correlated covenant diagnostic may pin a route. HTTP status is insufficient. */
export interface CovenantRejection {
  source: "offline-model" | "bounded-vm";
  route: RouteName;
  txid: string;
  outpoints: string[];
  reason: "signature-verification" | "covenant-failed";
}

export function requireRejection(proof: CovenantRejection, action: Action, route: RouteName): void {
  const outpoints =
    action.spend?.inputs.map((input) => `${input.txid}:${input.vout}`) ?? action.request?.outpoints;
  ensure(proof && ["signature-verification", "covenant-failed"].includes(proof.reason), "COVENANT_PROOF");
  ensure(proof.source === "offline-model" || proof.source === "bounded-vm", "COVENANT_PROOF");
  ensure(
    Array.isArray(proof.outpoints) &&
      proof.outpoints.every((outpoint) => typeof outpoint === "string") &&
      proof.route === route &&
      proof.txid === action.txid &&
      outpoints?.length &&
      JSON.stringify([...proof.outpoints].sort()) === JSON.stringify([...outpoints].sort()),
    "COVENANT_PROOF",
  );
}

/** A trusted desk forwards its operational correlation; this is not an independent VM signature. */
export class CovenantRefusal extends Error {
  readonly rejection: CovenantRejection;
  constructor(proof: CovenantRejection) {
    super("COVENANT_REFUSAL");
    ensure(
      ["offline-model", "bounded-vm"].includes(proof.source) &&
        ["self", "delegatee", "desk"].includes(proof.route) &&
        ["signature-verification", "covenant-failed"].includes(proof.reason) &&
        /^[0-9a-f]{64}$/.test(proof.txid) &&
        proof.outpoints.every((outpoint) => /^[0-9a-f]{64}:[0-9]{1,10}$/.test(outpoint)),
      "COVENANT_PROOF",
    );
    this.name = "CovenantRefusal";
    this.rejection = {
      source: proof.source,
      route: proof.route,
      txid: proof.txid,
      outpoints: [...proof.outpoints],
      reason: proof.reason,
    };
  }
}

/** Also bounds direct gate submissions, which do not go through a Router. */
export function routeContext(action: Action, budgetMs = 60_000): RouteContext {
  const deadline = Math.min(
    Date.now() + budgetMs,
    Math.min(action.validUntil, action.request?.expiresAt ?? action.validUntil) * 1000,
  );
  const signal = AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now())));
  const context: RouteContext = {
    deadline,
    signal,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    recheckPostable: () => ensure(!signal.aborted && Date.now() < deadline, "EXECUTION_DEADLINE"),
    beforePost: async () => {
      context.recheckPostable();
    },
  };
  return context;
}

/**
 * An acknowledgement is accepted, an opaque service failure is unavailable,
 * and a checked local inconsistency is invalid. Only an explicit correlated
 * covenant verdict is refused; that verdict pins the action to the same route.
 */
export type RouteAnswer =
  | { result: "accepted"; reference?: string }
  | { result: "unavailable" | "invalid"; detail: string }
  | { result: "refused"; detail: string; proof: CovenantRejection };

export interface Route {
  readonly name: RouteName;
  submit(action: Action, context?: RouteContext): Promise<RouteAnswer>;
}

const stableCode = (error: unknown): string => {
  const code = faultCode(error, "LOCAL_INVARIANT");
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "LOCAL_INVARIANT";
};

/** Never persist a remote error body: it can echo witnesses or authentication data. */
export function routeFailure(error: unknown): RouteAnswer {
  const code = stableCode(error);
  if (
    [
      "COIN_EXPIRY_UNKNOWN",
      "COIN_UNKNOWN",
      "COIN_SPENT",
      "COIN_EXPIRES_TOO_SOON",
      "COINS_RENEWING",
      "INDEXER",
      "SERVICE",
    ].includes(code)
  )
    return { result: "unavailable", detail: code };
  if (error instanceof HttpError)
    return {
      result: error.status === 401 || error.status === 403 ? "invalid" : "unavailable",
      detail: `HTTP_${error.status}`,
    };
  if (
    error instanceof TypeError ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ||
    faultCode(error) === "EXECUTION_DEADLINE"
  )
    return { result: "unavailable", detail: "SERVICE_UNAVAILABLE" };
  return { result: "invalid", detail: stableCode(error) };
}

/** An HTTP answer other than 200 from a service, with its status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`${status} ${body}`);
    this.name = "HttpError";
  }
}

/** The Emulator REST transport preserves HTTP status without treating it as a VM verdict. */
/** A transport must call context.beforePost immediately before its POST. */
export interface RouteEmulator {
  getInfo(context?: RouteContext): Promise<{ signerPubkey: string }>;
  submitTx(
    arkTx: string,
    checkpointTxs: string[],
    context?: RouteContext,
  ): Promise<{ signedArkTx: string; signedCheckpointTxs: string[] }>;
}

export function restEmulator(url: string): RouteEmulator {
  const post = async (path: string, body: unknown, context?: RouteContext) => {
    const encoded = JSON.stringify(body);
    await context?.beforePost();
    context?.recheckPostable();
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encoded,
      signal: context?.signal ?? AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return {
    async getInfo(context) {
      context?.recheckPostable();
      const response = await fetch(`${url}/v1/info`, {
        signal: context?.signal ?? AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new HttpError(response.status, await response.text());
      return { signerPubkey: String(((await response.json()) as { signerPubkey?: unknown }).signerPubkey) };
    },
    async submitTx(arkTx, checkpointTxs, context) {
      const data = await post("/v1/tx", { arkTx, checkpointTxs }, context);
      ensure(typeof data.signedArkTx === "string", "EMULATOR_RESPONSE", "no signed ark tx");
      ensure(Array.isArray(data.signedCheckpointTxs), "EMULATOR_RESPONSE", "no signed checkpoints");
      return {
        signedArkTx: data.signedArkTx,
        signedCheckpointTxs: (data.signedCheckpointTxs as unknown[]).map(String),
      };
    },
  };
}

export interface SelfRouteOptions {
  /** The Emulator, which runs each covenant and, as last signer, finalizes with the Arkade Operator. */
  emulator: RouteEmulator;
  covenantRejection?: (action: Action, error: unknown) => Promise<CovenantRejection | undefined>;
  /**
   * The key the contracts commit to as co-signer, compressed hex. The route
   * reads the Emulator's own before its first submission and stands aside
   * while they differ: that Emulator's signatures could not spend the coins.
   */
  emulatorKey: string;
  /** The indexer's virtual transactions: the Emulator reads each coin's creating transaction. */
  prevTxs: PrevTxSource | ((context: RouteContext) => PrevTxSource);
  /** The Arkade Operator's checkpoint tapscript, hex, from its `/v1/info`. */
  checkpointTapscript: string;
  /** The Arkade Operator's signer, compressed or x-only hex. */
  serverKey: string;
}

/**
 * Execution by whoever holds the spend: build the transaction, hand it to the
 * Emulator, which checks every covenant and, signing last, submits and
 * finalizes it with the Arkade Operator. No key of ours signs anything: the
 * covenant leaves need only the Operator and the Emulator.
 */
export function selfRoute(options: SelfRouteOptions): Route {
  const server = options.serverKey.length === 66 ? options.serverKey.slice(2) : options.serverKey;
  let signerChecked = false;
  return {
    name: "self",
    async submit(action, providedContext) {
      const context = providedContext ?? routeContext(action);
      try {
        context.recheckPostable();
        if (!action.spend) return { result: "unavailable", detail: "NO_BUILDABLE_SPEND" };
        if (action.spend.inputs.some((i) => !i.covenant))
          return { result: "invalid", detail: "UNSUPPORTED_INPUT" };
        let built: ReturnType<typeof buildSpend>;
        try {
          built = buildSpend(action.spend, options.checkpointTapscript);
        } catch (error) {
          return { result: "invalid", detail: stableCode(error) };
        }
        ensure(built.txid === action.txid, "ACTION_MISMATCH");
        if (!signerChecked) {
          const { signerPubkey } = await options.emulator.getInfo(context);
          context.recheckPostable();
          ensure(signerPubkey === options.emulatorKey, "EMULATOR_KEY_MISMATCH");
          signerChecked = true;
        }
        try {
          await attachPrevArkTxs(
            built.arkTx,
            action.spend.inputs.map((i) => i.txid),
            typeof options.prevTxs === "function" ? options.prevTxs(context) : options.prevTxs,
          );
        } catch {
          return { result: "unavailable", detail: "PREVIOUS_TRANSACTIONS_UNAVAILABLE" };
        }
        context.recheckPostable();
        let signed: { signedArkTx: string; signedCheckpointTxs: string[] };
        try {
          signed = await options.emulator.submitTx(
            base64.encode(built.arkTx.toPSBT()),
            built.checkpoints.map((c) => base64.encode(c.toPSBT())),
            context,
          );
        } catch (error) {
          const proof = await options.covenantRejection?.(action, error);
          if (proof) {
            requireRejection(proof, action, "self");
            return { result: "refused", detail: "COVENANT_REJECTED", proof };
          }
          return routeFailure(error);
        }
        let returned: ReturnType<typeof Transaction.fromPSBT>;
        try {
          returned = Transaction.fromPSBT(base64.decode(signed.signedArkTx), { allowUnknown: true });
        } catch {
          return { result: "invalid", detail: "EMULATOR_RESPONSE" };
        }
        ensure(returned.id === built.txid, "EMULATOR_MISMATCH");
        // A response only means accepted. The Router independently observes inputs and outputs.
        for (let i = 0; i < returned.inputsLength; i++) {
          const sigs = returned.getInput(i).tapScriptSig ?? [];
          ensure(
            sigs.some(([k]) => hex.encode(k.pubKey) === server),
            "EMULATOR_RESPONSE",
          );
        }
        return { result: "accepted", reference: built.txid };
      } catch (error) {
        return routeFailure(error);
      }
    },
  };
}

/** The part of `fetch` the delegatee route uses. */
export type JsonFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DelegateeRouteOptions {
  url: string;
  fetch?: JsonFetch;
  covenantRejection?: (action: Action, error: unknown) => Promise<CovenantRejection | undefined>;
}

/** Execution by a delegatee: it builds the same transaction from the request's template. */
export function delegateeRoute(options: DelegateeRouteOptions): Route {
  const doFetch: JsonFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    name: "delegatee",
    async submit(action, providedContext) {
      if (!action.request) return { result: "unavailable", detail: "NO_SIGNED_REQUEST" };
      const context = providedContext ?? routeContext(action, 30_000);
      try {
        const encoded = JSON.stringify(action.request);
        await context.beforePost();
        context.recheckPostable();
        const response = await doFetch(`${options.url}/v1/spend`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
          signal: context.signal,
        });
        const body = (await response.json().catch(() => ({}))) as { id?: unknown };
        if (!response.ok) {
          const error = new HttpError(response.status, "");
          const proof = await options.covenantRejection?.(action, error);
          if (proof) {
            requireRejection(proof, action, "delegatee");
            return { result: "refused", detail: "COVENANT_REJECTED", proof };
          }
          return routeFailure(error);
        }
        ensure(
          typeof body.id === "string" && body.id === requestFingerprint(action.request),
          "DELEGATEE_RESPONSE",
        );
        return { result: "accepted", reference: body.id };
      } catch (error) {
        return routeFailure(error);
      }
    },
  };
}
