// A proposal is an ordinary Buzz message in the hive's channel, readable in any client:
//
//   Proposal: Translate the Buzz docs into Spanish and Portuguese
//   Budget: 30,000 sats from 2026-11-15 to 2026-12-10
//   For: only me, 2,000 sats a day
//   Purpose: Buzz's docs exist only in English. The translated pages go to the docs repo.
//   Work: About 2.4 million tokens on llama-3.3-70b.
//   Provider: Lena's node, for the 70B model
//   Report: A link to the merged pull request.
//
// The plugin draws it as a card, the bot reads it as the record, and both use these two
// functions, so the text a member sends is exactly what the hive acts on. This file is also
// inlined into the plugin, so it imports nothing.

const FIELDS = ["proposal", "budget", "for", "purpose", "work", "provider", "report"];
const LABEL = { proposal: "Proposal", budget: "Budget", for: "For", purpose: "Purpose", work: "Work", provider: "Provider", report: "Report" };
const DAY = 86400;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const toUnix = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
const num = (s) => Number(String(s).replace(/[,\s_]/g, ""));

/** The proposal in a message's text, or null when the text is not a well-formed proposal. */
export function parseProposal(text, mentions = []) {
    if (typeof text !== "string" || text.length > 6000) return null;
    const lines = text.replace(/\r/g, "").split("\n");
    const fields = {};
    let current = null;
    for (const raw of lines) {
        const m = /^\s*(?:\*\*)?([A-Za-z]+)(?:\*\*)?\s*:\s*(.*)$/.exec(raw);
        const key = m && m[1].toLowerCase();
        if (key && FIELDS.includes(key) && !(key in fields)) {
            current = key;
            fields[key] = m[2].trim();
        } else if (current && raw.trim()) {
            fields[current] += (fields[current] ? "\n" : "") + raw.trim();
        }
    }
    if (!fields.proposal || !fields.budget || !fields.purpose) return null;
    if (!/^\s*(?:\*\*)?proposal(?:\*\*)?\s*:/i.test(lines.find((l) => l.trim()) ?? "")) return null;

    const b = /^([\d,\s_]+)\s*sats?\b(?:\s+from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2}))?/i.exec(fields.budget);
    if (!b) return null;
    const budgetSats = num(b[1]);
    if (!Number.isSafeInteger(budgetSats) || budgetSats <= 0) return null;
    let start = null, end = null;
    if (b[2] && b[3] && isoDay.test(b[2]) && isoDay.test(b[3])) {
        start = toUnix(b[2]);
        end = toUnix(b[3]) + DAY - 1;
        if (!(end > start)) return null;
    }

    const f = (fields.for ?? "only me").toLowerCase();
    const who = /every/.test(f) ? "everyone" : /named|@|members/.test(f) && mentions.length ? "named" : "me";
    const a = /([\d,\s_]+)\s*sats?\s*(?:a|per)\s*day/i.exec(fields.for ?? "");
    const allowanceSats = a ? num(a[1]) : null;

    return {
        title: fields.proposal.slice(0, 200),
        budgetSats,
        start,
        end,
        days: start && end ? Math.round((end + 1 - start) / DAY) : null,
        who,
        named: who === "named" ? [...mentions] : [],
        allowanceSats: Number.isSafeInteger(allowanceSats) && allowanceSats > 0 ? allowanceSats : null,
        purpose: fields.purpose,
        work: fields.work ?? "",
        provider: fields.provider ?? "",
        report: fields.report ?? "",
    };
}

/** The message text for a proposal; `parseProposal(formatProposal(p))` gives `p` back. */
export function formatProposal(p) {
    const fmt = (n) => Number(n).toLocaleString("en-US");
    const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
    const forText = p.who === "everyone" ? "everyone" : p.who === "named" ? "named members" : "only me";
    const lines = [
        `${LABEL.proposal}: ${p.title.trim()}`,
        `${LABEL.budget}: ${fmt(p.budgetSats)} sats${p.start && p.end ? ` from ${day(p.start)} to ${day(p.end)}` : ""}`,
        `${LABEL.for}: ${forText}${p.allowanceSats ? `, ${fmt(p.allowanceSats)} sats a day` : ""}`,
        `${LABEL.purpose}: ${p.purpose.trim()}`,
    ];
    if (p.work?.trim()) lines.push(`${LABEL.work}: ${p.work.trim()}`);
    if (p.provider?.trim()) lines.push(`${LABEL.provider}: ${p.provider.trim()}`);
    if (p.report?.trim()) lines.push(`${LABEL.report}: ${p.report.trim()}`);
    return lines.join("\n");
}

/** A member tells the hive which MeshLLM node is theirs: `Hive node: <64 hex>`. */
export function parseNodeClaim(text) {
    const m = /^\s*hive node\s*:\s*([0-9a-f]{64})\s*$/i.exec(text ?? "");
    return m ? m[1].toLowerCase() : null;
}

/** How long discussion stays open: 48 hours, or 24 under the small-proposal threshold. */
export function discussionSeconds(budgetSats, smallSats) {
    return budgetSats < smallSats ? DAY : 2 * DAY;
}
