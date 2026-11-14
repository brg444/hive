// How Hive shows an amount, in the unit the viewer chose: ₿ (Bitcoin's smallest unit written the way
// Spiral proposes, so ₿1 is one sat and ₿20,000 is twenty thousand of them), sats, BTC, or US dollars
// at the current Bitcoin price. Amounts are kept and sent in sats everywhere; only the display changes.
// The Buzz plugin build inlines this file, and the keeper console bundles it.

/** The units a viewer can choose, with a sample of each. */
export const UNITS = [
    { id: "bitcoin", label: "Bitcoin (₿)", sample: "₿20,000", note: "Bitcoin's smallest unit, as Spiral writes it: ₿1 is one sat." },
    { id: "sats", label: "Sats", sample: "20,000 sats", note: "The same unit, by its usual name." },
    { id: "btc", label: "BTC", sample: "0.0002 BTC", note: "Whole Bitcoin, to eight decimal places." },
    { id: "usd", label: "US dollars", sample: "$13.45", note: "At the current Bitcoin price, rounded to the cent." },
];
export const DEFAULT_UNIT = "bitcoin";
export const UNIT_KEY = "hive.amounts.v1";
const known = (u) => UNITS.some((x) => x.id === u);

/** The viewer's unit, kept in this browser. */
export function savedUnit(storage = globalThis.localStorage) {
    try {
        const u = storage?.getItem(UNIT_KEY);
        return known(u) ? u : DEFAULT_UNIT;
    } catch {
        return DEFAULT_UNIT;
    }
}

export function saveUnit(u, storage = globalThis.localStorage) {
    if (!known(u)) return;
    try {
        storage?.setItem(UNIT_KEY, u);
    } catch {
        // private browsing: the choice lasts until the page closes
    }
}

const whole = new Intl.NumberFormat();
const btc = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 });
const usd = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * An amount in sats as its parts, so a page can set the number apart from its unit. `exact` asks for a
 * unit that states the amount to the sat: dollars then give way to ₿, as they do with no price.
 */
export function amountParts(sats, unit, usdPerBtc, exact = false) {
    if (sats === null || sats === undefined || !Number.isFinite(sats)) return { pre: "", num: "–", post: "" };
    const u = unit === "usd" && (exact || !(usdPerBtc > 0)) ? DEFAULT_UNIT : unit;
    if (u === "sats") return { pre: "", num: whole.format(sats), post: " sats" };
    if (u === "btc") return { pre: "", num: btc.format(sats / 1e8), post: " BTC" };
    if (u === "usd") {
        const v = (sats / 1e8) * usdPerBtc;
        return v > 0 && v < 0.01 ? { pre: "<$", num: "0.01", post: "" } : { pre: "$", num: usd.format(v), post: "" };
    }
    return { pre: "₿", num: whole.format(sats), post: "" };
}

export function formatAmount(sats, unit, usdPerBtc, exact = false) {
    const p = amountParts(sats, unit, usdPerBtc, exact);
    return `${p.pre}${p.num}${p.post}`;
}
