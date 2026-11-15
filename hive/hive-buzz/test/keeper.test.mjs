// The line a keeper posts, as the keeper console writes it and HiveBot reads it: the Bitcoin key the
// keeper's passkey derives, the passkey's own P-256 key, and the site the passkey belongs to. The
// console itself runs in a browser in test/keeper-browser.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeeperKey } from "../shared/proposal.mjs";

const bitcoinKey = `02${"ab".repeat(32)}`;
const passkey = `11${"03"}${"cd".repeat(32)}`;

test("a keeper's line names three things, read back as one token", () => {
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey} keepers.example.org`), `${bitcoinKey} ${passkey} keepers.example.org`);
    // Pasted as code, or in another case, it still counts; the token is lowercase.
    assert.equal(parseKeeperKey(`\`hive keeper key: ${bitcoinKey.toUpperCase()} ${passkey} Keepers.Example.org\``), `${bitcoinKey} ${passkey} keepers.example.org`);
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey} localhost`), `${bitcoinKey} ${passkey} localhost`);
});

test("a line with a malformed key or site is no keeper's", () => {
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey}`), null);
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey.slice(2)} keepers.example.org`), null);
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey} https://keepers.example.org`), null);
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey} ${passkey} keepers.example.org extra`), null);
});

test("an earlier console's line, a Bitcoin key alone, still reads as that key", () => {
    assert.equal(parseKeeperKey(`Hive keeper key: ${bitcoinKey}`), bitcoinKey);
});
