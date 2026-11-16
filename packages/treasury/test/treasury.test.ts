import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { type Artifact, instantiate, leafOf } from "@hive/ark";
import {
  ApprovalRefused,
  approvalHolds,
  approvalText,
  type BuzzEvent,
  buzzApproval,
  codeOf,
  counterOf,
  declineText,
  payMessage,
  paymentWord,
  paymentWords,
  recipientOf,
  sha256,
  TREASURY_ARTIFACT,
  type TreasuryTerms,
  treasuryArguments,
  withdrawalOf,
  withdrawalText,
} from "@hive/treasury";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32m, hex } from "@scure/base";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A Buzz identity: it signs channel messages as Buzz's outbox builds them. */
function buzzKey() {
  const secret = schnorr.utils.randomSecretKey();
  const key = hex.encode(schnorr.getPublicKey(secret));
  return {
    key,
    send(content: string, o: { kind?: number; tags?: string[][]; at?: number } = {}): BuzzEvent {
      const created_at = o.at ?? 1_800_000_000;
      const kind = o.kind ?? 9;
      const tags = o.tags ?? [
        ["h", "4f1c2e0a-0000-4000-8000-000000000000"],
        ["client-id", "c1"],
        ["ms", "417"],
      ];
      const id = hex.encode(sha256(utf8(JSON.stringify([0, key, created_at, kind, tags, content]))));
      return {
        id,
        pubkey: key,
        created_at,
        kind,
        tags,
        content,
        sig: hex.encode(schnorr.sign(hex.decode(id), secret)),
      };
    },
  };
}

const counter = counterOf(`${"ab".repeat(30)}cdef0100`);
const program = schnorr.getPublicKey(schnorr.utils.randomSecretKey());
const validUntil = 1_900_000_000;
const payment = { left: 999n, amount: 20_000n, validUntil, program };
const message = payMessage(counter, payment);
const words = `20000 sats to ${hex.encode(program.subarray(0, 4))}`;

test("the counter's txid is the asset id's, reversed, and its group is little-endian", () => {
  assert.equal(counter.txid, `efcd${"ab".repeat(30)}`);
  assert.equal(counter.gidx, 1);
});

test("the message is the tag, the counter, units left, amount and program, as the contract writes them", () => {
  const le = (n: bigint, w: number) =>
    Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const expected = sha256(
    new Uint8Array([
      ...utf8("hive/treasury/pay/v1"),
      ...hex.decode(counter.txid),
      1,
      0,
      ...le(999n, 8),
      ...le(20_000n, 8),
      ...le(BigInt(validUntil), 8),
      ...program,
      1,
    ]),
  );
  assert.deepEqual(message, expected);
  assert.notDeepEqual(
    payMessage(counter, { left: 998n, amount: 20_000n, validUntil, program }),
    message,
    "another payment number",
  );
  assert.notDeepEqual(
    payMessage(counter, { left: 999n, amount: 20_000n, validUntil: validUntil + 1, program }),
    message,
    "another lapse time",
  );
  assert.throws(() => payMessage(counter, { left: -1n, amount: 1n, validUntil, program }));
});

test("a keeper's Buzz message approving this payment is accepted in the form pay takes", () => {
  const k = buzzKey();
  const event = k.send(approvalText(counter, payment));
  assert.equal(event.content, `I approve Hive payment of ${words} ${codeOf(message)}`);
  const a = buzzApproval(k.key, counter, payment, event);
  assert.equal(a.sig.length, 64);
  assert.equal(new TextDecoder().decode(a.time), "1800000000");
  assert.equal(new TextDecoder().decode(a.tags), JSON.stringify(event.tags));
  assert.ok(approvalHolds(k.key, counter, payment, a));
  assert.ok(!approvalHolds(k.key, counter, { ...payment, left: 998n }, a));
  assert.ok(!approvalHolds(buzzKey().key, counter, payment, a), "filed under another keeper");
});

test("a message that says more, approves another payment, or is not the keeper's is refused", () => {
  const k = buzzKey();
  const refused = (fn: () => unknown, reason: string) =>
    assert.throws(fn, (e: unknown) => e instanceof ApprovalRefused && e.reason === reason);
  const approve = approvalText(counter, payment);
  const approves = (event: ReturnType<typeof k.send>, keeper = k.key) =>
    buzzApproval(keeper, counter, payment, event);
  refused(() => approves(k.send(approvalText(counter, { ...payment, amount: 20_001n }))), "ANOTHER_PAYMENT");
  refused(() => approves(k.send(`${approve} 👍`)), "ANOTHER_PAYMENT");
  refused(() => approves(k.send(declineText(counter, payment))), "ANOTHER_PAYMENT");
  // The words a keeper reads are part of what they sign: the code alone, or other words, approve nothing.
  refused(() => approves(k.send(`I approve Hive payment ${codeOf(message)}`)), "ANOTHER_PAYMENT");
  refused(() => approves(k.send(approve.replace("of 20000 sats", "of 200 sats"))), "ANOTHER_PAYMENT");
  refused(() => approves(k.send(approve, { kind: 1 })), "NOT_A_MESSAGE");
  refused(() => approves(k.send(approve), buzzKey().key), "NOT_THIS_KEEPER");
  const event = k.send(approve);
  refused(() => approves({ ...event, tags: [["h", "elsewhere"]] }), "NOT_A_MESSAGE");
  const forged = {
    ...event,
    sig: hex.encode(schnorr.sign(hex.decode(event.id), schnorr.utils.randomSecretKey())),
  };
  refused(() => approves(forged), "BAD_SIGNATURE");
});

