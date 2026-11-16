/**
 * The v5 treasury on a local regtest stack, through @hive/treasury and @hive/executor, with the
 * operator's default fees:
 *
 *   1. Three keepers' Buzz keys build the treasury, and its address is the one the SDK builds from
 *      the same artifact.
 *   2. The host issues the counter and funds the treasury with the whole supply; a member chips in.
 *   3. Two keepers approve a payment, each with a channel message signed as Buzz signs one; anyone
 *      merges the chip-in; the approvals still pay.
 *   4. The same approvals pay nothing twice; one keeper alone, a message that says more than the
 *      approval, one carrying it in a tag, the code without the words a keeper reads, words naming
 *      another amount, another recipient, or an approval past its lapse time pays nothing.
 *   5. A coin that holds units of the counter merges into the treasury in neither position: nothing
 *      sets the treasury's payment number but its own payments.
 *   6. A stranger cannot renew the treasury; the delegatee can, and the treasury pays its fee.
 *   7. A payment approved before the renewal pays after it.
 *
 * Needs the regtest stack (arkd on 7070, the Emulator on 7073):
 *
 *   node --experimental-eventsource --import tsx test/treasury-v5-regtest.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Artifact, instantiate } from "@hive/ark";
import {
  type CovenantApproval,
  mergeIntoTreasury,
  payFromTreasury,
  type TreasuryCoin,
  treasuryClient,
  treasuryContract,
  unitsOn,
} from "@hive/executor";
import { hex } from "@hive/kit";
import {
  approvalText,
  type BuzzEvent,
  buzzApproval,
  codeOf,
  counterOf,
  type Payment,
  payMessage,
  recipientOf,
  sdkArguments,
  sha256,
  TREASURY_ARTIFACT,
  type TreasuryTerms,
  treasuryArguments,
} from "@hive/treasury";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { newWallet, renewAsDelegatee, sendOffchain, waitFor } from "./support/treasury-sdk.js";

const ARKD = "http://localhost:7070";
const EMULATOR = "http://localhost:7073";
const SUPPLY = 1_000_000n;
const MAX_FEE = 2_000;
const now = () => Math.floor(Date.now() / 1000);

const info = (await (await fetch(`${ARKD}/v1/info`)).json()) as {
  signerPubkey: string;
  unilateralExitDelay: string;
  fees?: unknown;
};
const emulatorKey = ((await (await fetch(`${EMULATOR}/v1/info`)).json()) as { signerPubkey: string })
  .signerPubkey;
step("operator", { fees: info.fees });
const client = await treasuryClient({ network: "regtest", arkdUrl: ARKD, emulatorUrl: EMULATOR });

// 1. The keepers, and the treasury Hive builds from them.
const maya = buzzKeeper();
const jonas = buzzKeeper();
const priya = buzzKeeper();
const delegate = secp256k1.utils.randomSecretKey();

const host = await newWallet(ARKD, EMULATOR);
sendOffchain(await host.getAddress(), 20_000);
await waitFor("the host's funds", async () => (await host.getBalance()).available >= 20_000);
// The host issues a few units more than it sends, to show that a coin holding them cannot be merged in.
const SPARE = 7n;
const { assetId } = await host.assetManager.issue({ amount: SUPPLY + SPARE } as never);
const counter = counterOf(assetId);
step("counter issued by the host", { assetId });

const terms: TreasuryTerms = {
  keepers: [maya.key, jonas.key, priya.key],
  counter,
  delegateKey: hex(secp256k1.getPublicKey(delegate, true)),
  renewalWindowSeconds: 30 * 86_400,
  maxFeeSats: MAX_FEE,
  exitDelaySeconds: Number(info.unilateralExitDelay),
};
const treasury = treasuryContract(client, TREASURY_ARTIFACT, sdkArguments(terms));
const hive = instantiate(TREASURY_ARTIFACT as unknown as Artifact, treasuryArguments(terms), {
  server: info.signerPubkey,
  emulator: emulatorKey,
  delegate: terms.delegateKey,
});
assert.equal(hive.pkScript, hex(treasury.pkScript), "Hive and the SDK build the same treasury");
step("treasury built from the keepers", { address: treasury.address });

const units = (c: TreasuryCoin) => unitsOn(c, assetId);
const coins = async () => (await treasury.getUtxos()) as TreasuryCoin[];

// 2. The host funds it with the whole counter supply; a member chips in beside it.
await host.send({
  recipients: [{ address: treasury.address, amount: 1_000, assets: [{ assetId, amount: SUPPLY }] }],
} as never);
let coin = await waitFor("the treasury coin", async () => (await coins()).find((c) => units(c) === SUPPLY));
sendOffchain(treasury.address, 60_000);
const chipIn = await waitFor("the chip-in", async () =>
  (await coins()).find((c) => c.value === 60_000 && units(c) === 0n),
);
step("funded", { treasury: coin.value, units: String(units(coin)), chipIn: chipIn.value });

// 3. Two keepers approve a payment to a member; anyone merges the chip-in; the approvals still pay.
const member = await newWallet(ARKD, EMULATOR);
const to = recipientOf(await member.getAddress());
const one: Payment = { left: SUPPLY, amount: 20_000n, validUntil: now() + 3600, program: to.program };
const oneApprovals: (CovenantApproval | null)[] = [maya.approve(one), null, priya.approve(one)];
await mergeIntoTreasury(treasury, coin, chipIn, assetId);
coin = await waitFor("the merged coin", async () =>
  (await coins()).find((c) => c.value === 61_000 && units(c) === SUPPLY),
);
step("merged", { value: coin.value });
const pay = (c: TreasuryCoin, p: Payment, approvals: (CovenantApproval | null)[]) =>
  payFromTreasury(
    treasury,
    c,
    assetId,
    { amount: BigInt(p.amount), program: p.program as Uint8Array, validUntil: p.validUntil },
    approvals,
  );
await pay(coin, one, oneApprovals);
coin = await waitFor("the change", async () => (await coins()).find((c) => units(c) === SUPPLY - 1n));
assert.equal(coin.value, 41_000);
await waitFor("the member's payment", async () => (await member.getBalance()).available >= 20_000);
step("paid, with approvals made before the merge", { value: coin.value, units: String(units(coin)) });

// 4. Approvals pay once, need two keepers, name the recipient, and lapse.
await assert.rejects(pay(coin, one, oneApprovals));
step("the same approvals again: refused");
const two: Payment = { left: SUPPLY - 1n, amount: 5_000n, validUntil: now() + 3600, program: to.program };
const twoApprovals: (CovenantApproval | null)[] = [maya.approve(two), jonas.approve(two), null];
await assert.rejects(pay(coin, two, [twoApprovals[0]!, null, null]));
step("one keeper alone: refused");
const saysMore = jonas.event(`${approvalText(counter, two)} 👍`);
await assert.rejects(pay(coin, two, [twoApprovals[0]!, jonas.parts(saysMore), null]));
step("a message that says more than the approval: refused");
const smuggled = jonas.event("hello", [["t", `","${approvalText(counter, two)}"]`]]);
await assert.rejects(pay(coin, two, [twoApprovals[0]!, jonas.parts(smuggled), null]));
step("a message carrying the approval in a tag: refused");
const bare = jonas.event(`I approve Hive payment ${codeOf(payMessage(counter, two))}`);
await assert.rejects(pay(coin, two, [twoApprovals[0]!, jonas.parts(bare), null]));
step("the code without the words a keeper reads: refused");
const otherWords = jonas.event(approvalText(counter, two).replace("of 5000 sats", "of 50 sats"));
await assert.rejects(pay(coin, two, [twoApprovals[0]!, jonas.parts(otherWords), null]));
step("words naming another amount than the code's: refused");

const elsewhere = recipientOf(await (await newWallet(ARKD, EMULATOR)).getAddress()).program;
await assert.rejects(pay(coin, { ...two, program: elsewhere }, twoApprovals));
step("another recipient: refused");
const lapsed: Payment = { ...two, validUntil: now() - 60 };
await assert.rejects(pay(coin, lapsed, [maya.approve(lapsed), jonas.approve(lapsed), null]));
step("an approval past its lapse time: refused");

// 5. A coin holding units of the counter, sent to the treasury's script, merges in neither position.
await host.send({
  recipients: [{ address: treasury.address, amount: 1_000, assets: [{ assetId, amount: SPARE }] }],
} as never);
const stray = await waitFor("the coin with spare units", async () =>
  (await coins()).find((c) => units(c) === SPARE),
);
// biome-ignore lint/suspicious/noExplicitAny: the SDK types each function's arguments from the artifact at runtime
const functions = treasury.functions as any;
const merge = (inputs: [TreasuryCoin, TreasuryCoin], kept: bigint) =>
  functions
    .merge()
    .from(inputs)
    .to(treasury.pkScript, BigInt(inputs[0].value + inputs[1].value))
    .withAsset({
      assetId,
      inputs: inputs.map((c, vin) => ({ vin, amount: units(c) })),
      outputs: [{ vout: 0, amount: kept }],
    })
    .send();
await assert.rejects(merge([stray, coin], SPARE));
step("a coin with units in front of the treasury coin, to set its number: refused");
await assert.rejects(merge([coin, stray], units(coin)));
step("the same coin folded in behind the treasury coin: refused");
assert.equal(units((await coins()).find((c) => c.txid === coin.txid)!), SUPPLY - 1n);

// 6. Only the delegatee renews; the treasury pays the operator's fee.
await assert.rejects(
  renewAsDelegatee(client, treasury, coin, { delegate: secp256k1.utils.randomSecretKey(), maxFee: MAX_FEE }),
);
step("a stranger's renewal: refused");
const before = coin;
const renewed = await renewAsDelegatee(client, treasury, coin, { delegate, maxFee: MAX_FEE });
coin = await waitFor(
  "the renewed coin",
  async () => (await coins()).find((c) => c.txid !== before.txid && units(c) === SUPPLY - 1n),
  180,
);
assert.equal(coin.value, before.value - renewed.fee);
step("renewed by the delegatee", { fee: renewed.fee, value: coin.value });

// 7. The payment approved before the renewal pays after it.
await pay(coin, two, twoApprovals);
coin = await waitFor("the second change", async () => (await coins()).find((c) => units(c) === SUPPLY - 2n));
assert.equal(coin.value, before.value - renewed.fee - 5_000);
step("paid, with approvals made before the renewal", { value: coin.value, units: String(units(coin)) });

console.log("PASSED");
process.exit(0);

// ---- helpers ---------------------------------------------------------------------------------

function step(name: string, detail: Record<string, unknown> = {}) {
  console.log(`- ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

/** A keeper's Buzz identity: it sends channel messages exactly as Buzz's outbox builds them. */
function buzzKeeper() {
  const secret = schnorr.utils.randomSecretKey();
  const key = hex(schnorr.getPublicKey(secret));
  const channel = randomUUID();
  const utf8 = (t: string) => new TextEncoder().encode(t);
  const event = (content: string, extra: string[][] = []): BuzzEvent => {
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [["h", channel], ...extra, ["client-id", randomUUID()], ["ms", String(Date.now() % 1000)]];
    const id = hex(sha256(utf8(JSON.stringify([0, key, created_at, 9, tags, content]))));
    const sig = hex(schnorr.sign(Buffer.from(id, "hex"), secret));
    return { id, pubkey: key, created_at, kind: 9, tags, content, sig };
  };
  return {
    key,
    event,
    /** What the covenant takes from any of this keeper's messages, checked or not. */
    parts: (e: BuzzEvent): CovenantApproval => ({
      sig: Buffer.from(e.sig, "hex"),
      time: utf8(String(e.created_at)),
      tags: utf8(JSON.stringify(e.tags)),
    }),
    approve: (payment: Payment): CovenantApproval =>
      buzzApproval(key, counter, payment, event(approvalText(counter, payment))),
  };
}
