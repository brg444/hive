import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Extension, Transaction as SdkTransaction } from "@arkade-os/sdk";
import {
  type Artifact,
  arkAddress,
  checkpointTxid,
  claimMessage,
  claimSpend,
  type Deployment,
  decodeScriptNum,
  type Instance,
  instantiate,
  leafOf,
  receiptMessage,
  refundSpend,
  scriptNum,
  sendMessage,
  sendSpend,
  sequence,
  spendFingerprint,
  spendRequestMessage,
  TREASURY_SEND_TAG,
  WALLET_SEND_TAG,
  xOnly,
} from "@hive/ark";
import { buildSpend, type CovenantSpend } from "@hive/executor";
import { closeServer, hex, listenLocal, readJsonBody, sendJson, sha256Hex, unhex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { type ModelRejection, ModelSignatureRejection } from "../../gates/support/covenant.js";
import mutinynetInfo from "./mutinynet-info.json" with { type: "json" };

/**
 * An in-memory Arkade Operator, indexer and delegatee behind real HTTP, so
 * steward workers, the hive and providers reach it exactly as they reach the
 * real services. The delegatee side registers artifacts, templates, watches
 * and spends, checks a spend's request signature against the exit leaf, and
 * executes it by applying the covenant rules in TypeScript: the attestation
 * or receipt and claim signatures, the outputs and the deadlines. The real
 * Emulator runs the same rules in Arkade Script on the regtest stack; this
 * fake only lets the hive's own logic be tested without one.
 */
export interface FakeCoin {
  txid: string;
  vout: number;
  amount: number;
  script: string;
  createdAt: number;
  expiresAt: number;
  isSpent: boolean;
  spentBy: string;
  settledBy: string;
  arkTxid: string;
  commitmentTxids: string[];
  /** Created by an Ark transaction and not yet in a batch, as arkd's indexer reports it. */
  isPreconfirmed: boolean;
}

interface Attempt {
  outpoints: string[];
  commitmentTxid: string;
  success: boolean;
  error: string;
  attemptedAt: number;
}

interface Delegation {
  id: string;
  kind: "watch" | "spend";
  fingerprint: string;
  templateId: string;
  variables: Record<string, string>;
  address: string;
  instance: Instance;
  args: Record<string, string>;
  artifact: Artifact;
  fn: string;
  outpoints: string[];
  expiresAt: number;
  status: "active" | "done" | "expired" | "cancelled";
  attempts: Attempt[];
}

export interface FakeNetworkOptions {
  batchLifetimeSeconds?: number;
  exitDelaySeconds?: number;
  /** Sats a renewal pays to the Operator. */
  renewalFeeSats?: number;
  /** Watches run on their own every this many ms; 0 leaves it to `tick()`. */
  tickMs?: number;
}

/** The rest of an Operator's `/v1/info`, as Mutinynet answers it: what the swap client reads. */
const INFO_SHAPE = (mutinynetInfo as { body: Record<string, unknown> }).body;

/** A serialized witness stack: the item count, then each item with its length. */
function decodeWitnessItems(raw: Uint8Array): Uint8Array[] {
  let at = 0;
  const size = () => {
    const first = raw[at++]!;
    if (first < 0xfd) return first;
    const n = first === 0xfd ? 2 : 4;
    let v = 0;
    for (let i = 0; i < n; i++) v += raw[at++]! * 2 ** (8 * i);
    return v;
  };
  const items: Uint8Array[] = [];
  for (let count = size(); count > 0; count--) {
    const len = size();
    items.push(raw.slice(at, at + len));
    at += len;
  }
  return items;
}

const secret = () => schnorr.utils.randomSecretKey();
const compressed = (s: Uint8Array) => hex(secp256k1.getPublicKey(s, true));
const now = () => Math.floor(Date.now() / 1000);

export class FakeNetwork {
  readonly serverKey = compressed(secret());
  readonly forfeitKey = compressed(secret());
  readonly emulatorKey = compressed(secret());
  readonly delegateKey = compressed(secret());
  readonly checkpointTapscript: string;
  readonly exitDelaySeconds: number;
  readonly batchLifetimeSeconds: number;
  renewalFeeSats: number;
  /** Refuse every spend with this error, as an Emulator refusing the covenant would. */
  refuseSpends?: string;
  /** The Emulator answers 503 to every submission, as an unreachable one would behind a gateway. */
  emulatorUnavailable = false;
  /** Transactions the Emulator finalized, by txid, and every submission it answered. */
  readonly emulatorSubmissions: { txid: string; accepted: boolean }[] = [];
  readonly covenantRejections: ModelRejection[] = [];
  readonly coins = new Map<string, FakeCoin>();
  /** Ark transactions built outside the fake, by txid: what the indexer returns for them. */
  private readonly virtualTxs = new Map<string, string>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly templates = new Map<string, Record<string, unknown>>();
  /** Templates the delegatee stopped acting on, as it does after ten fully refused cycles. */
  readonly disabledTemplates = new Set<string>();
  readonly delegations: Delegation[] = [];
  private servers: Server[] = [];
  private timer?: NodeJS.Timeout;
  private pausedTicks = 0;
  arkdUrl = "";
  delegateeUrl = "";
  emulatorUrl = "";

  constructor(private readonly options: FakeNetworkOptions = {}) {
    this.exitDelaySeconds = options.exitDelaySeconds ?? 1024;
    this.batchLifetimeSeconds = options.batchLifetimeSeconds ?? 8192;
    this.renewalFeeSats = options.renewalFeeSats ?? 0;
    const delay = hex(scriptNum(sequence(1536)));
    const forfeit = xOnly(this.forfeitKey);
    this.checkpointTapscript = `${hex(Uint8Array.of(delay.length / 2))}${delay}b27520${hex(forfeit)}ac`;
  }

  get keys() {
    return { server: this.serverKey, emulator: this.emulatorKey, delegate: this.delegateKey };
  }

  deployment(): Deployment {
    return {
      network: "regtest",
      arkdUrl: this.arkdUrl,
      delegateeUrl: this.delegateeUrl,
      emulatorUrl: this.emulatorUrl,
    };
  }

  async start(): Promise<this> {
    const arkd = createServer((req, res) => this.route(req, res, "arkd"));
    const delegatee = createServer((req, res) => this.route(req, res, "delegatee"));
    const emulator = createServer((req, res) => this.route(req, res, "emulator"));
    this.servers = [arkd, delegatee, emulator];
    this.arkdUrl = (await listenLocal(arkd)).url;
    this.delegateeUrl = (await listenLocal(delegatee)).url;
    this.emulatorUrl = (await listenLocal(emulator)).url;
    if (this.options.tickMs) this.timer = setInterval(() => this.tick(), this.options.tickMs);
    return this;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.servers.map(closeServer));
  }

  /**
   * A payment from outside into `script`, as a fresh offchain coin at output 0.
   * With `source`, the coin is that transaction's output and the indexer
   * returns its PSBT, as for an arrival whose shape the hive classifies.
   */
  mint(
    script: string,
    amount: number,
    options: { expiresInSeconds?: number; source?: { txid: string; psbt: string } } = {},
  ): FakeCoin {
    // A bare mint still gets a creating transaction the indexer serves, as the Emulator reads it.
    const source = options.source ?? this.creator(script, amount);
    const txid = source.txid;
    this.virtualTxs.set(txid, source.psbt);
    // An arrival through someone's Ark transaction is preconfirmed; a bare mint stands for a batch output.
    return this.coin(txid, 0, amount, script, options.expiresInSeconds, undefined, Boolean(options.source));
  }

  private creator(script: string, amount: number): { txid: string; psbt: string } {
    const tx = new SdkTransaction({ version: 3, allowUnknownOutputs: true });
    tx.addInput({ txid: randomBytes(32), index: 0 });
    tx.addOutput({ script: Buffer.from(script, "hex"), amount: BigInt(amount) });
    return { txid: tx.id, psbt: Buffer.from(tx.toPSBT()).toString("base64") };
  }

  /** Make a transaction known to the indexer, such as the checkpoint an arrival spends. */
  remember(txid: string, psbt: string): void {
    this.virtualTxs.set(txid, psbt);
  }

  /**
   * Spend a coin with a transaction built outside the fake, as another
   * party's covenant spend would: the indexer then returns its PSBT.
   */
  spendWith(
    outpoint: string,
    spend: { psbt: string; txid: string; checkpointTxid: string },
    outputs: { script: string; amount: number }[],
  ): void {
    const coin = this.coins.get(outpoint);
    if (!coin || coin.isSpent) throw new Error("coin unknown or spent");
    coin.isSpent = true;
    coin.spentBy = spend.checkpointTxid;
    coin.arkTxid = spend.txid;
    this.virtualTxs.set(spend.txid, spend.psbt);
    outputs.forEach((o, vout) => {
      this.coin(spend.txid, vout, o.amount, o.script, coin.expiresAt - now(), coin.commitmentTxids[0], true);
    });
  }

  balance(script: string): number {
    return [...this.coins.values()]
      .filter((c) => c.script === script && !c.isSpent)
      .reduce((n, c) => n + c.amount, 0);
  }

  unspent(script: string): FakeCoin[] {
    return [...this.coins.values()].filter((c) => c.script === script && !c.isSpent);
  }

  private coin(
    txid: string,
    vout: number,
    amount: number,
    script: string,
    lifetime?: number,
    commitment?: string,
    preconfirmed = false,
  ): FakeCoin {
    const coin: FakeCoin = {
      txid,
      vout,
      amount,
      script,
      createdAt: now(),
      expiresAt: now() + (lifetime ?? this.batchLifetimeSeconds),
      isSpent: false,
      spentBy: "",
      settledBy: "",
      arkTxid: "",
      commitmentTxids: commitment ? [commitment] : [hex(randomBytes(32))],
      isPreconfirmed: preconfirmed,
    };
    this.coins.set(`${txid}:${vout}`, coin);
    return coin;
  }

  // ------------------------------------------------------------ HTTP

  private async route(req: IncomingMessage, res: ServerResponse, side: "arkd" | "delegatee" | "emulator") {
    // Each fixture request gets its own connection, avoiding idle pooled sockets during slow tests.
    res.setHeader("connection", "close");
    try {
      const url = new URL(req.url ?? "/", "http://fake");
      const body =
        req.method === "POST" ? ((await readJsonBody(req, 1 << 20)) as Record<string, unknown>) : {};
      if (side === "emulator") {
        if (this.emulatorUnavailable) return sendJson(res, 503, { message: "unavailable" });
        try {
          return sendJson(res, 200, this.emulator(url, body));
        } catch (error) {
          // The Emulator answers a refused script with a generic internal error.
          return sendJson(res, 500, { message: error instanceof Error ? error.message : String(error) });
        }
      }
      sendJson(res, 200, side === "arkd" ? this.arkd(url) : this.delegatee(url, body));
    } catch (error) {
      sendJson(res, 400, { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The Emulator's `/v1/tx`: read each input's covenant and witness from the
   * extension, check them by the same rules the delegatee side applies, check
   * the transaction's outputs are the ones those rules produce, then sign as
   * the Emulator and the Operator and apply it under its own txid.
   */
  private emulator(url: URL, body: Record<string, unknown>): unknown {
    if (url.pathname === "/v1/info") return { signerPubkey: this.emulatorKey };
    if (url.pathname !== "/v1/tx") throw new Error(`no route ${url.pathname}`);
    const tx = SdkTransaction.fromPSBT(Buffer.from(String(body.arkTx), "base64"), {
      allowUnknown: true,
      allowUnknownOutputs: true,
    });
    const txid = tx.id;
    const observedOutpoints: string[] = [];
    try {
      if (this.refuseSpends) throw new Error(this.refuseSpends);
      const entries = Extension.fromTx(tx).getEmulatorPacket()?.entries ?? [];
      // Ark input i spends checkpoint i, which spends the coin.
      const checkpoints = (body.checkpointTxs as string[]).map((c) =>
        SdkTransaction.fromPSBT(Buffer.from(c, "base64"), { allowUnknown: true, allowUnknownOutputs: true }),
      );
      if (checkpoints.length !== tx.inputsLength) throw new Error("one checkpoint per input");
      const inputs: FakeCoin[] = [];
      for (let i = 0; i < tx.inputsLength; i++) {
        if (hex(tx.getInput(i).txid!) !== checkpoints[i]!.id)
          throw new Error("input does not spend its checkpoint");
        const input = checkpoints[i]!.getInput(0);
        const coin = this.coins.get(`${hex(input.txid!)}:${input.index}`);
        if (!coin || coin.isSpent) throw new Error("coin unknown or spent");
        inputs.push(coin);
        observedOutpoints.push(`${coin.txid}:${coin.vout}`);
      }
      const results = entries.map((entry) => {
        const coin = inputs[entry.vin]!;
        const watch = this.delegations.find((d) => d.kind === "watch" && d.instance.pkScript === coin.script);
        if (!watch) throw new Error("no contract known for the coin");
        const fn = Object.entries(watch.instance.covenants).find(
          ([, script]) => hex(script) === hex(entry.script),
        )?.[0];
        if (!fn) throw new Error("the covenant is not the contract's");
        const args = decodeWitnessItems(entry.witness ?? new Uint8Array([0]))
          .reverse()
          .map(hex);
        const variables: Record<string, string> = fn.startsWith("send")
          ? { valid_until: args[0]!, amount: args[1]!, change: args[2]!, sig_0: args[3]!, dest: "" }
          : fn === "claim"
            ? { amount: args[0]!, receipt_sig: args[1]!, claim_sig: args[2]! }
            : {};
        return { coin, d: { ...watch, fn, variables } as Delegation };
      });
      if (results.length !== inputs.length) throw new Error("an input has no covenant");
      const outputs: { script: string; amount: number }[] = [];
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        const script = hex(o.script!);
        if (Extension.isExtension(o.script!) || script === "51024e73") continue;
        outputs.push({ script, amount: Number(o.amount) });
      }
      const first = results[0]!;
      if (
        results.some(
          (r) =>
            r.d.fn !== first.d.fn ||
            JSON.stringify({ ...r.d.variables, sig_0: "" }) !==
              JSON.stringify({ ...first.d.variables, sig_0: "" }),
        )
      )
        throw new Error("the inputs' covenants disagree");
      const expected = first.d.fn.startsWith("send")
        ? this.sendOutputs(
            { ...first.d, variables: { ...first.d.variables, dest: outputs.at(-1)!.script } },
            inputs,
            results.map((r) => r.d.variables.sig_0!),
          )
        : first.d.fn === "claim"
          ? this.claimOutputs(first.d, first.coin)
          : this.refundOutputs(first.d, first.coin);
      if (JSON.stringify(expected) !== JSON.stringify(outputs))
        throw new Error("the outputs are not the covenant's");
      this.transact(
        inputs,
        outputs,
        txid,
        checkpoints.map((checkpoint) => checkpoint.id),
      );
      this.virtualTxs.set(txid, String(body.arkTx));
      this.emulatorSubmissions.push({ txid, accepted: true });
    } catch (error) {
      this.emulatorSubmissions.push({ txid, accepted: false });
      if (error instanceof ModelSignatureRejection)
        this.covenantRejections.push({
          source: "offline-model",
          route: "self",
          actionId: txid,
          outpoints: observedOutpoints,
          at: Date.now(),
          vin: error.vin,
          reason: "signature-verification",
        });
      throw error;
    }
    const sign = (psbt: string) => {
      const t = SdkTransaction.fromPSBT(Buffer.from(psbt, "base64"), {
        allowUnknown: true,
        allowUnknownOutputs: true,
      });
      for (let i = 0; i < t.inputsLength; i++) {
        const leaf = t.getInput(i).tapLeafScript?.[0];
        if (!leaf) continue;
        const leafHash = tapLeafHash(leaf[1].subarray(0, -1), leaf[1].at(-1)!);
        t.updateInput(i, {
          tapScriptSig: [this.serverKey, this.emulatorKey].map((k) => [
            { pubKey: xOnly(k), leafHash },
            randomBytes(64),
          ]),
        });
      }
      return Buffer.from(t.toPSBT()).toString("base64");
    };
    return {
      signedArkTx: sign(String(body.arkTx)),
      signedCheckpointTxs: (body.checkpointTxs as string[]).map(sign),
    };
  }

  private arkd(url: URL): unknown {
    if (url.pathname === "/v1/info")
      return {
        ...INFO_SHAPE,
        network: "regtest",
        signerPubkey: this.serverKey,
        forfeitPubkey: this.forfeitKey,
        checkpointTapscript: this.checkpointTapscript,
        unilateralExitDelay: String(this.exitDelaySeconds),
        boardingExitDelay: String(this.exitDelaySeconds * 2),
        dust: "330",
      };
    if (url.pathname.startsWith("/v1/indexer/virtualTx/")) {
      const ids = url.pathname.slice("/v1/indexer/virtualTx/".length).split(",");
      return { txs: ids.flatMap((id) => (this.virtualTxs.has(id) ? [this.virtualTxs.get(id)!] : [])) };
    }
    if (url.pathname === "/v1/indexer/vtxos") {
      const scripts = url.searchParams.getAll("scripts");
      const outpoints = url.searchParams.getAll("outpoints");
      const spendable = url.searchParams.get("spendableOnly") === "true";
      const all = [...this.coins.values()].filter(
        (c) =>
          (scripts.length ? scripts.includes(c.script) : outpoints.includes(`${c.txid}:${c.vout}`)) &&
          (!spendable || !c.isSpent),
      );
      const size = Number(url.searchParams.get("page.size") ?? 100);
      const index = Math.max(1, Number(url.searchParams.get("page.index") ?? 1));
      const total = Math.max(1, Math.ceil(all.length / size));
      return {
        vtxos: all.slice((index - 1) * size, index * size).map((c) => ({
          outpoint: { txid: c.txid, vout: c.vout },
          amount: String(c.amount),
          script: c.script,
          createdAt: String(c.createdAt),
          expiresAt: String(c.expiresAt),
          isSpent: c.isSpent,
          isSwept: false,
          isPreconfirmed: c.isPreconfirmed,
          spentBy: c.spentBy,
          settledBy: c.settledBy,
          arkTxid: c.arkTxid,
          commitmentTxids: c.commitmentTxids,
        })),
        page: { current: index, next: Math.min(index + 1, total), total },
      };
    }
    throw new Error(`no route ${url.pathname}`);
  }

  private delegatee(url: URL, body: Record<string, unknown>): unknown {
    const path = url.pathname;
    if (path === "/v1/info")
      return {
        network: "regtest",
        delegatePubkey: this.delegateKey,
        serverPubkey: this.serverKey,
        emulatorPubkey: this.emulatorKey,
      };
    if (path === "/v1/artifact") {
      const doc = JSON.parse(String(body.document)) as Artifact;
      const id = sha256Hex(JSON.stringify(doc));
      this.artifacts.set(id, doc);
      return { artifact: { id } };
    }
    if (path === "/v1/template") {
      const doc = JSON.parse(String(body.document)) as Record<string, unknown>;
      const id = sha256Hex(JSON.stringify(doc));
      this.templates.set(id, doc);
      return { template: { id } };
    }
    if (path === "/v1/delegate") return { delegation: this.view(this.watch(body)) };
    if (path === "/v1/spend") {
      const d = this.spend(body);
      return { id: d.fingerprint, delegation: this.view(d) };
    }
    if (path.startsWith("/v1/template/")) {
      const id = path.slice("/v1/template/".length);
      if (!this.templates.has(id)) throw new Error("template not found");
      return { template: { id, status: this.disabledTemplates.has(id) ? "disabled" : "active" } };
    }
    if (path.startsWith("/v1/delegate/")) {
      const address = decodeURIComponent(path.slice("/v1/delegate/".length));
      const d = [...this.delegations]
        .reverse()
        .find((x) => x.address === address && x.kind === "watch" && x.status === "active");
      if (!d) throw new Error("delegation not found");
      return this.state(d);
    }
    if (path.startsWith("/v1/spend/")) {
      const id = path.slice("/v1/spend/".length);
      const d = [...this.delegations].reverse().find((x) => x.fingerprint === id && x.kind === "spend");
      if (!d) throw new Error("spend not found");
      this.expire(d);
      return this.state(d);
    }
    throw new Error(`no route ${path}`);
  }

  private view(d: Delegation) {
    return {
      id: d.id,
      address: d.kind === "watch" ? d.address : "",
      status: d.status,
      templateId: d.templateId,
      expiresAt: String(d.expiresAt),
      slots: [{ name: "in0", tapscripts: d.instance.tapscripts, outpoint: d.outpoints[0] ?? "" }],
    };
  }

  private state(d: Delegation) {
    const coins = d.kind === "watch" ? this.unspent(d.instance.pkScript) : [];
    return {
      delegation: this.view(d),
      vtxos: coins.map((c) => ({
        outpoint: `${c.txid}:${c.vout}`,
        amount: String(c.amount),
        expiresAt: String(c.expiresAt),
      })),
      renewals: d.attempts.slice(-50).reverse(),
    };
  }

  // ------------------------------------------------------------ templates

  private bind(binding: unknown, variables: Record<string, string>): string {
    if (typeof binding === "number") return hex(scriptNum(binding));
    if (typeof binding === "boolean") return binding ? "01" : "";
    return String(binding).replace(/<([a-z0-9_]+)>/g, (_, name: string) => {
      const value = variables[name];
      if (value === undefined) throw new Error(`variable ${name} missing`);
      return value;
    });
  }

  private resolve(templateId: string, variables: Record<string, string>, inputIndex = 0) {
    const doc = this.templates.get(templateId);
    if (!doc) throw new Error("unknown template");
    const inputs = doc.inputs as {
      contract: { definition: { artifact: string }; arguments: Record<string, unknown> };
      spend: { function: string; arguments?: string[] };
    }[];
    const input = inputs[inputIndex]!;
    const artifact = this.artifacts.get(input.contract.definition.artifact);
    if (!artifact) throw new Error("unknown artifact");
    const args = Object.fromEntries(
      Object.entries(input.contract.arguments).map(([k, v]) => [k, this.bind(v, variables)]),
    );
    const instance = instantiate(artifact, args, this.keys);
    return { doc, inputs, artifact, args, instance, fn: input.spend.function };
  }

  private watch(body: Record<string, unknown>): Delegation {
    const templateId = String(body.templateId);
    const variables = (body.variables ?? {}) as Record<string, string>;
    const fingerprint = spendFingerprint(templateId, variables, []);
    const existing = this.delegations.find((d) => d.fingerprint === fingerprint && d.status === "active");
    if (existing) return existing;
    const r = this.resolve(templateId, variables);
    const d: Delegation = {
      id: String(this.delegations.length + 1),
      kind: "watch",
      fingerprint,
      templateId,
      variables,
      address: arkAddress("regtest", this.serverKey, r.instance.pkScript),
      instance: r.instance,
      args: r.args,
      artifact: r.artifact,
      fn: r.fn,
      outpoints: [],
      expiresAt: Number(body.expiresAt ?? 0),
      status: "active",
      attempts: [],
    };
    this.delegations.push(d);
    return d;
  }

  private spend(body: Record<string, unknown>): Delegation {
    const templateId = String(body.templateId);
    const variables = body.variables as Record<string, string>;
    const outpoints = body.outpoints as string[];
    const expiresAt = Number(body.expiresAt);
    if (!(expiresAt > now() && expiresAt <= now() + 86_400)) throw new Error("expires_at out of range");
    const fingerprint = spendFingerprint(templateId, variables, outpoints);
    const existing = this.delegations.find((d) => d.fingerprint === fingerprint && d.status === "active");
    if (existing) return existing;
    if (
      !schnorr.verify(
        unhex(String(body.signature)),
        spendRequestMessage(fingerprint, expiresAt),
        unhex(String(body.pubkey)),
      )
    )
      throw new Error("bad signature");
    const r = this.resolve(templateId, variables);
    const exitKeys = r.instance.tapscripts
      .filter((t) => /^.{2,8}b27520[0-9a-f]{64}ac$/.test(t))
      .map((t) => t.slice(-66, -2));
    if (!exitKeys.includes(String(body.pubkey)))
      throw new Error("pubkey is not the key of an exit leaf of every slot");
    for (const op of outpoints)
      if (
        this.delegations.some((d) => d.kind === "spend" && d.status === "active" && d.outpoints.includes(op))
      )
        throw new Error("outpoint already bound");
    const d: Delegation = {
      id: String(this.delegations.length + 1),
      kind: "spend",
      fingerprint,
      templateId,
      variables,
      address: "",
      instance: r.instance,
      args: r.args,
      artifact: r.artifact,
      fn: r.fn,
      outpoints,
      expiresAt,
      status: "active",
      attempts: [],
    };
    this.delegations.push(d);
    this.attempt(d);
    return d;
  }

  private expire(d: Delegation) {
    if (d.status === "active" && d.expiresAt && d.expiresAt <= now()) d.status = "expired";
  }

  private record(d: Delegation, outpoints: string[], result: { txid?: string; error?: string }) {
    const last = d.attempts[d.attempts.length - 1];
    if (result.error && last && !last.success && last.error === result.error) return;
    d.attempts.push({
      outpoints,
      commitmentTxid: result.txid ?? "",
      success: !result.error,
      error: result.error ?? "",
      attemptedAt: now(),
    });
  }

  /** One Ark transaction: spend `inputs`, create `outputs`. */
  private transact(
    inputs: FakeCoin[],
    outputs: { script: string; amount: number }[],
    txid: string = hex(randomBytes(32)),
    checkpointTxids?: string[],
  ): string {
    for (const [index, coin] of inputs.entries()) {
      coin.isSpent = true;
      coin.spentBy = checkpointTxids?.[index] ?? hex(randomBytes(32));
      coin.arkTxid = txid;
    }
    const lifetime = Math.min(...inputs.map((c) => c.expiresAt)) - now();
    outputs.forEach((o, vout) => {
      this.coin(txid, vout, o.amount, o.script, lifetime, inputs[0]!.commitmentTxids[0], true);
    });
    return txid;
  }

  private attempt(d: Delegation) {
    if (d.status !== "active") return;
    const coins = d.outpoints.map((op) => this.coins.get(op));
    try {
      if (this.refuseSpends) throw new Error(this.refuseSpends);
      if (coins.some((c) => !c || c.isSpent)) {
        d.status = "done";
        return;
      }
      const inputs = coins as FakeCoin[];
      if (inputs.some((c) => c.script !== d.instance.pkScript))
        throw new Error("coin script differs from the contract");
      const txid =
        d.fn === "claim"
          ? this.claim(d, inputs[0]!)
          : d.fn === "refund"
            ? this.refund(d, inputs[0]!)
            : this.send(d, inputs);
      this.record(d, d.outpoints, { txid });
      d.status = "done";
    } catch (error) {
      if (error instanceof ModelSignatureRejection)
        this.covenantRejections.push({
          source: "offline-model",
          route: "delegatee",
          actionId: d.fingerprint,
          outpoints: [...d.outpoints],
          at: Date.now(),
          vin: error.vin,
          reason: "signature-verification",
        });
      this.record(d, d.outpoints, {
        error: `emulator: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private send(d: Delegation, inputs: FakeCoin[]): string {
    const sigs = inputs.map((_, i) => d.variables[`sig_${i}`]!);
    const outputs = this.sendOutputs(d, inputs, sigs);
    const v = d.variables;
    const spend = sendSpend(
      {
        account: d.fn === "send" ? "wallet" : "treasury",
        ...(d.fn === "send" ? {} : { pair: d.fn.slice(4) as "01" | "02" | "12" }),
        coins: inputs.map((c) => ({ txid: c.txid, vout: c.vout, amount: c.amount, script: c.script })),
        amount: Number(decodeScriptNum(unhex(v.amount!))),
        change: Number(decodeScriptNum(unhex(v.change!))),
        validUntil: Number(decodeScriptNum(unhex(v.valid_until!))),
        destination: v.dest!,
        templateId: d.templateId,
        variables: v,
      },
      d.instance,
      sigs,
    );
    return this.transactSpend(inputs, outputs, spend);
  }

  /** The transaction and checkpoint links the real delegatee builds for this spend. */
  private transactSpend(
    inputs: FakeCoin[],
    outputs: { script: string; amount: number }[],
    spend: CovenantSpend,
  ): string {
    const built = buildSpend(spend, this.checkpointTapscript);
    return this.transact(
      inputs,
      outputs,
      built.txid,
      built.checkpoints.map((checkpoint) => checkpoint.id),
    );
  }

  /** The send covenant: each coin's attestation, then exactly the payment and the change. */
  private sendOutputs(
    d: Delegation,
    inputs: FakeCoin[],
    sigs: string[],
  ): { script: string; amount: number }[] {
    const v = d.variables;
    const amount = Number(decodeScriptNum(unhex(v.amount!)));
    const change = Number(decodeScriptNum(unhex(v.change!)));
    const validUntil = Number(decodeScriptNum(unhex(v.valid_until!)));
    const dest = v.dest!;
    if (validUntil <= now()) throw new Error("authorization expired");
    const total = inputs.reduce((n, c) => n + c.amount, 0);
    const owner = d.fn === "send" ? hex(xOnly(d.args.owner!)) : d.args[`pair${d.fn.slice(4)}`]!;
    const tag = d.fn === "send" ? WALLET_SEND_TAG : TREASURY_SEND_TAG;
    const leaf = leafOf(d.instance, d.fn);
    inputs.forEach((coin, i) => {
      const msg = sendMessage(
        tag,
        { txid: checkpointTxid(coin, leaf, this.checkpointTapscript), vout: 0 },
        { amount, change, validUntil, destination: dest },
      );
      if (!schnorr.verify(unhex(sigs[i]!), msg, unhex(owner))) throw new ModelSignatureRejection(i);
    });
    if (change > 0 && total - amount < change) throw new Error("change underpaid");
    if (change === 0 && total < amount) throw new Error("payment underpaid");
    return change > 0
      ? [
          { script: d.instance.pkScript, amount: total - amount },
          { script: dest, amount },
        ]
      : [{ script: dest, amount: total }];
  }

  private claim(d: Delegation, coin: FakeCoin): string {
    const outputs = this.claimOutputs(d, coin);
    const v = d.variables;
    const spend = claimSpend(
      {
        escrow: {
          providerProgram: d.args.providerProgram!,
          treasuryProgram: d.args.treasuryProgram!,
        } as never,
        coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
        amount: Number(decodeScriptNum(unhex(v.amount!))),
        receiptSig: v.receipt_sig!,
        claimSig: v.claim_sig!,
        templateId: d.templateId,
        expiresAt: d.expiresAt,
      },
      d.instance,
    );
    return this.transactSpend([coin], outputs, spend);
  }

  /** The claim covenant: both signatures over the amount, before the deadline. */
  private claimOutputs(d: Delegation, coin: FakeCoin): { script: string; amount: number }[] {
    const v = d.variables;
    const amount = Number(decodeScriptNum(unhex(v.amount!)));
    const timeoutAt = Number(decodeScriptNum(unhex(d.args.timeoutAt!)));
    if (now() >= timeoutAt) throw new Error("claim window closed");
    if (!(amount > 0 && amount <= coin.amount)) throw new Error("amount");
    if (
      !schnorr.verify(unhex(v.receipt_sig!), receiptMessage(d.args.escrowId!, amount), unhex(d.args.payer!))
    )
      throw new ModelSignatureRejection(0);
    if (!schnorr.verify(unhex(v.claim_sig!), claimMessage(d.args.escrowId!, amount), unhex(d.args.provider!)))
      throw new ModelSignatureRejection(0);
    const remainder = coin.amount - amount;
    return remainder > 330
      ? [
          { script: `5120${d.args.providerProgram}`, amount },
          { script: `5120${d.args.treasuryProgram}`, amount: remainder },
        ]
      : [{ script: `5120${d.args.providerProgram}`, amount: coin.amount }];
  }

  private refund(d: Delegation, coin: FakeCoin): string {
    const outputs = this.refundOutputs(d, coin);
    const spend = refundSpend(
      {
        escrow: { treasuryProgram: d.args.treasuryProgram! } as never,
        coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
        templateId: d.templateId,
        expiresAt: d.expiresAt,
      },
      d.instance,
    );
    return this.transactSpend([coin], outputs, spend);
  }

  /** The refund covenant: the whole coin back to the treasury, from the deadline. */
  private refundOutputs(d: Delegation, coin: FakeCoin): { script: string; amount: number }[] {
    const timeoutAt = Number(decodeScriptNum(unhex(d.args.timeoutAt!)));
    if (now() < timeoutAt) throw new Error("time lock not reached");
    return [{ script: `5120${d.args.treasuryProgram}`, amount: coin.amount }];
  }

  /** Keep a fixture's initial snapshot atomic with respect to background watches. */
  pauseTicks(): () => void {
    this.pausedTicks++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pausedTicks--;
    };
  }

  /**
   * Watches act: renewals inside their window, refunds from their deadline.
   * As in the delegatee, only the oldest active watch on a script acts; later
   * ones share it and do nothing. Spends not yet done are tried again.
   */
  tick(): void {
    if (this.pausedTicks) return;
    for (const d of this.delegations) this.expire(d);
    for (const d of this.delegations.filter((x) => x.kind === "spend" && x.status === "active"))
      this.attempt(d);
    const acting = new Map<string, Delegation>();
    for (const d of this.delegations)
      if (d.kind === "watch" && d.status === "active" && !acting.has(d.instance.pkScript))
        acting.set(d.instance.pkScript, d);
    for (const d of acting.values()) {
      if (this.disabledTemplates.has(d.templateId)) continue;
      for (const coin of this.unspent(d.instance.pkScript)) {
        const op = `${coin.txid}:${coin.vout}`;
        if (d.fn === "renew") {
          const window = Number(decodeScriptNum(unhex(d.args.renewalWindow!)));
          const maxFee = Number(decodeScriptNum(unhex(d.args.maxFee!)));
          if (coin.expiresAt - now() > window) continue;
          if (this.renewalFeeSats > maxFee) {
            this.record(d, [op], { error: "fee above the renew leaf's limit" });
            continue;
          }
          const commitment = hex(randomBytes(32));
          coin.isSpent = true;
          coin.settledBy = commitment;
          this.coin(
            hex(randomBytes(32)),
            0,
            coin.amount - this.renewalFeeSats,
            coin.script,
            undefined,
            commitment,
          );
          this.record(d, [op], { txid: commitment });
        } else if (d.fn === "refund") {
          const timeoutAt = Number(decodeScriptNum(unhex(d.args.timeoutAt!)));
          if (now() < timeoutAt) continue;
          if (this.refuseSpends) {
            this.record(d, [op], { error: this.refuseSpends });
            continue;
          }
          // The watch builds the refund the refund template names: the same transaction anyone would.
          const txid = this.refund(d, coin);
          this.record(d, [op], { txid });
        }
      }
    }
  }

  /** Watches registered for `address`, oldest first. */
  watchesOf(address: string): Delegation[] {
    return this.delegations.filter((d) => d.kind === "watch" && d.address === address);
  }
}

export async function startFakeNetwork(options?: FakeNetworkOptions): Promise<FakeNetwork> {
  return new FakeNetwork(options).start();
}
