import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { type Artifact, instantiate, leafOf, pairKey } from "@hive/ark";
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
const message = payMessage(counter, { left: 999n, amount: 20_000n, validUntil, program });

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
  const event = k.send(approvalText(message));
  assert.equal(event.content, `I approve Hive payment ${codeOf(message)}`);
  const a = buzzApproval(k.key, message, event);
  assert.equal(a.sig.length, 64);
  assert.equal(new TextDecoder().decode(a.time), "1800000000");
  assert.equal(new TextDecoder().decode(a.tags), JSON.stringify(event.tags));
  assert.ok(approvalHolds(k.key, message, a));
  assert.ok(
    !approvalHolds(k.key, payMessage(counter, { left: 998n, amount: 20_000n, validUntil, program }), a),
  );
  assert.ok(!approvalHolds(buzzKey().key, message, a), "filed under another keeper");
});

test("a message that says more, approves another payment, or is not the keeper's is refused", () => {
  const k = buzzKey();
  const refused = (fn: () => unknown, reason: string) =>
    assert.throws(fn, (e: unknown) => e instanceof ApprovalRefused && e.reason === reason);
  const other = payMessage(counter, { left: 999n, amount: 20_001n, validUntil, program });
  refused(() => buzzApproval(k.key, message, k.send(approvalText(other))), "ANOTHER_PAYMENT");
  refused(() => buzzApproval(k.key, message, k.send(`${approvalText(message)} 👍`)), "ANOTHER_PAYMENT");
  refused(() => buzzApproval(k.key, message, k.send(declineText(message))), "ANOTHER_PAYMENT");
  refused(() => buzzApproval(k.key, message, k.send(approvalText(message), { kind: 1 })), "NOT_A_MESSAGE");
  refused(() => buzzApproval(buzzKey().key, message, k.send(approvalText(message))), "NOT_THIS_KEEPER");
  const event = k.send(approvalText(message));
  refused(() => buzzApproval(k.key, message, { ...event, tags: [["h", "elsewhere"]] }), "NOT_A_MESSAGE");
  const forged = {
    ...event,
    sig: hex.encode(schnorr.sign(hex.decode(event.id), schnorr.utils.randomSecretKey())),
  };
  refused(() => buzzApproval(k.key, message, forged), "BAD_SIGNATURE");
});

test("a real message carrying the approval's words in a tag does not pass for one", () => {
  const k = buzzKey();
  const event = k.send("hello", {
    tags: [
      ["h", "c"],
      ["t", `","${approvalText(message)}"]`],
    ],
  });
  // What the covenant would hash for this keeper's approval, from this event's own parts.
  const a = {
    sig: hex.decode(event.sig),
    time: utf8(String(event.created_at)),
    tags: utf8(JSON.stringify(event.tags)),
  };
  assert.ok(!approvalHolds(k.key, message, a));
});

test("approvals, declines and withdrawals read only from their exact text", () => {
  const code = codeOf(message);
  assert.deepEqual(paymentWord(approvalText(message)), { word: "approve", code });
  assert.deepEqual(paymentWord(declineText(message)), { word: "decline", code });
  assert.equal(paymentWord(`${approvalText(message)} please`), null);
  assert.equal(paymentWord(`i approve hive payment ${code}`), null);
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
  const pair01 = pairKey(`02${keepers[0]}`, `02${keepers[1]}`);
  assert.ok(leafOf(instance, "exit01").includes(pair01), "the first pair's MuSig2 key is on its exit leaf");
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
