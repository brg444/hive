import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { arkAddress, type Connection, type IndexedCoin, jobEscrow, type Network } from "@hive/ark";
import type { TreasuryContract } from "@hive/executor";
import { hex, localPath } from "@hive/kit";
import { approvalText, type BuzzEvent, buzzApproval, counterOf, type Payment, sha256 } from "@hive/treasury";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { ApprovalDesk, type ApprovalDeskOptions, type KeeperPayment } from "../../tools/approvals-desk.js";
import { type HiveRecord, opsPaths } from "../../tools/ops.js";

/**
 * A v5 hive's approvals desk over a stand-in for the treasury: its coins, its spends and the
 * Operator's index of them, in memory. The stand-in accepts any spend, as an outsider's too, so a
 * test says what the covenant would accept; what the covenant itself accepts is the regtest test's
 * to show (`test/treasury-v5-regtest.ts`).
 */
export const SUPPLY = 1_000_000n;
export const CHANNEL = "4f1c2e0a-0000-4000-8000-000000000000";
export const point = () => hex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const xonly = () => hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A member's Buzz identity: it signs channel messages as Buzz's outbox builds them. */
export function member() {
  const secret = schnorr.utils.randomSecretKey();
  const key = hex(schnorr.getPublicKey(secret));
  let n = 0;
  const event = (kind: number, tags: string[][], content: string, at: number): BuzzEvent => {
    const id = hex(sha256(utf8(JSON.stringify([0, key, at, kind, tags, content]))));
    return {
      id,
      pubkey: key,
      created_at: at,
      kind,
      tags,
      content,
      sig: hex(schnorr.sign(Buffer.from(id, "hex"), secret)),
    };
  };
  return {
    key,
    message: (content: string, at: number) =>
      event(
        9,
        [
          ["h", CHANNEL],
          ["client-id", `c${n++}`],
          ["ms", "417"],
        ],
        content,
        at,
      ),
    /** The member deletes one of their messages, as Buzz does: a kind 5 naming it. */
    removal: (id: string, at: number) =>
      event(
        5,
        [
          ["h", CHANNEL],
          ["e", id],
        ],
        "",
        at,
      ),
  };
}
export type Member = ReturnType<typeof member>;

export type Coin = {
  txid: string;
  vout: number;
  value: number;
  assets?: { assetId: string; amount: number }[];
};

