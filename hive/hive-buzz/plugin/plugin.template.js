// Hive for Buzz (API v1): a hive inside its community. Members follow the treasury, propose work and
// use their allowances; keepers see what waits for them. It shows and routes and holds no keys: every
// proposal, support and approval is an ordinary Buzz message or reaction signed by its author, and
// everything else comes from the hive's host over the one origin its manifest declares.
export const inject = ["react", "pages", "host", "notifications", "agents", "conversation", "relay", "navigation"];

const HIVE_API = "__HIVE_API__";
const PLUGIN_ID = "__PLUGIN_ID__";
const HIVE_NAME = "__HIVE_NAME__";
const POLL_MS = 30_000;

/*__PROPOSAL__*/

const STATUS = {
    offered: "Offered",
    awaiting_funding: "Awaiting funding",
    open: "Open",
    closing: "Closing",
    claimed: "Paid",
    returned: "Returned",
    declined: "Declined",
    lapsed: "Lapsed",
};
const STAGE = {
    open: "Open for discussion",
    approved: "Approved",
    running: "Running",
    completed: "Completed",
    lapsed: "Ended",
    declined: "Declined",
    withdrawn: "Withdrawn",
};
const APPROVE = ["✅", "✔️", "☑️"];
const SUPPORT = ["👍", "+", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", "❤️", "🙌"];

const nf = new Intl.NumberFormat();
const sats = (n) => (n === null || n === undefined ? "–" : `${nf.format(n)} sats`);
const short = (s, head = 10, tail = 6) => (!s ? "–" : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);
const modelName = (m) => (m ? (m.startsWith("local-gguf/sha256-") ? `local model ${m.slice(18, 26)}` : m) : "–");
const RAIL = { lightning: "Lightning", arkade: "Arkade", onchain: "on-chain Bitcoin" };
const rail = (r) => RAIL[r] ?? (r?.startsWith("ff-") ? "a stablecoin deposit" : r ?? "–");
const when = (unix) => (unix ? new Date(unix * 1000).toLocaleString() : "–");
const day = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "–");
const nowS = () => Math.floor(Date.now() / 1000);
function until(unix) {
    if (!unix) return "–";
    const s = unix - nowS();
    const abs = Math.abs(s);
    const text = abs < 3600 ? `${Math.max(1, Math.round(abs / 60))} min` : abs < 172800 ? `${Math.round(abs / 3600)} h` : `${Math.round(abs / 86400)} days`;
    return s >= 0 ? `in ${text}` : `${text} ago`;
}

/** Proposals a member may spend from: everyone's, those naming them, and their own. */
function allowancesFor(gov, viewer) {
    if (!gov || !viewer) return [];
    return gov.proposals.filter((p) => p.state === "running" && (p.who === "everyone" || p.by === viewer || (p.who === "named" && p.named.includes(viewer))));
}

/** A one-line account of the hive, for agents in the community. */
function summarize(state) {
    if (!state) return "The hive's state has not loaded yet.";
    const gov = state.governance;
    const open = state.jobs.filter((j) => j.status === "open");
    const lines = [
        `${state.name}: treasury ${sats(state.treasury.balanceSats)}.`,
        state.chipIn?.lightningAddress ? `Chip in at ${state.chipIn.lightningAddress}.` : null,
        `${open.length} open job(s), ${state.funding.length} awaiting funding by keepers.`,
        ...state.funding.map((j) => `- Fund ${sats(j.capSats)} to ${j.escrowAddress} for ${modelName(j.model)} (deadline ${when(j.deadline)}).`),
        ...(gov?.proposals ?? []).filter((p) => ["open", "approved", "running"].includes(p.state)).map((p) =>
            `- Proposal ${p.id} "${p.title}": ${STAGE[p.state]}, ${sats(p.budgetSats)}${p.state === "running" ? `, ${sats(p.usedSats)} used` : ""}, ${p.support} support, ${p.approvals.length} keeper approval(s).`),
        ...(gov ? [] : (state.proposals ?? []).map((b) => `- Budget ${b.proposal}: ${sats(b.usedSats)} used by ${b.members} member(s) over ${b.requests} request(s).`)),
        state.agent ? `Members install with the hive's agent's node id ${state.agent.nodeId}.` : null,
        ...state.providers.map((p) => `- Provider ${short(p.providerPk ?? p.providerPeer)}: earned ${sats(p.earnedSats)}, ${p.openJobs} open.`),
        "Members propose work in the hive's channel with a message starting \"Proposal:\"; 👍 supports it and two keepers' ✅ approve it.",
    ];
    return lines.filter(Boolean).join("\n");
}

