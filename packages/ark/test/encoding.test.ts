import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeScriptNum, ScriptBuilder, scriptNum, sequence } from "@hive/ark";
import { hex } from "@hive/kit";

test("script numbers are minimal and round-trip", () => {
  for (const n of [0n, 1n, 16n, 127n, 128n, 255n, 256n, -1n, -128n, 86_400n, 2n ** 53n - 1n]) {
    assert.equal(decodeScriptNum(scriptNum(n)), n);
  }
  assert.equal(hex(scriptNum(128)), "8000");
  assert.equal(hex(scriptNum(-1)), "81");
  assert.throws(() => decodeScriptNum(Uint8Array.of(0)));
  assert.throws(() => decodeScriptNum(Uint8Array.of(1, 0)));
  assert.equal(sequence(1024), (1 << 22) | 2);
});

test("the builder pushes as btcd does", () => {
  assert.equal(hex(new ScriptBuilder().addInt(0).addInt(5).addInt(-1).addInt(17).script()), "00554f0111");
  assert.equal(hex(new ScriptBuilder().addData(Uint8Array.of(0)).addData(Uint8Array.of(7)).script()), "0057");
  assert.equal(hex(new ScriptBuilder().addRawPush(Uint8Array.of(0)).script()), "0100");
  assert.equal(hex(new ScriptBuilder().addData(new Uint8Array(76)).script()).slice(0, 4), "4c4c");
});
