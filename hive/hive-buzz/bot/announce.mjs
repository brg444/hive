// What the hive's bot says in its channel, worked out from two things only: the hive's public state
// (`GET /hive/v1/state`) and the bot's own record of what it has already said. Pure, so it can be
// tested without a relay; the bot posts each message and records it only once the relay accepts it.

const fmt = new Intl.NumberFormat("en-US");
export const sats = (n) => `${fmt.format(n ?? 0)} sats`;
const short = (s) => (!s ? "unknown" : s.length <= 14 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`);
const model = (m) => (!m ? "an unnamed model" : m.startsWith("local-gguf/sha256-") ? `local model ${m.slice(18, 26)}` : m);
const RAIL = { lightning: "Lightning", arkade: "Arkade", onchain: "on-chain Bitcoin" };
const rail = (r) => RAIL[r] ?? (r?.startsWith("ff-") ? "a stablecoin deposit" : "an unknown rail");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A time everyone in a channel reads the same way, whatever their time zone. */
export function utc(unix) {
    const d = new Date(unix * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const monthOf = (unix) => {
    const d = new Date(unix * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthName = (key) => MONTHS[Number(key.slice(5)) - 1];
const provider = (j) => short(j.providerPk ?? j.providerPeer);
const chipKey = (c) => `chip:${c.reference ?? "none"}:${c.at}`;

/** Every message the state calls for, each with the key that marks it said. */
function candidates(state) {
    const out = [];
    for (const j of state.jobs ?? []) {
        if (j.status === "awaiting_funding") {
            // Without an executor renewing the escrow, its coin must outlive the job; recently renewed coins do.
            const coins = j.minCoinExpiry
                ? `If your wallet has not renewed its coins in the last few weeks, renew before paying: the escrow needs coins valid until at least ${utc(j.minCoinExpiry)}. `
                : "";
            out.push({ key: `funding:${j.jobId}`, actionable: true, text:
                `Keepers, a job is waiting for funding. Send exactly ${sats(j.capSats)} to ${j.escrowAddress} in one payment before ${utc(j.deadline)}. ` + coins +
                `It opens a job with provider ${provider(j)} for ${model(j.model)}.` });
        }
        if (["open", "closing", "claimed"].includes(j.status) && j.openedAt) {
            out.push({ key: `open:${j.jobId}`, text:
                `A job with provider ${provider(j)} is open: ${sats(j.capSats)} in escrow for ${model(j.model)} until ${utc(j.deadline)}.` });
        }
        if (j.status === "claimed") {
            const back = j.returnedSats ? ` The remaining ${sats(j.returnedSats)} went back to the treasury in the same transaction.` : "";
            out.push({ key: `claimed:${j.jobId}`, text:
                `Provider ${provider(j)} was paid ${sats(j.paidSats)} for serving ${model(j.model)}.${back} Transaction ${short(j.txid)}.` });
        }
        if (j.status === "returned") {
            out.push({ key: `returned:${j.jobId}`, text: j.openedAt
                ? `A job with provider ${provider(j)} ended unused, and its ${sats(j.returnedSats)} came back to the treasury after the deadline. Transaction ${short(j.txid)}.`
                : `An escrow funded after its job was given up came back to the treasury whole: ${sats(j.returnedSats)}. Transaction ${short(j.txid)}.` });
        }
        if (j.status === "lapsed") {
            out.push({ key: `lapsed:${j.jobId}`, text:
                `A funding request for ${sats(j.capSats)} lapsed before it was funded, so no job opened with provider ${provider(j)}. ` +
                `Anything sent to that address now comes back to the treasury after its deadline.` });
        }
        if (j.status === "declined") {
            const reason = j.note ? `: ${j.note.replace(/[.\s]+$/, "")}.` : ".";
            out.push({ key: `declined:${j.jobId}`, text: `Provider ${provider(j)} declined a job for ${model(j.model)}${reason}` });
        }
    }
    for (const p of state.governance?.proposals ?? []) {
        const title = `“${p.title}”`;
        if (["approved", "running", "completed", "lapsed"].includes(p.state) && p.approvedAt) {
            out.push({ key: `approved:${p.id}`, text:
                `Approved: ${title}, ${sats(p.budgetSats)}. ${p.approvals.length} keepers approved it, and its budget opens ${utc(p.starts)}. Keepers fund its first job next.` });
        }
        if (p.state === "declined") {
            out.push({ key: `declined:${p.id}`, text: `Declined: ${title}${p.reason ? `. ${p.reason.replace(/[.\s]+$/, "")}.` : "."}` });
        }
        if (p.state === "completed") {
            out.push({ key: `done:${p.id}`, text: `Completed: ${title} used ${sats(p.usedSats)} of its ${sats(p.budgetSats)}. The report is in its thread.` });
        }
        if (p.state === "lapsed") {
            out.push({ key: `done:${p.id}`, text: `Ended: ${title} used ${sats(p.usedSats)} of its ${sats(p.budgetSats)}, and what it did not use stays in the treasury.` });
        }
    }
    const balance = state.treasury?.balanceSats;
    for (const c of [...(state.contributions ?? [])].reverse()) {
        const now = balance === null || balance === undefined ? "" : ` The treasury holds ${sats(balance)}.`;
        out.push({ key: chipKey(c), text: `Thank you: a chip-in of ${sats(c.sats)} arrived over ${rail(c.rail)}.${now}` });
    }
    return out;
}

/** The month just ended, from what the state shows and the budget totals recorded when it began. */
function monthSummary(state, month, budgetsAtStart) {
    const inMonth = (unix) => unix && monthOf(unix) === month;
    const chips = (state.contributions ?? []).filter((c) => inMonth(c.at));
    const paid = (state.jobs ?? []).filter((j) => j.status === "claimed" && inMonth(j.closedAt));
    const returned = (state.jobs ?? []).filter((j) => (j.status === "claimed" || j.status === "returned") && inMonth(j.closedAt))
        .reduce((n, j) => n + (j.returnedSats ?? 0), 0);
    const budgets = (state.proposals ?? [])
        .map((p) => ({ proposal: p.proposal, used: p.usedSats - (budgetsAtStart?.[p.proposal] ?? 0) }))
        .filter((b) => b.used > 0)
        .sort((a, b) => b.used - a.used);
    const parts = [
        chips.length ? `${chips.length} chip-in${chips.length === 1 ? "" : "s"} brought ${sats(chips.reduce((n, c) => n + c.sats, 0))}` : "no chip-ins arrived",
        paid.length ? `providers were paid ${sats(paid.reduce((n, j) => n + (j.paidSats ?? 0), 0))} across ${paid.length} job${paid.length === 1 ? "" : "s"}` : "no provider was paid",
        `${sats(returned)} came back to the treasury`,
    ];
    const used = budgets.length ? ` Budgets used: ${budgets.map((b) => `${b.proposal} ${sats(b.used)}`).join(", ")}.` : "";
    const holds = state.treasury?.balanceSats === null || state.treasury?.balanceSats === undefined ? "" : ` The treasury holds ${sats(state.treasury.balanceSats)}.`;
    return `${monthName(month)} in ${state.name}: ${parts[0]}, ${parts[1]}, and ${parts[2]}.${used}${holds}`;
}

const budgetTotals = (state) => Object.fromEntries((state.proposals ?? []).map((p) => [p.proposal, p.usedSats]));

/**
 * The messages to post now, in order, and how the record changes as each is accepted.
 *
 * On its first run the bot says nothing about the past: it records everything already in the state
 * as said, except funding requests still waiting, which keepers need to act on. A month summary is
 * posted the first time the bot runs in a new month. A low treasury is announced once each time the
 * balance falls under the floor.
 */
export function plan(state, record, { now = Math.floor(Date.now() / 1000), lowTreasurySats = 0 } = {}) {
    const said = new Set(record?.said ?? []);
    const all = candidates(state);
    const month = monthOf(now);
    const first = !record;
    const posts = [];
    const quiet = [];
    for (const c of all) {
        if (said.has(c.key)) continue;
        if (first && !c.actionable) quiet.push(c.key);
        else posts.push({ key: c.key, text: c.text });
    }
    const next = {
        v: 1,
        said: [...said, ...quiet],
        month: record?.month ?? month,
        budgetsAtMonthStart: record?.budgetsAtMonthStart ?? budgetTotals(state),
        low: record?.low ?? false,
    };
    if (!first && next.month !== month) {
        posts.push({ key: `month:${next.month}`, text: monthSummary(state, next.month, next.budgetsAtMonthStart), month });
    }
    const balance = state.treasury?.balanceSats;
    if (lowTreasurySats > 0 && typeof balance === "number") {
        if (balance < lowTreasurySats && !next.low) {
            posts.push({ key: "low", text: `The treasury is down to ${sats(balance)}, under the ${sats(lowTreasurySats)} floor for new jobs. Chip-ins are welcome.` });
        } else if (balance >= lowTreasurySats) {
            next.low = false;
        }
    }
    return { posts, record: next, newBudgets: budgetTotals(state) };
}

/** The record once `post` is accepted by the relay. */
export function markSaid(record, post, newBudgets) {
    const said = [...record.said, post.key].slice(-5000);
    if (post.key === "low") return { ...record, said: record.said, low: true };
    if (post.key.startsWith("month:")) return { ...record, said, month: post.month, budgetsAtMonthStart: newBudgets };
    return { ...record, said };
}