const TEMPLATE = [
    "Proposal: ",
    "Budget: 20,000 sats from YYYY-MM-DD to YYYY-MM-DD",
    "For: only me, 500 sats a day",
    "Purpose: ",
    "Work: ",
    "Report: ",
].join("\n");

export function apply(ctx) {
    const React = ctx.react;
    const h = React.createElement;

    // One snapshot shared by every view, the agent tool and notifications.
    let snapshot = { state: null, error: null, loadedAt: 0 };
    const listeners = new Set();
    const publish = (next) => {
        snapshot = next;
        for (const listener of listeners) listener(snapshot);
    };
    function useSnapshot() {
        const [view, setView] = React.useState(snapshot);
        React.useEffect(() => {
            listeners.add(setView);
            setView(snapshot);
            return () => listeners.delete(setView);
        }, []);
        return view;
    }
    /** The Buzz key of whoever is looking, when the community is connected. */
    function viewer() {
        try {
            const s = ctx.relay?.snapshot?.();
            return s?.viewer ?? s?.session?.viewer ?? null;
        } catch {
            return null;
        }
    }
    const isHiveChannel = (channelId) => {
        const gov = snapshot.state?.governance;
        return Boolean(gov?.channelId && channelId === gov.channelId);
    };

    const funding = ctx.notifications.register({ id: "funding", label: "Hive funding requests" });
    const decisions = ctx.notifications.register({ id: "decisions", label: "Hive proposals waiting for keepers" });
    const announced = new Set();
    const pageTarget = { version: 1, kind: "plugin", pluginId: PLUGIN_ID, pageId: "main" };

    async function load() {
        try {
            const res = await ctx.host.request({ url: `${HIVE_API}/hive/v1/state`, timeoutMs: 15_000 });
            if (res.status !== 200) throw new Error(`the hive's host answered ${res.status}`);
            const state = JSON.parse(res.body);
            if (state?.v !== 1) throw new Error("the hive's host speaks another version");
            publish({ state, error: null, loadedAt: Date.now() });
            const me = viewer();
            const keeper = Boolean(me && state.governance?.keepers?.includes(me));
            // Each job that needs keepers is announced once; the host also deduplicates by sourceKey.
            for (const job of state.funding) {
                if (announced.has(`f:${job.jobId}`)) continue;
                announced.add(`f:${job.jobId}`);
                await funding.submit({ sourceKey: `funding:${job.jobId}`, target: pageTarget,
                    title: `${state.name}: a job needs funding`, body: `${sats(job.capSats)} for ${modelName(job.model)}, before ${when(job.deadline)}.` }).catch(() => {});
            }
            // A keeper hears once about each proposal whose discussion closed without their decision.
            if (keeper) {
                for (const p of state.governance.proposals) {
                    if (p.state !== "open" || p.discussionEnds > nowS() || p.approvals.includes(me) || announced.has(`d:${p.id}`)) continue;
                    announced.add(`d:${p.id}`);
                    await decisions.submit({ sourceKey: `decide:${p.id}`, target: pageTarget,
                        title: `${state.name}: “${p.title}” is ready for keepers`, body: `${sats(p.budgetSats)}, ${p.support} members support it. React ✅ to approve or ❌ to decline.` }).catch(() => {});
                }
            }
        } catch (e) {
            publish({ ...snapshot, error: String(e?.message ?? e) });
        }
    }

    ctx.effect(() => {
        let timer;
        let stopped = false;
        const tick = async () => {
            await load();
            // A little jitter so a community's clients do not all ask the host at once.
            if (!stopped) timer = setTimeout(tick, POLL_MS + Math.floor(Math.random() * 5_000));
        };
        timer = setTimeout(tick, Math.floor(Math.random() * 1_000));
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });

    ctx.agents.addTool({
        name: "hive_status",
        description: `The ${HIVE_NAME} hive's treasury, chip-in address, proposals, open jobs, jobs awaiting funding and provider earnings.`,
        inputSchema: { type: "object", properties: {} },
        async call() {
            if (!snapshot.state) await load();
            return summarize(snapshot.state);
        },
    });

    // ---- Shared UI ------------------------------------------------------------------------

    const muted = { color: "var(--text-subtle)" };
    const small = { fontSize: "0.9em" };
    const row = { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline", justifyContent: "space-between" };
    const list = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" };
    const item = { padding: "var(--space-2) 0", borderTop: "1px solid var(--border-standard)" };
    const pill = (text, strong) => h("span", { style: { padding: "2px 10px", borderRadius: 999, fontSize: "0.85em", whiteSpace: "nowrap",
        background: strong ? "var(--surface-sidebar-selected, var(--surface-navigation-selected))" : "var(--affordance-subtle-hover, transparent)",
        color: strong ? "var(--text-sidebar-selected, inherit)" : "inherit", border: "1px solid var(--border-standard)" } }, text);
    function Meter({ used, total }) {
        const pct = total > 0 ? Math.min(100, (100 * used) / total) : 0;
        return h("div", { role: "img", "aria-label": `${sats(used)} of ${sats(total)}`, style: { height: 6, borderRadius: 999, background: "var(--border-standard)", overflow: "hidden" } },
            h("div", { style: { width: `${pct}%`, height: "100%", background: "var(--text-standard)" } }));
    }

    function Card(props) {
        return h("section", { className: "ui-card", style: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-2)" } },
            props.title ? h("div", { style: row }, h("h2", { style: { margin: 0 } }, props.title), props.aside ?? null) : null,
            props.children);
    }

    function Copy({ text, label }) {
        const [done, setDone] = React.useState(false);
        return h("button", {
            type: "button",
            onClick: async () => {
                try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard refused */ }
            },
        }, done ? "Copied" : label ?? "Copy");
    }

    function Field({ label, value, copy }) {
        return h("div", { style: row },
            h("span", { style: muted }, label),
            h("span", { style: { display: "flex", gap: "var(--space-2)", alignItems: "baseline", minWidth: 0 } },
                h("code", { style: { overflowWrap: "anywhere" } }, value),
                copy ? h(Copy, { text: copy }) : null));
    }

    // ---- Proposals as cards in the channel ------------------------------------------------

    function ProposalCard({ message }) {
        const { state } = useSnapshot();
        const [open, setOpen] = React.useState(false);
        const p = parseProposal(message.content, message.mentions ?? []);
        if (!p) return h("p", null, message.content);
        const gov = state?.governance;
        const record = gov?.proposals.find((x) => x.eventId === message.id);
        const keepers = gov?.keepers ?? [];
        const reactors = (emojis) => new Set((message.reactions ?? []).filter((r) => emojis.includes(r.content)).flatMap((r) => r.events.map((e) => e.authorId)));
        const support = [...reactors(SUPPORT)].filter((k) => k !== message.authorId).length;
        const approvals = [...reactors(APPROVE)].filter((k) => keepers.includes(k)).length;
        const stage = record?.state ?? "open";
        const threshold = gov?.threshold ?? 2;
        const ends = record?.discussionEnds ?? message.createdAt + discussionSeconds(p.budgetSats, gov?.smallSats ?? 20000);
        const forText = p.who === "everyone" ? "Everyone" : p.who === "named" ? "Named members" : "The proposer";
        return h("div", { className: "ui-card", style: { padding: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-2)", maxWidth: 560 } },
            h("div", { style: row },
                h("strong", { style: { fontSize: "1.05em" } }, p.title),
                pill(STAGE[stage] ?? stage, stage === "running" || stage === "approved")),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                h("span", null, h("strong", null, sats(p.budgetSats))),
                h("span", { style: muted }, p.start ? `${day(p.start)} to ${day(p.end)}` : "30 days from approval"),
                h("span", { style: muted }, `${forText}${p.allowanceSats ? `, ${sats(p.allowanceSats)} a day` : ""}`)),
            h("p", { style: { margin: 0 } }, p.purpose),
            stage === "running" && record ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                h(Meter, { used: record.usedSats, total: p.budgetSats }),
                h("span", { style: { ...muted, ...small } }, `${sats(record.usedSats)} of ${sats(p.budgetSats)} used, until ${day(record.ends)}`)) : null,
            open ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                p.work ? h("p", { style: { margin: 0 } }, h("span", { style: muted }, "Work: "), p.work) : null,
                p.provider ? h("p", { style: { margin: 0 } }, h("span", { style: muted }, "Provider: "), p.provider) : null,
                p.report ? h("p", { style: { margin: 0 } }, h("span", { style: muted }, "Report: "), p.report) : null) : null,
            stage === "declined" && record?.reason ? h("p", { style: { margin: 0, ...muted } }, `Declined: ${record.reason}`) : null,
            h("div", { style: { ...row, ...muted, ...small } },
                h("span", null, `👍 ${support} · ✅ ${approvals} of ${threshold} keepers`),
                stage === "open" ? h("span", null, ends > nowS() ? `Discussion closes ${until(ends)}` : "Waiting for keepers") : null,
                (p.work || p.provider || p.report) ? h("button", { type: "button", onClick: () => setOpen(!open) }, open ? "Less" : "More") : null),
            stage === "open" ? h("span", { style: { ...muted, ...small } }, "React 👍 to support it. Keepers react ✅ to approve or ❌ to decline, with the reason in the thread.") : null);
    }

    ctx.conversation.registerMessage({
        id: "proposal",
        title: "Hive proposal",
        // Only in the hive's own channel once known; any well-formed proposal until then.
        matches: (message) => {
            const gov = snapshot.state?.governance;
            if (gov?.channelId && message.channelId !== gov.channelId) return false;
            return parseProposal(message.content) !== null;
        },
        component: ProposalCard,
    });

    // ---- In the hive's channel: a propose button and a one-line status ----------------------

    function ProposeTool(props) {
        useSnapshot(); // shown once the hive's channel is known
        if (!isHiveChannel(props.channelId) || props.threadRootId) return null;
        return h("button", {
            type: "button",
            title: "Start a proposal in this message",
            disabled: props.disabled,
            onClick: () => { if (props.insertText(TEMPLATE)) props.focus?.(); },
        }, "Propose");
    }
    ctx.conversation.registerTool({ id: "propose", title: "Propose work to the hive", order: 50, component: ProposeTool });

    function ChannelStatus(props) {
        const { state } = useSnapshot();
        if (!state || !isHiveChannel(props.channelId) || props.threadRootId) return null;
        const gov = state.governance;
        const open = gov.proposals.filter((p) => p.state === "open");
        const soonest = open.map((p) => p.discussionEnds).filter((t) => t > nowS()).sort((a, b) => a - b)[0];
        const parts = [
            `${sats(state.treasury.balanceSats)} in the treasury`,
            open.length ? `${open.length} proposal${open.length === 1 ? "" : "s"} open${soonest ? `, next decision ${until(soonest)}` : ""}` : null,
            state.funding.length ? `${state.funding.length} job${state.funding.length === 1 ? "" : "s"} waiting for keepers` : null,
        ].filter(Boolean);
        return h("div", { style: { ...row, ...muted, ...small, padding: "2px var(--space-2)" } },
            h("span", null, parts.join(" · ")),
            h("button", { type: "button", onClick: () => ctx.navigation.open(pageTarget) }, `Open ${state.name}`));
    }
    ctx.conversation.registerAccessory({ id: "status", title: "Hive status", order: 50, component: ChannelStatus });

    // ---- The hive's page ------------------------------------------------------------------

    function Treasury({ state }) {
        const chip = state.chipIn ?? {};
        return h(Card, { title: "Treasury" },
            h("p", { style: { margin: 0, fontSize: "1.6em", fontWeight: 600 } }, sats(state.treasury.balanceSats)),
            chip.lightningAddress ? h(Field, { label: "Chip in", value: chip.lightningAddress, copy: chip.lightningAddress }) : null,
            h(Field, { label: "Treasury address", value: short(state.treasury.address, 14, 8), copy: state.treasury.address }),
            h("p", { style: { margin: 0, ...muted } },
                "Pay from any Lightning or Arkade wallet. Chip-ins are donations toward the hive's purpose, and every one lands in the treasury as Bitcoin."));
    }

    function YourPart({ state }) {
        const me = viewer();
        const gov = state.governance;
        if (!gov) return null;
        const mine = allowancesFor(gov, me);
        const node = me ? gov.members?.[me]?.node : null;
        return h(Card, { title: "Your allowances" },
            !me ? h("p", { style: { margin: 0, ...muted } }, "Connect to the community to see your allowances.")
                : mine.length === 0 ? h("p", { style: { margin: 0, ...muted } }, "No running proposal includes you yet. Propose work, or ask to be named on one.")
                : h("ul", { style: list }, mine.map((p) => h("li", { key: p.id, style: item },
                    h("div", { style: row }, h("strong", null, p.title), h("span", null, `${sats(p.allowanceSats ?? 500)} a day`)),
                    h("span", { style: { ...muted, ...small } }, `until ${day(p.ends)}`)))),
            me ? (node
                ? h("p", { style: { margin: 0, ...muted } }, "Your node ", h("code", null, short(node)), " can call the model ", h("code", null, "hive"),
                    " from any OpenAI-compatible tool, or ask the hive's agent in the channel.")
                : h("p", { style: { margin: 0, ...muted } }, "To use your allowance from your own MeshLLM node, set it up as a member",
                    state.agent ? [" with ", h("code", { key: "c" }, `install-member.sh --agent ${state.agent.nodeId}`)] : null,
                    ", then post ", h("code", null, "Hive node: <your node id>"), " in the hive's channel. You can always ask the hive's agent instead.")) : null);
    }

    function ProposalRow({ p, gov, me }) {
        const keeper = Boolean(me && gov.keepers.includes(me));
        const right = p.state === "open" ? (p.discussionEnds > nowS() ? `closes ${until(p.discussionEnds)}` : "waiting for keepers")
            : p.state === "running" ? `${sats(p.usedSats)} of ${sats(p.budgetSats)}`
            : sats(p.budgetSats);
        return h("li", { style: item },
            h("div", { style: row }, h("strong", null, p.title), pill(STAGE[p.state] ?? p.state, p.state === "running")),
            p.state === "running" ? h(Meter, { used: p.usedSats, total: p.budgetSats }) : null,
            h("div", { style: { ...row, ...muted, ...small } },
                h("span", null, `${sats(p.budgetSats)} · 👍 ${p.support} · ✅ ${p.approvals.length} of ${gov.threshold}${keeper && p.state === "open" && !p.approvals.includes(me) ? " · needs your decision" : ""}`),
                h("span", null, right)),
            p.state === "declined" && p.reason ? h("span", { style: { ...muted, ...small } }, p.reason) : null);
    }

    /** Before the bot coordinates, budgets are known only by what members used from them. */
    function Budgets({ state }) {
        const used = state.proposals ?? [];
        return h(Card, { title: "Budgets in use" },
            used.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "No member has used a budget yet.")
                : h("ul", { style: list }, used.map((b) => h("li", { key: b.proposal, style: item },
                    h("div", { style: row }, h("code", null, b.proposal), h("span", null, `${sats(b.usedSats)} used`)),
                    h("span", { style: { ...muted, ...small } }, `${b.members} member${b.members === 1 ? "" : "s"}, ${b.requests} request${b.requests === 1 ? "" : "s"}, last ${when(b.lastUsedAt)}`)))),
            state.agent ? h("p", { style: { margin: 0, ...muted } }, "Members set up their node with ", h("code", null, `install-member.sh --agent ${state.agent.nodeId}`), ".") : null);
    }

    function Proposals({ state, filter }) {
        const gov = state.governance;
        const me = viewer();
        if (!gov) return h(Budgets, { state });
        const shown = gov.proposals.filter(filter);
        return h(Card, { title: "Proposals", aside: h("span", { style: muted }, `${shown.length}`) },
            shown.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "Nothing here. Propose work with the Propose button in the hive's channel.")
                : h("ul", { style: list }, shown.map((p) => h(ProposalRow, { key: p.id, p, gov, me }))));
    }

    function Funding({ state }) {
        return h(Card, { title: "Waiting for keepers" },
            state.funding.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "No job is waiting for funding.")
                : h("ul", { style: list }, state.funding.map((j) => h("li", { key: j.jobId, style: item },
                    h("div", { style: row },
                        h("strong", null, `${sats(j.capSats)} for ${modelName(j.model)}`),
                        h("span", { style: muted }, `deadline ${until(j.deadline)}`)),
                    h(Field, { label: "Send exactly", value: sats(j.capSats), copy: String(j.capSats) }),
                    h(Field, { label: "To escrow", value: short(j.escrowAddress, 14, 8), copy: j.escrowAddress }),
                    h("p", { style: { margin: 0, ...muted } },
                        `Provider ${short(j.providerPk)}. Send it in one payment from the treasury; anything else is refused and comes back after the deadline.${j.minCoinExpiry ? ` Renew the wallet's coins first if it has not done so in the last few weeks: they must be valid until ${when(j.minCoinExpiry)}.` : ""}`)))));
    }

    function Keepers({ state }) {
        const gov = state.governance;
        if (!gov) return null;
        return h(Card, { title: "Keepers", aside: h("span", { style: muted }, `${gov.threshold} of ${gov.keepers.length} approve`) },
            h("ul", { style: list }, gov.keepers.map((k) => h("li", { key: k, style: item }, h("code", null, short(k, 12, 6))))),
            h("p", { style: { margin: 0, ...muted } }, "Keepers approve proposals with ✅ in the channel and fund their jobs from the treasury with their own wallets."));
    }

    function Jobs({ state }) {
        const shown = state.jobs.slice(0, 20);
        return h(Card, { title: "Jobs" },
            shown.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "No jobs yet.")
                : h("ul", { style: list }, shown.map((j) => h("li", { key: j.jobId, style: item },
                    h("div", { style: row }, h("strong", null, modelName(j.model)), h("span", null, STATUS[j.status] ?? j.status)),
                    h("div", { style: { ...row, ...muted } },
                        h("span", null, `Provider ${short(j.providerPk ?? j.providerPeer)}`),
                        h("span", null, j.status === "claimed" ? `paid ${sats(j.paidSats)}, returned ${sats(j.returnedSats)}`
                            : j.status === "returned" ? `returned ${sats(j.returnedSats)}` : `used ${sats(j.usedSats)} of ${sats(j.capSats)}`))))));
    }

    function Providers({ state }) {
        return h(Card, { title: "Providers" },
            state.providers.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "No provider has served this hive yet.")
                : h("ul", { style: list }, state.providers.map((p) => h("li", { key: p.providerPk ?? p.providerPeer, style: item },
                    h("div", { style: row }, h("code", null, short(p.providerPk ?? p.providerPeer)), h("span", null, `earned ${sats(p.earnedSats)}`)),
                    h("div", { style: { ...row, ...muted } }, h("span", null, p.models.map(modelName).join(", ")), h("span", null, `${p.openJobs} open, ${p.jobs} total`))))));
    }

    function Flows({ state }) {
        const recent = [
            ...state.contributions.map((c) => ({ at: c.at, text: `Chip-in of ${sats(c.sats)} over ${rail(c.rail)}`, key: `c${c.reference}${c.at}` })),
            ...state.payouts.map((p) => ({ at: p.at, text: `Paid ${sats(p.sats)} to provider ${short(p.providerPk)}`, key: `p${p.txid}` })),
        ].sort((a, b) => b.at - a.at).slice(0, 15);
        return h(Card, { title: "Chip-ins and payouts" },
            recent.length === 0
                ? h("p", { style: { margin: 0, ...muted } }, "Nothing yet.")
                : h("ul", { style: list }, recent.map((r) => h("li", { key: r.key, style: { ...item, ...row } },
                    h("span", null, r.text), h("span", { style: muted }, when(r.at))))));
    }

    const TABS = [["home", "Overview"], ["proposals", "Proposals"], ["keepers", "Keepers"], ["money", "Money"]];

    function HivePage(props) {
        const view = useSnapshot();
        const [tab, setTab] = React.useState(TABS.some(([k]) => k === props?.initialTab) ? props.initialTab : "home");
        React.useEffect(() => { if (!snapshot.state) load(); }, []);
        const { state, error, loadedAt } = view;
        const me = viewer();
        const keeper = Boolean(me && state?.governance?.keepers?.includes(me));
        const waiting = keeper ? (state?.governance?.proposals ?? []).filter((p) => p.state === "open" && p.discussionEnds <= nowS() && !p.approvals.includes(me)).length + state.funding.length : 0;
        const live = (p) => ["open", "approved", "running"].includes(p.state);
        return h("div", { style: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-4)", width: "100%", boxSizing: "border-box" } },
            h("div", { style: row },
                h("h1", { style: { margin: 0 } }, state?.name ?? HIVE_NAME),
                h("span", { style: { display: "flex", gap: "var(--space-2)", alignItems: "baseline" } },
                    loadedAt ? h("span", { style: muted }, `Updated ${new Date(loadedAt).toLocaleTimeString()}`) : null,
                    h("button", { type: "button", onClick: () => load() }, "Refresh"))),
            h("div", { role: "tablist", style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)" } },
                TABS.map(([k, label]) => h("button", { key: k, type: "button", role: "tab", "aria-selected": tab === k,
                    style: tab === k ? { fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 6 } : null,
                    onClick: () => setTab(k) }, k === "keepers" && waiting ? `${label} (${waiting})` : label))),
            error ? h("p", { role: "alert", style: { margin: 0, color: "var(--text-danger)" } }, `Could not reach the hive: ${error}`) : null,
            !state
                ? h("p", { style: muted }, error ? "" : "Loading the hive…")
                : tab === "home" ? h(React.Fragment, null,
                    h(Treasury, { state }), h(YourPart, { state }),
                    state.funding.length ? h(Funding, { state }) : null,
                    h(Proposals, { state, filter: live }))
                : tab === "proposals" ? h(React.Fragment, null,
                    h(Proposals, { state, filter: live }),
                    state.governance ? h(Proposals, { state, filter: (p) => !live(p) }) : null)
                : tab === "keepers" ? h(React.Fragment, null,
                    h(Funding, { state }), h(Keepers, { state }))
                : h(React.Fragment, null,
                    h(Flows, { state }), h(Jobs, { state }), h(Providers, { state })));
    }

    ctx.pages.register({ id: "main", title: HIVE_NAME, primary: true, component: HivePage });
}