const SCRIPT = "00".repeat(34);
const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`;

/** The treasury contract's coins and spends, and the indexer's record of them. */
export function fakeTreasury(assetId: string, coins: Coin[], clock: { now: number }) {
  const sent: { fn: string; args: unknown[] }[] = [];
  const index = new Map<string, IndexedCoin>();
  const record = (txid: string, vout: number, amount: number, script: string) =>
    index.set(`${txid}:${vout}`, {
      txid,
      vout,
      amount,
      script,
      createdAt: clock.now,
      expiresAt: null,
      isSpent: false,
      isSwept: false,
      isPreconfirmed: true,
      spentBy: "",
      settledBy: "",
      arkTxid: "",
      commitmentTxids: [],
    });
  for (const c of coins) record(c.txid, c.vout, c.value, SCRIPT);
  let fail: string | null = null;
  let lostAnswer = false;
  let indexerDown = false;
  let before: null | (() => void) = null;
  const newTxid = () => hex(randomBytes(32));
  const spend = (from: Coin[], txid: string) => {
    for (const c of from) {
      coins.splice(coins.indexOf(c), 1);
      const kept = index.get(outpoint(c));
      if (kept) Object.assign(kept, { isSpent: true, arkTxid: txid, spentBy: txid });
    }
  };
  const treasuryCoin = () => coins.find((c) => (c.assets?.[0]?.amount ?? 0) > 0)!;
  /** A payment as the covenant would carry it out, whoever submits it. */
  const pay = (from: Coin, amount: number, program: Uint8Array) => {
    const txid = newTxid();
    const units = from.assets?.[0]?.amount ?? 0;
    spend([from], txid);
    coins.push({ txid, vout: 0, value: from.value - amount, assets: [{ assetId, amount: units - 1 }] });
    record(txid, 0, from.value - amount, SCRIPT);
    record(txid, 1, amount, `5120${hex(program)}`);
    return txid;
  };
  const merge = (into: Coin, other: Coin) => {
    const txid = newTxid();
    const units = into.assets?.[0]?.amount ?? 0;
    spend([into, other], txid);
    coins.push({ txid, vout: 0, value: into.value + other.value, assets: [{ assetId, amount: units }] });
    record(txid, 0, into.value + other.value, SCRIPT);
    return txid;
  };
  const builder = (fn: string, args: unknown[]) => {
    let from: Coin[] = [];
    const b = {
      from(c: Coin | Coin[]) {
        from = Array.isArray(c) ? c : [c];
        return b;
      },
      to: () => b,
      withAsset: () => b,
      async send() {
        if (before) {
          const hit = before;
          before = null;
          hit();
        }
        if (fail) throw new Error(fail);
        if (from.some((c) => !coins.includes(c))) throw new Error("VTXO_ALREADY_SPENT");
        sent.push({ fn, args });
        const txid =
          fn === "merge"
            ? merge(from[0]!, from[1]!)
            : pay(from[0]!, Number(args[0]), (args[1] as { program: Uint8Array }).program);
        if (lostAnswer) {
          lostAnswer = false;
          throw new Error("socket hang up");
        }
        return { txid };
      },
    };
    return b;
  };
  const contract = {
    pkScript: new Uint8Array(34),
    getUtxos: async () => coins,
    functions: {
      pay: (...args: unknown[]) => builder("pay", args),
      merge: (...args: unknown[]) => builder("merge", args),
    },
  } as unknown as TreasuryContract;
  const lookup: NonNullable<ApprovalDeskOptions["lookup"]> = async (query) => {
    if (indexerDown) throw new Error("indexer unreachable");
    return [...index.values()].filter(
      (c) => query.outpoints?.includes(outpoint(c)) || query.scripts?.includes(c.script),
    );
  };
  return {
    contract,
    lookup,
    sent,
    coins,
    treasuryCoin,
    /** The Emulator refuses every spend with this, the coins untouched; null lets spends through again. */
    failWith: (m: string | null) => (fail = m),
    /** The Emulator accepts the next spend, and its answer is lost on the way back. */
    loseAnswer: () => (lostAnswer = true),
    indexerDown: (down: boolean) => (indexerDown = down),
    /** Runs just before the desk's next spend reaches the Operator: what someone else got in first. */
    beforeNextSpend: (hit: () => void) => (before = hit),
    /** Someone other than the desk: a chip-in arriving, a merge anyone may submit, a payment on approvals read in the channel. */
    outsider: {
      chipIn(value: number) {
        const coin = { txid: newTxid(), vout: 0, value };
        coins.push(coin);
        record(coin.txid, 0, value, SCRIPT);
        return coin;
      },
      merge(value = 330) {
        return merge(treasuryCoin(), this.chipIn(value));
      },
      pay: (amount: number, program: string) => pay(treasuryCoin(), amount, Buffer.from(program, "hex")),
    },
  };
}

export function treasuryCoin(value: number, units = SUPPLY): Coin {
  return { txid: hex(randomBytes(32)), vout: 0, value, assets: [{ assetId: "", amount: Number(units) }] };
}

export function setup(
  coins: Coin[],
  options: { budgetSats?: number; network?: Network; patienceSeconds?: number } = {},
) {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const network = options.network ?? "regtest";
  const hive = `approvals-${randomUUID().slice(0, 8)}`;
  const keepers = [member(), member(), member()] as [Member, Member, Member];
  const counter = counterOf(`${hex(randomBytes(32))}0000`);
  const server = point();
  const conn = {
    deployment: { network },
    keys: { server, emulator: point(), delegate: point() },
    operator: { dust: 330, unilateralExitDelay: 512 },
    delegatee: { info: async () => ({}) },
  } as unknown as Connection;
  const treasuryScript = `5120${hex(randomBytes(32))}`;
  const record = {
    schema: "hive-ops-hive/v4",
    name: hive,
    network,
    deployment: { network, arkdUrl: "http://arkd", delegateeUrl: "http://delegatee" },
    stewardKeys: keepers.map((k) => `02${k.key}`),
    keepersHold: true,
    v5: {
      version: 5,
      keepers: keepers.map((k) => k.key),
      counter,
      supply: String(SUPPLY),
      delegateKey: conn.keys.delegate,
      renewalWindowSeconds: 600,
      maxFeeSats: 2000,
      exitDelaySeconds: 512,
      fundedTxid: "00".repeat(32),
    },
    treasury: { pairs: {}, exitDelaySeconds: 512, renewalWindowSeconds: 600, maxFeeSats: 2000 },
    treasuryScript,
    treasuryAddress: "tark1…",
  } as unknown as HiveRecord;
  const recordPath = opsPaths(hive).local("hive.json");
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
  for (const c of coins) if (c.assets) c.assets[0]!.assetId = counter.assetId;
  const fake = fakeTreasury(counter.assetId, coins, clock);
  const files = localPath("approvals-test", hive);
  mkdirSync(files, { recursive: true });
  const agentLog = `${files}/agent.jsonl`;
  const governance = `${files}/governance.json`;
  writeFileSync(
    governance,
    JSON.stringify({
      proposals: [
        { id: "p", title: "Work", budgetSats: options.budgetSats ?? 100_000, usedSats: 0, state: "running" },
      ],
    }),
  );
  writeFileSync(agentLog, "");
  const events = `${files}/events.json`;
  writeFileSync(events, "[]");
  const post = (e: BuzzEvent) => {
    writeFileSync(events, JSON.stringify([...JSON.parse(readFileSync(events, "utf8")), e]));
    return e;
  };
  /** A message in the hive's channel, as members' plugins forward it to the host; each a second apart. */
  const say = (who: Member, text: string) => post(who.message(text, ++clock.now));
  /** The author deletes a message of theirs. */
  const unsay = (who: Member, id: string) => post(who.removal(id, ++clock.now));
  /** An Arkade address on this hive's Operator, or another's. */
  const address = (key = server) => arkAddress(network, key, `5120${hex(randomBytes(32))}`);
  const job = (cap: number, deadline = clock.now + 7200) => {
    const jobId = hex(randomBytes(32));
    const params = {
      agentPk: xonly(),
      providerPk: xonly(),
      treasuryProgram: treasuryScript.slice(4),
      deadline,
      jobId,
    };
    const request = {
      job_id: jobId,
      address: jobEscrow(conn as never, params).address,
      cap_sats: cap,
      deadline,
      model: "m",
      provider_pk: params.providerPk,
      provider_peer: "peer",
      params,
    };
    writeFileSync(agentLog, `${JSON.stringify({ event: "funding_requested", at: clock.now, request })}\n`, {
      flag: "a",
    });
    return jobId;
  };
  const desk = new ApprovalDesk(hive, conn, fake.contract, {
    agentLog,
    governance,
    events,
    lookup: fake.lookup,
    now: () => clock.now,
    deadlineMarginSeconds: 60,
    minimumValiditySeconds: 60,
    ...(options.patienceSeconds !== undefined ? { patienceSeconds: options.patienceSeconds } : {}),
  });
  /** The keepers send the open payment's approval, as their plugins write it. */
  const approve = (id: string, ...who: Member[]) => {
    const p = desk.payment(id)!;
    return who.map((k) => say(k, desk.approval(p)));
  };
  /** The terms of a payment under a number, as an approval names them. */
  const terms = (p: KeeperPayment, left = BigInt(p.left ?? 0)): Payment => ({
    left,
    amount: BigInt(p.amountSats),
    validUntil: p.validUntil,
    program: p.program,
  });
  /** The approvals for a payment under a number that anyone reading the channel holds. */
  const inChannel = (p: KeeperPayment, left: bigint) => {
    const all = JSON.parse(readFileSync(events, "utf8")) as BuzzEvent[];
    const text = approvalText(counter, terms(p, left));
    return keepers.map((k) => {
      const e = all.find((x) => x.pubkey === k.key && x.kind === 9 && x.content === text);
      return e ? buzzApproval(k.key, counter, terms(p, left), e) : null;
    });
  };
  const cleanup = () => {
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  };
  return {
    clock,
    hive,
    desk,
    keepers,
    fake,
    job,
    counter,
    say,
    unsay,
    approve,
    terms,
    inChannel,
    address,
    conn,
    events,
    cleanup,
  };
}
