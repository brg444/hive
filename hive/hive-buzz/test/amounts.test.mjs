import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_UNIT, formatAmount, savedUnit, saveUnit, UNITS } from "../shared/amounts.mjs";

test("an amount in sats reads in the unit the viewer chose", () => {
    const price = 67_235;
    assert.equal(formatAmount(20_000, "bitcoin", price), "₿20,000");
    assert.equal(formatAmount(20_000, "sats", price), "20,000 sats");
    assert.equal(formatAmount(20_000, "btc", price), "0.0002 BTC");
    assert.equal(formatAmount(1, "btc", price), "0.00000001 BTC");
    assert.equal(formatAmount(20_000, "usd", price), "$13.45");
    assert.equal(formatAmount(10, "usd", price), "<$0.01");
    assert.equal(formatAmount(null, "usd", price), "–");
});

test("dollars give way to ₿ without a price, and wherever the amount must be exact", () => {
    assert.equal(formatAmount(20_000, "usd", null), "₿20,000");
    assert.equal(formatAmount(20_000, "usd", 67_235, true), "₿20,000");
    assert.equal(formatAmount(20_000, "sats", 67_235, true), "20,000 sats");
});

test("the choice is kept per browser, ₿ by default, and an unknown one is ignored", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    assert.equal(savedUnit(storage), DEFAULT_UNIT);
    saveUnit("btc", storage);
    assert.equal(savedUnit(storage), "btc");
    saveUnit("eur", storage);
    assert.equal(savedUnit(storage), "btc");
    assert.equal(savedUnit({ getItem: () => { throw new Error("blocked"); } }), DEFAULT_UNIT);
    assert.deepEqual(UNITS.map((u) => u.id), ["bitcoin", "sats", "btc", "usd"]);
});