test("a real message carrying the approval's words in a tag does not pass for one", () => {
  const k = buzzKey();
  const event = k.send("hello", {
    tags: [
      ["h", "c"],
      ["t", `","${approvalText(counter, payment)}"]`],
    ],
  });
  // What the covenant would hash for this keeper's approval, from this event's own parts.
  const a = {
    sig: hex.decode(event.sig),
    time: utf8(String(event.created_at)),
    tags: utf8(JSON.stringify(event.tags)),
  };
  assert.ok(!approvalHolds(k.key, counter, payment, a));
});

test("approvals, declines and withdrawals read only from their exact text", () => {
  const code = codeOf(message);
  const named = { code, amountSats: 20_000, recipient: hex.encode(program.subarray(0, 4)) };
  assert.deepEqual(paymentWord(approvalText(counter, payment)), { word: "approve", ...named });
  assert.deepEqual(paymentWord(declineText(counter, payment)), { word: "decline", ...named });
  assert.equal(paymentWord(`${approvalText(counter, payment)} please`), null);
  assert.equal(paymentWord(`i approve hive payment of ${words} ${code}`), null);
  assert.equal(paymentWord(`I approve Hive payment ${code}`), null, "the code without the words");
  assert.equal(paymentWord(`I approve Hive payment of 020000 sats to ${named.recipient} ${code}`), null);
  // The amount is written as the contract writes it: plain digits, up to twelve of them.
  assert.equal(paymentWords({ amount: 330n, program }), `330 sats to ${named.recipient}`);
  assert.equal(paymentWords({ amount: 999_999_999_999n, program }).split(" ")[0], "999999999999");
  assert.throws(() => paymentWords({ amount: 1_000_000_000_000n, program }));
  const address = "tark1qexampleaddress0000";
  assert.equal(withdrawalText(5000, address), `Hive withdrawal: 5,000 sats to ${address}`);
  assert.deepEqual(withdrawalOf(withdrawalText(5000, address)), { amountSats: 5000, address });
  assert.deepEqual(withdrawalOf(`hive withdrawal: 12000 sat to \`${address.toUpperCase()}\``), {
    amountSats: 12000,
    address,
  });
  assert.equal(withdrawalOf("Hive withdrawal: 0 sats to tark1q"), null);
  assert.equal(withdrawalOf("Hive withdrawal: lots to tark1q"), null);
});

test("the recipient's program comes from an Arkade address or a Bitcoin Taproot address", () => {
  const arkade = bech32m.encode(
    "tark",
    bech32m.toWords(new Uint8Array([0, ...new Uint8Array(32).fill(9), ...program])),
    1023,
  );
  assert.deepEqual(recipientOf(arkade), { kind: "arkade", network: "tark", program });
  const taproot = bech32m.encode("bcrt", [1, ...bech32m.toWords(program)]);
  assert.deepEqual(recipientOf(taproot), { kind: "bitcoin", network: "bcrt", program });
  assert.throws(() => recipientOf(bech32m.encode("bcrt", [0, ...bech32m.toWords(new Uint8Array(32))])));
});

test("Hive builds the v5 treasury from its keepers' Buzz keys, with v4's exit leaves over them", () => {
  const vectors = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../ark/test/vectors/derivations.json"), "utf8"),
  ) as { keys: { server: string; emulator: string; delegate: string } };
  const keepers = [buzzKey().key, buzzKey().key, buzzKey().key] as const;
  const terms: TreasuryTerms = {
    keepers,
    counter,
    delegateKey: vectors.keys.delegate,
    renewalWindowSeconds: 86_400,
    maxFeeSats: 2_000,
    exitDelaySeconds: 86_016,
  };
  const instance = instantiate(
    TREASURY_ARTIFACT as unknown as Artifact,
    treasuryArguments(terms),
    vectors.keys,
  );
  assert.match(instance.pkScript, /^5120[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(instance.covenants).sort(), ["merge", "pay", "renew"]);
  const exit01 = leafOf(instance, "exit01");
  assert.ok(
    exit01.includes(`20${keepers[0]}`) && exit01.includes(`20${keepers[1]}`) && !exit01.includes(keepers[2]),
    "the first pair's exit leaf checks the two keepers' own Buzz keys, and only theirs",
  );
  assert.ok(
    instance.covenants.renew &&
      hex.encode(instance.covenants.renew).includes(hex.encode(utf8(vectors.keys.delegate))),
  );
  assert.ok(
    instance.covenants.pay && hex.encode(instance.covenants.pay).includes(hex.encode(utf8(keepers[2]))),
    "pay rebuilds each keeper's messages with the key as Buzz writes it",
  );
  assert.throws(() => treasuryArguments({ ...terms, keepers: [keepers[0], keepers[0], keepers[2]] }));
  assert.throws(() => treasuryArguments({ ...terms, keepers: [keepers[0], keepers[1], "ff".repeat(32)] }));
  assert.throws(() =>
    treasuryArguments({ ...terms, keepers: [keepers[0], keepers[1], keepers[2].toUpperCase()] }),
  );
  // The Emulator runs a covenant of at most 10,000 bytes.
  for (const [fn, script] of Object.entries(instance.covenants))
    assert.ok(script.length < 10_000, `${fn} fits`);
});
