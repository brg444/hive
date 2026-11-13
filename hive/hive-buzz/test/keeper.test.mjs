// The keeper console's key handling: a key locked under a passkey's PRF secret, a passphrase backup
// that restores it, and the line keepers post. The browser parts run in test/keeper-browser.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backup, keeperLine, lockWithPasskey, newSecret, publicKeyOf, restore, unlockWithPasskey } from "../keeper/vault.mjs";
import { parseKeeperKey } from "../shared/proposal.mjs";

const prfA = crypto.getRandomValues(new Uint8Array(32));
const prfB = crypto.getRandomValues(new Uint8Array(32));

test("a key locked with a passkey opens only with that passkey's secret, and its line is the one HiveBot reads", async () => {
    const secret = newSecret();
    const stored = await lockWithPasskey(secret, prfA, "cred-1");
    assert.equal(stored.publicKey, publicKeyOf(secret));
    assert.match(stored.publicKey, /^0[23][0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(Buffer.from(secret).toString("hex")), "the secret is not stored in the clear");
    assert.deepEqual(await unlockWithPasskey(stored, prfA), secret);
    await assert.rejects(unlockWithPasskey(stored, prfB), /does not open/);
    // A box moved under another key's public key is refused.
    const other = await lockWithPasskey(newSecret(), prfA, "cred-2");
    await assert.rejects(unlockWithPasskey({ ...stored, publicKey: other.publicKey }, prfA), /does not open/);
    assert.equal(parseKeeperKey(keeperLine(stored.publicKey)), stored.publicKey);
});

test("a backup restores the key with its passphrase and refuses anything else", async () => {
    const secret = newSecret();
    const file = await backup(secret, "correct horse battery", 100_000);
    assert.equal(file.kind, "hive-keeper-backup");
    assert.deepEqual(await restore(JSON.parse(JSON.stringify(file)), "correct horse battery"), secret);
    await assert.rejects(restore(file, "wrong horse battery"), /That passphrase does not open this backup\./);
    await assert.rejects(backup(secret, "short"), /at least 12 characters/);
    await assert.rejects(restore({ ...file, kdf: { ...file.kdf, iterations: 10 } }, "correct horse battery"), /settings/);
    await assert.rejects(restore({ v: 1, kind: "other" }, "x"), /Not a keeper backup/);
});
