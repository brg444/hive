/**
 * The Bitcoin price in US dollars, for showing amounts in dollars to those who ask for them. It is
 * display only: nothing Hive signs or pays depends on it. Read from mempool.space at most every five
 * minutes, and never waited on: a caller gets the last price known, or null, while a fresh one loads.
 * `HIVE_PRICE_URL` names another source answering `{ "USD": <price> }`; `HIVE_PRICE_URL=off` stops it.
 */
export interface Price {
  usdPerBtc: number;
  at: number;
  source: string;
}

const EVERY_MS = 5 * 60_000;
let last: Price | null = null;
let loading: Promise<void> | null = null;
let tried = 0;

export function currentPrice(now = Date.now()): Price | null {
  const url = process.env.HIVE_PRICE_URL ?? "https://mempool.space/api/v1/prices";
  if (url === "off") return null;
  if (!loading && now - tried >= EVERY_MS) {
    tried = now;
    loading = fetch(url, { signal: AbortSignal.timeout(5_000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { USD?: unknown } | null) => {
        const usd = Number(body?.USD);
        if (Number.isFinite(usd) && usd > 0)
          last = { usdPerBtc: usd, at: Math.floor(Date.now() / 1000), source: new URL(url).host };
      })
      .catch(() => {})
      .finally(() => {
        loading = null;
      });
  }
  return last;
}
