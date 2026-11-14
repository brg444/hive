// The Bitcoin price in US dollars, for members who show amounts in dollars. Display only: nothing the
// hive signs or pays depends on it. Read from mempool.space at most every five minutes and never
// waited on; `--price-url <url>` names another source answering { "USD": <price> }, and `off` stops it.
const EVERY_MS = 5 * 60_000;
let last = null;
let loading = null;
let tried = 0;

export function currentPrice(url = "https://mempool.space/api/v1/prices", now = Date.now()) {
    if (url === "off") return null;
    if (!loading && now - tried >= EVERY_MS) {
        tried = now;
        loading = fetch(url, { signal: AbortSignal.timeout(5_000) })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                const usd = Number(body?.USD);
                if (Number.isFinite(usd) && usd > 0) last = { usdPerBtc: usd, at: Math.floor(Date.now() / 1000), source: new URL(url).host };
            })
            .catch(() => {})
            .finally(() => { loading = null; });
    }
    return last;
}
