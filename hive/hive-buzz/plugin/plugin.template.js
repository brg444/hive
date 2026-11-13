// Hive for Buzz (API v1): a hive inside its community. Members follow the treasury, propose work and
// use their allowances; keepers see what waits for them. It shows and routes and holds no keys: every
// proposal, support and approval is an ordinary Buzz message or reaction signed by its author.
//
// Where proposals stand, the plugin works out itself from the hive's channel, with the same rules
// the hive's bot uses. The treasury, jobs and payouts come from the hive's host over the one origin
// its manifest declares.
export const inject = ["react", "pages", "host", "notifications", "agents", "conversation", "relay", "navigation"];

const HIVE_API = "__HIVE_API__";
const PLUGIN_ID = "__PLUGIN_ID__";
const HIVE_NAME = "__HIVE_NAME__";
// The hive's channel and keepers, when the plugin was built with them; otherwise the host says.
const CONFIG = /*__HIVE_CONFIG__*/null;
const POLL_MS = 30_000;
const LOOKBACK_DAYS = 90;

/*__PROPOSAL__*/

/*__COORDINATOR__*/

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
const stamp = (unix) => (unix ? new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
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

/** The hive's channel and keepers: built into the plugin, or as the host reports them. */
function configFrom(state) {
    const c = CONFIG ?? (state?.governance?.channelId ? state.governance : null);
    if (!c?.channelId) return null;
    return { channelId: c.channelId, keepers: c.keepers ?? [], threshold: c.threshold ?? 2, smallSats: c.smallSats ?? 20000 };
}

/**
 * Where proposals stand. From the channel's own events when the plugin can read them, which is
 * live and needs nothing else running; from the host's record otherwise.
 */
function governanceFrom(state, events) {
    const cfg = configFrom(state);
    if (!cfg) return null;
    if (events) {
        const usage = Object.fromEntries((state?.proposals ?? []).map((b) => [b.proposal, b.usedSats]));
        const r = coordinate(events, { ...cfg, now: nowS(), usage });
        const members = Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, { node: v.node }]));
        return { ...cfg, proposals: r.proposals, members, source: "channel" };
    }
    const g = state?.governance;
    if (g?.channelId === cfg.channelId) return { ...cfg, proposals: g.proposals ?? [], members: g.members ?? {}, source: "host" };
    return { ...cfg, proposals: [], members: {}, source: "none" };
}

/** A one-line account of the hive, for agents in the community. */
function summarize(state, gov) {
    if (!state && !gov) return "The hive's state has not loaded yet.";
    const lines = [];
    if (state) {
        const open = state.jobs.filter((j) => j.status === "open");
        lines.push(
            `${state.name}: treasury ${sats(state.treasury.balanceSats)}.`,
            state.chipIn?.lightningAddress ? `Chip in at ${state.chipIn.lightningAddress}.` : null,
            `${open.length} open job(s), ${state.funding.length} awaiting funding by keepers.`,
            ...state.funding.map((j) => `- Fund ${sats(j.capSats)} to ${j.escrowAddress} for ${modelName(j.model)} (deadline ${when(j.deadline)}).`),
        );
    }
    lines.push(...(gov?.proposals ?? []).filter((p) => ["open", "approved", "running"].includes(p.state)).map((p) =>
        `- Proposal ${p.id} "${p.title}": ${STAGE[p.state]}, ${sats(p.budgetSats)}${p.state === "running" ? `, ${sats(p.usedSats)} used` : ""}, ${p.support} support, ${p.approvals.length} keeper approval(s).`));
    if (state) {
        lines.push(
            ...(gov ? [] : (state.proposals ?? []).map((b) => `- Budget ${b.proposal}: ${sats(b.usedSats)} used by ${b.members} member(s) over ${b.requests} request(s).`)),
            state.agent ? `Members install with the hive's agent's node id ${state.agent.nodeId}.` : null,
            ...state.providers.map((p) => `- Provider ${short(p.providerPk ?? p.providerPeer)}: earned ${sats(p.earnedSats)}, ${p.openJobs} open.`),
        );
    }
    lines.push(`Members propose work in the hive's channel with a message starting "Proposal:"; 👍 supports it and ${gov?.threshold ?? 2} keepers' ✅ approve it.`);
    return lines.filter(Boolean).join("\n");
}

export function apply(ctx) {
    const React = ctx.react;
    const h = React.createElement;

    // One snapshot shared by every view, the agent tool and notifications.
    let snapshot = { state: null, error: null, loadedAt: 0, gov: null };
    let channelEvents = null;
    const listeners = new Set();
    const publish = (next) => {
        snapshot = { ...next, gov: governanceFrom(next.state, channelEvents) };
        for (const listener of listeners) listener(snapshot);
        notify();
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
    const isHiveChannel = (channelId) => Boolean(channelId && snapshot.gov?.channelId === channelId);

    const funding = ctx.notifications.register({ id: "funding", label: "Hive funding requests" });
    const decisions = ctx.notifications.register({ id: "decisions", label: "Hive proposals waiting for keepers" });
    const announced = new Set();
    const pageTarget = { version: 1, kind: "plugin", pluginId: PLUGIN_ID, pageId: "main" };

    /** Each job that needs keepers, and each proposal waiting on this keeper, is announced once. */
    function notify() {
        const { state, gov } = snapshot;
        const name = state?.name ?? HIVE_NAME;
        for (const job of state?.funding ?? []) {
            if (announced.has(`f:${job.jobId}`)) continue;
            announced.add(`f:${job.jobId}`);
            funding.submit({ sourceKey: `funding:${job.jobId}`, target: pageTarget,
                title: `${name}: a job needs funding`, body: `${sats(job.capSats)} for ${modelName(job.model)}, before ${when(job.deadline)}.` })?.catch?.(() => {});
        }
        const me = viewer();
        if (!me || !gov?.keepers.includes(me)) return;
        for (const p of gov.proposals) {
            if (p.state !== "open" || p.discussionEnds > nowS() || p.approvals.includes(me) || announced.has(`d:${p.id}`)) continue;
            announced.add(`d:${p.id}`);
            decisions.submit({ sourceKey: `decide:${p.id}`, target: pageTarget,
                title: `${name}: “${p.title}” is ready for keepers`, body: `${sats(p.budgetSats)}, ${p.support} members support it. React ✅ to approve or ❌ to decline.` })?.catch?.(() => {});
        }
    }

    async function load() {
        try {
            const res = await ctx.host.request({ url: `${HIVE_API}/hive/v1/state`, timeoutMs: 15_000 });
            if (res.status !== 200) throw new Error(`the hive's host answered ${res.status}`);
            const state = JSON.parse(res.body);
            if (state?.v !== 1) throw new Error("the hive's host speaks another version");
            publish({ ...snapshot, state, error: null, loadedAt: Date.now() });
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

    // The hive's channel, read through the community connection Buzz already has: proposals,
    // reactions and deletions from the last few months, kept live as new ones arrive.
    ctx.effect(() => {
        let view = null;
        let stopView = null;
        let key = null;
        const recompute = () => {
            const events = (view?.snapshot().events ?? []).filter((e) => e.delivery !== "failed");
            channelEvents = view ? events : null;
            publish(snapshot);
        };
        const detach = () => {
            stopView?.();
            view?.dispose?.();
            view = stopView = null;
            if (channelEvents) {
                channelEvents = null;
                publish(snapshot);
            }
        };
        const attach = () => {
            let relay;
            try { relay = ctx.relay?.snapshot?.(); } catch { relay = null; }
            const cfg = configFrom(snapshot.state);
            const session = relay?.session;
            const next = cfg && typeof session?.observe === "function" ? `${relay.scope ?? relay.generation}:${cfg.channelId}` : null;
            if (next === key) return;
            key = next; // before detaching, which publishes and calls back here
            detach();
            if (!next) return;
            const since = nowS() - LOOKBACK_DAYS * 86400;
            const channel = [cfg.channelId];
            try {
                view = session.observe([
                    { kinds: [9], "#h": channel, since, limit: 1000 },
                    { kinds: [7], "#h": channel, since, limit: 2000 },
                    { kinds: [5], "#h": channel, since, limit: 500 },
                ]);
            } catch {
                view = null;
                return;
            }
            stopView = view.subscribe(recompute);
            recompute();
            view.refresh?.();
        };
        const stopRelay = ctx.relay?.subscribe?.(attach);
        listeners.add(attach);
        attach();
        // Live events reach the view while Buzz follows the channel; a refresh catches the rest.
        const refresher = setInterval(() => view?.refresh?.(), 120_000);
        return () => {
            clearInterval(refresher);
            listeners.delete(attach);
            stopRelay?.();
            detach();
        };
    });

    ctx.agents.addTool({
        name: "hive_status",
        description: `The ${HIVE_NAME} hive's treasury, chip-in address, proposals, open jobs, jobs awaiting funding and provider earnings.`,
        inputSchema: { type: "object", properties: {} },
        async call() {
            if (!snapshot.state) await load();
            return summarize(snapshot.state, snapshot.gov);
        },
    });


    // ---- Look ---------------------------------------------------------------------------
    // Buzz's own tokens throughout, so light and dark both hold; honey is Buzz's amber scale, used
    // for the hive's mark, progress and anything still waiting on the community.

    const C = {
        text: "var(--text-standard)",
        subtle: "var(--text-subtle)",
        line: "var(--border-standard)",
        strong: "var(--border-prominent)",
        inset: "var(--surface-inset)",
        panel: "var(--surface-panel)",
        honey: "var(--amber-9)",
        honeyTint: "var(--amber-3)",
        honeyInk: "var(--amber-11)",
        goodTint: "var(--surface-status-success)",
        good: "var(--text-success)",
        badTint: "var(--surface-status-danger)",
        bad: "var(--text-danger)",
        radius: "var(--radius-container)",
        chip: "var(--radius-chip)",
        pill: "var(--radius-pill)",
    };
    const muted = { color: C.subtle };
    const small = { fontSize: "0.857em" };
    const tnum = { fontVariantNumeric: "tabular-nums" };
    const row = { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "baseline", justifyContent: "space-between" };
    const stack = (gap = "var(--space-2)") => ({ display: "flex", flexDirection: "column", gap });
    const list = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" };
    const item = { padding: "var(--space-3) 0", borderTop: `1px solid ${C.line}`, display: "flex", flexDirection: "column", gap: 6 };
    const p0 = { margin: 0 };

    /** The hive's mark: one cell of the comb. */
    function Hex({ size = 14, filled = true, color = C.honey, title }) {
        return h("svg", { width: size, height: size, viewBox: "0 0 24 24", role: title ? "img" : undefined, "aria-hidden": title ? undefined : true,
            "aria-label": title, style: { flex: "none", display: "block" } },
            h("path", { d: "M12 1.8 21 7v10l-9 5.2L3 17V7z", fill: filled ? color : "none", stroke: color, strokeWidth: filled ? 0 : 1.8, strokeLinejoin: "round" }));
    }

    const TONE = {
        honey: { background: C.honeyTint, color: C.honeyInk },
        good: { background: C.goodTint, color: C.good },
        bad: { background: C.badTint, color: C.bad },
        quiet: { background: C.inset, color: C.subtle },
    };
    const STAGE_TONE = { open: "honey", approved: "good", running: "good", completed: "quiet", lapsed: "quiet", declined: "bad", withdrawn: "quiet" };
    function Pill({ tone = "quiet", children }) {
        return h("span", { style: { ...TONE[tone], padding: "2px 10px", borderRadius: C.pill, fontSize: "0.8em", fontWeight: 550, whiteSpace: "nowrap", lineHeight: 1.6 } }, children);
    }

    function Meter({ value, total, tone = "honey", label }) {
        const pct = total > 0 ? Math.max(0, Math.min(100, (100 * value) / total)) : 0;
        return h("div", { role: "img", "aria-label": label, style: { height: 6, borderRadius: C.pill, background: C.inset, overflow: "hidden" } },
            h("div", { style: { width: `${pct}%`, minWidth: pct > 0 ? 6 : 0, height: "100%", borderRadius: C.pill, background: tone === "good" ? C.good : C.honey } }));
    }

    /** n of `of` keepers approved, as cells filling in. */
    function Pips({ n, of }) {
        return h("span", { style: { display: "inline-flex", gap: 3, alignItems: "center" }, "aria-hidden": true },
            Array.from({ length: Math.max(of, n) }, (_, i) => h(Hex, { key: i, size: 12, filled: i < n, color: i < n ? C.honey : C.strong })));
    }

    function Card({ title, aside, children, tight }) {
        return h("section", { className: "ui-card", style: { padding: tight ? "var(--space-3) var(--space-4)" : "var(--space-panel-inset)", ...stack("var(--space-3)"), minWidth: 0 } },
            title ? h("div", { style: { ...row, alignItems: "center" } }, h("h2", { style: { ...p0, fontSize: "1.07em" } }, title), aside ?? null) : null,
            children);
    }

    function Empty({ children }) {
        return h("p", { style: { ...p0, ...muted } }, children);
    }

    function Copy({ text, label = "Copy" }) {
        const [done, setDone] = React.useState(false);
        return h("button", {
            type: "button",
            style: { flex: "none" },
            onClick: async () => {
                try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard refused */ }
            },
        }, done ? "Copied" : label);
    }

    /** A value to send or paste, in a well with its copy button. */
    function Well({ label, value, copy, mono = true }) {
        return h("div", { style: stack(4) },
            label ? h("span", { style: { ...muted, ...small } }, label) : null,
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "center", background: C.inset, borderRadius: C.chip, padding: "6px 6px 6px 12px", minWidth: 0 } },
                h(mono ? "code" : "span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: mono ? "0.86em" : undefined } }, value),
                copy ? h(Copy, { text: copy }) : null));
    }

    const btn = {
        primary: { background: "var(--affordance-prominent)", color: "var(--text-on-prominent)", border: "1px solid transparent", borderRadius: C.pill, padding: "6px 16px", fontWeight: 550, cursor: "pointer" },
        quiet: { background: "transparent", color: C.subtle, border: 0, padding: "2px 4px", cursor: "pointer", font: "inherit" },
    };

    // ---- Proposals as cards in the channel ------------------------------------------------

    const reactors = (message, emojis) =>
        new Set((message.reactions ?? []).filter((r) => emojis.includes(r.content)).flatMap((r) => r.events.map((e) => e.authorId)));

    function ProposalCard({ message }) {
        const { gov } = useSnapshot();
        const [open, setOpen] = React.useState(false);
        const p = parseProposal(message.content, message.mentions ?? []);
        if (!p) return h("p", { style: p0 }, message.content);
        const record = gov?.proposals.find((x) => x.eventId === message.id);
        const keepers = gov?.keepers ?? [];
        const threshold = gov?.threshold ?? 2;
        // Live from the message itself, so a reaction shows at once; the record says what was decided.
        const support = [...reactors(message, SUPPORT)].filter((k) => k !== message.authorId).length;
        const approvals = [...reactors(message, APPROVE)].filter((k) => keepers.includes(k)).length;
        const stage = record?.state ?? "open";
        const postedAt = record?.postedAt ?? message.createdAt;
        const ends = record?.discussionEnds ?? postedAt + discussionSeconds(p.budgetSats, gov?.smallSats ?? 20000);
        const forText = p.who === "everyone" ? "Everyone in the hive" : p.who === "named" ? `${p.named.length || "Named"} member${p.named.length === 1 ? "" : "s"}` : "The proposer";
        const period = p.start ? `${day(p.start)} – ${day(p.end)}` : record?.starts ? `${day(record.starts)} – ${day(record.ends)}` : "30 days from approval";
        const extra = [["Work", p.work], ["Provider", p.provider], ["Report", p.report]].filter(([, v]) => v);

        let progress = null;
        if (stage === "open") {
            const left = ends - nowS();
            progress = h("div", { style: stack(6) },
                h(Meter, { value: nowS() - postedAt, total: ends - postedAt, label: "Discussion time used" }),
                h("span", { style: { ...small, ...muted } },
                    left > 0 ? `Discussion closes ${until(ends)}` : approvals >= threshold ? "Approved, recorded on the bot's next pass" : "Discussion closed, waiting for keepers"));
        } else if (stage === "running" && record) {
            progress = h("div", { style: stack(6) },
                h(Meter, { value: record.usedSats, total: p.budgetSats, tone: "good", label: `${sats(record.usedSats)} of ${sats(p.budgetSats)} used` }),
                h("div", { style: { ...row, ...small, ...muted } },
                    h("span", { style: tnum }, `${sats(record.usedSats)} used of ${sats(p.budgetSats)}`),
                    h("span", null, `until ${day(record.ends)}`)));
        } else if (stage === "approved" && record) {
            progress = h("p", { style: { ...p0, ...small, ...muted } }, `Approved. The budget opens ${day(record.starts)}, once keepers fund its first job.`);
        } else if (stage === "declined") {
            progress = h("p", { style: { ...p0, ...small, color: C.bad } }, record?.reason ? `Declined: ${record.reason}` : "Declined by a keeper.");
        } else if (stage === "completed" && record?.report) {
            progress = h("p", { style: { ...p0, ...small } }, h("span", { style: muted }, "Report: "), record.report.text);
        }

        return h("div", { className: "ui-card", style: { ...stack("var(--space-3)"), padding: "var(--space-3) var(--space-4) var(--space-3)", maxWidth: 560, boxSizing: "border-box" } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", justifyContent: "space-between" } },
                h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", minWidth: 0 } },
                    h("div", { style: { paddingTop: 3 } }, h(Hex, { size: 16, title: "Hive proposal" })),
                    h("strong", { style: { fontSize: "1.07em", lineHeight: 1.35 } }, p.title)),
                h(Pill, { tone: STAGE_TONE[stage] }, STAGE[stage] ?? stage)),
            h("div", { style: { display: "flex", flexWrap: "wrap", columnGap: "var(--space-4)", rowGap: 4 } },
                h("span", { style: { fontWeight: 600, ...tnum } }, sats(p.budgetSats)),
                h("span", { style: muted }, period),
                h("span", { style: muted }, `${forText}${p.allowanceSats ? `, ${sats(p.allowanceSats)} a day` : ""}`)),
            h("p", { style: { ...p0, lineHeight: 1.5 } }, p.purpose),
            open && extra.length ? h("dl", { style: { ...p0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "var(--space-3)", rowGap: 4 } },
                extra.flatMap(([k, v]) => [h("dt", { key: `${k}t`, style: muted }, k), h("dd", { key: `${k}d`, style: p0 }, v)])) : null,
            progress,
            h("div", { style: { ...row, alignItems: "center", paddingTop: "var(--space-2)", borderTop: `1px solid ${C.line}` } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", ...small } },
                    h("span", { style: tnum, title: "Members who support it" }, `👍 ${support}`),
                    h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" }, title: "Keepers who approved it" },
                        h(Pips, { n: approvals, of: threshold }), h("span", { style: { ...muted, ...tnum } }, `${approvals} of ${threshold} keepers`))),
                extra.length ? h("button", { type: "button", style: { ...btn.quiet, ...small }, "aria-expanded": open, onClick: () => setOpen(!open) }, open ? "Less" : "Details") : null),
            stage === "open" ? h("span", { style: { ...muted, ...small } }, "React 👍 to support it. Keepers react ✅ to approve, or ❌ with the reason in the thread.") : null);
    }

    ctx.conversation.registerMessage({
        id: "proposal",
        title: "Hive proposal",
        // Only in the hive's own channel once known; any well-formed proposal until then.
        matches: (message) => {
            const gov = snapshot.gov;
            if (gov?.channelId && message.channelId !== gov.channelId) return false;
            return parseProposal(message.content) !== null;
        },
        component: ProposalCard,
    });

    // ---- In the hive's channel: Propose opens a form above the composer ---------------------

    // The composer tool owns insertText; the form above the composer borrows it while both are up.
    const composers = new Map();
    let proposing = null;
    const proposingListeners = new Set();
    const setProposing = (channelId) => {
        proposing = channelId;
        for (const listener of proposingListeners) listener(channelId);
    };
    function useProposing() {
        const [value, setValue] = React.useState(proposing);
        React.useEffect(() => {
            proposingListeners.add(setValue);
            setValue(proposing);
            return () => proposingListeners.delete(setValue);
        }, []);
        return value;
    }

    function ProposeTool(props) {
        useSnapshot(); // shown once the hive's channel is known
        const open = useProposing() === props.channelId;
        const here = isHiveChannel(props.channelId) && !props.threadRootId;
        React.useEffect(() => {
            if (!here) return undefined;
            const entry = { insertText: props.insertText, focus: props.focus };
            composers.set(props.channelId, entry);
            return () => { if (composers.get(props.channelId) === entry) composers.delete(props.channelId); };
        }, [here, props.channelId, props.insertText, props.focus]);
        if (!here) return null;
        return h("button", {
            type: "button",
            title: "Propose work to the hive",
            "aria-pressed": open,
            disabled: props.disabled,
            style: { display: "inline-flex", alignItems: "center", gap: 6, ...(open ? { background: C.honeyTint, color: C.honeyInk } : {}) },
            onClick: () => setProposing(open ? null : props.channelId),
        }, h(Hex, { size: 13 }), "Propose");
    }
    ctx.conversation.registerTool({ id: "propose", title: "Propose work to the hive", order: 50, component: ProposeTool });

    const field = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
    const input = { font: "inherit", color: "inherit", background: C.panel, border: `1px solid ${C.strong}`, borderRadius: C.chip, padding: "7px 10px", minWidth: 0, width: "100%", boxSizing: "border-box" };
    const label = { ...small, ...muted, fontWeight: 550 };
    const WHO = [["me", "Only me"], ["everyone", "Everyone"], ["named", "Named members"]];

    function ProposeForm({ channelId }) {
        const { state, gov } = useSnapshot();
        const [f, setF] = React.useState({ title: "", purpose: "", budget: "", start: "", end: "", who: "me", allowance: "", work: "", provider: "", report: "" });
        const [more, setMore] = React.useState(false);
        const [tried, setTried] = React.useState(false);
        const [failed, setFailed] = React.useState(null);
        const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
        const { text, problem } = proposalFromForm(f);
        const budget = Number(String(f.budget).replace(/[,\s_]/g, ""));
        const hours = budget > 0 ? discussionSeconds(budget, gov?.smallSats ?? 20000) / 3600 : null;
        const submit = (e) => {
            e?.preventDefault?.();
            setTried(true);
            if (!text) return;
            const c = composers.get(channelId);
            if (c?.insertText(text + (f.who === "named" ? "\n" : ""))) {
                c.focus?.();
                setProposing(null);
            } else {
                setFailed("The message box is not ready. Click into it and try again.");
            }
        };
        const control = (k, props = {}) => h(props.multiline ? "textarea" : "input", {
            id: `hive-${k}`, value: f[k], onChange: set(k), style: { ...input, ...(props.multiline ? { resize: "vertical", minHeight: 56 } : {}) },
            ...(props.multiline ? { rows: 2 } : { type: props.type ?? "text", inputMode: props.inputMode }), placeholder: props.placeholder,
        });
        const labelled = (k, text, el, flex) => h("label", { htmlFor: `hive-${k}`, style: { ...field, ...(flex ? { flex } : {}) } }, h("span", { style: label }, text), el);
        return h("form", { onSubmit: submit, style: { ...stack("var(--space-3)"), padding: "var(--space-3) var(--space-4)", margin: "0 0 var(--space-2)", background: C.panel,
            border: `1px solid ${C.line}`, borderRadius: C.radius, boxShadow: "var(--shadow-xs)" } },
            h("div", { style: { ...row, alignItems: "center" } },
                h("strong", { style: { display: "inline-flex", gap: 8, alignItems: "center" } }, h(Hex, { size: 16 }), `Propose work to ${state?.name ?? HIVE_NAME}`),
                h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => setProposing(null) }, "Cancel")),
            labelled("title", "Title", control("title", { placeholder: "What the work is, in a few words" })),
            labelled("purpose", "Purpose and output", control("purpose", { multiline: true, placeholder: "Why it serves the hive, what it produces and where the results go" })),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                labelled("budget", "Budget in sats", control("budget", { inputMode: "numeric", placeholder: "20,000" }), "1 1 120px"),
                labelled("start", "Starts", control("start", { type: "date" }), "1 1 140px"),
                labelled("end", "Ends", control("end", { type: "date" }), "1 1 140px")),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "flex-end" } },
                h("div", { role: "radiogroup", "aria-label": "Who uses it", style: { ...field, flex: "2 1 260px" } },
                    h("span", { style: label }, "Who uses it"),
                    h("div", { style: { display: "inline-flex", flexWrap: "wrap", gap: 4, padding: 3, background: C.inset, borderRadius: C.pill, alignSelf: "flex-start" } },
                        WHO.map(([k, text]) => h("button", { key: k, type: "button", role: "radio", "aria-checked": f.who === k,
                            style: { border: 0, borderRadius: C.pill, padding: "4px 12px", font: "inherit", cursor: "pointer", fontSize: "0.93em",
                                background: f.who === k ? C.panel : "transparent", color: f.who === k ? C.text : C.subtle, boxShadow: f.who === k ? "var(--shadow-xs)" : "none" },
                            onClick: () => setF({ ...f, who: k }) }, text)))),
                labelled("allowance", "Daily allowance per member", control("allowance", { inputMode: "numeric", placeholder: "500" }), "1 1 150px")),
            more ? h(React.Fragment, null,
                labelled("work", "Work", control("work", { placeholder: "The model and roughly how much, for example 2 million tokens on llama-3.3-70b" })),
                labelled("provider", "Provider", control("provider", { placeholder: "A member's node, if the work needs one" })),
                labelled("report", "Report", control("report", { placeholder: "How the community sees the result" }))) : null,
            h("div", { style: { ...row, alignItems: "center" } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" } },
                    h("button", { type: "submit", style: btn.primary }, "Add to message"),
                    more ? null : h("button", { type: "button", style: { ...btn.quiet, ...small }, onClick: () => setMore(true) }, "Add work, provider and report")),
                h("span", { style: { ...small, ...(tried && problem ? { color: C.bad } : muted) }, role: tried && problem ? "alert" : undefined },
                    failed ?? (tried && problem ? problem
                        : `${hours ? `Discussion runs ${hours} hours, then ` : ""}${gov?.threshold ?? 2} keepers' ✅ approve it.${f.who === "named" ? " Mention the members before you send." : ""}`))));
    }

    function ChannelStatus(props) {
        const { state, gov } = useSnapshot();
        const form = useProposing();
        if (!gov || !isHiveChannel(props.channelId) || props.threadRootId) return null;
        if (form === props.channelId) return h(ProposeForm, { channelId: props.channelId });
        const open = gov.proposals.filter((p) => p.state === "open");
        const running = gov.proposals.filter((p) => p.state === "running");
        const soonest = open.map((p) => p.discussionEnds).filter((t) => t > nowS()).sort((a, b) => a - b)[0];
        const parts = [
            state ? h("span", { key: "t", style: tnum }, h("span", { style: { color: C.text, fontWeight: 600 } }, sats(state.treasury.balanceSats)), " in the treasury") : null,
            open.length ? h("span", { key: "o" }, `${open.length} proposal${open.length === 1 ? "" : "s"} open${soonest ? `, next decision ${until(soonest)}` : ""}`) : null,
            !open.length && running.length ? h("span", { key: "r" }, `${running.length} budget${running.length === 1 ? "" : "s"} running`) : null,
            state?.funding.length ? h("span", { key: "f", style: { color: C.honeyInk } }, `${state.funding.length} job${state.funding.length === 1 ? "" : "s"} waiting for keepers`) : null,
            !open.length && !running.length && !state ? h("span", { key: "n" }, "Propose work with the button below") : null,
        ].filter(Boolean);
        return h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", ...muted, ...small, padding: "4px 6px 4px 12px", margin: "0 0 var(--space-2)",
            background: C.inset, borderRadius: C.pill } },
            h(Hex, { size: 13 }),
            h("span", { style: { display: "inline-flex", gap: "var(--space-3)", flexWrap: "wrap", flex: 1, minWidth: 0 } },
                parts.flatMap((part, i) => (i ? [h("span", { key: `s${i}`, "aria-hidden": true }, "·"), part] : [part]))),
            h("button", { type: "button", style: { ...btn.quiet, ...small, color: C.text, fontWeight: 550 }, onClick: () => ctx.navigation.open(pageTarget) }, `Open ${state?.name ?? HIVE_NAME}`));
    }
    ctx.conversation.registerAccessory({ id: "status", title: "Hive status", order: 50, component: ChannelStatus });

    // ---- The hive's page ------------------------------------------------------------------

    function Head({ state, loadedAt }) {
        const chip = state?.chipIn ?? {};
        return h("header", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "flex-end", justifyContent: "space-between" } },
            h("div", { style: { display: "flex", gap: "var(--space-3)", alignItems: "center", minWidth: 0 } },
                h(Hex, { size: 40 }),
                h("div", { style: stack(2) },
                    h("h1", { style: { ...p0, lineHeight: 1.15, display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap" } }, state?.name ?? HIVE_NAME,
                        state?.demo ? h(Pill, { tone: "quiet" }, "Sample data") : null),
                    h("span", { style: { ...muted, ...small } },
                        loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ` : "",
                        h("button", { type: "button", style: { ...btn.quiet, ...small, padding: 0, textDecoration: "underline", textUnderlineOffset: 3 }, onClick: () => load() }, "Refresh")))),
            state ? h("div", { style: { ...stack(2), alignItems: "flex-end", textAlign: "right" } },
                h("span", { style: { ...muted, ...small } }, "Treasury"),
                h("span", { style: { fontSize: "1.9em", fontWeight: 650, lineHeight: 1.1, letterSpacing: "-0.01em", ...tnum } },
                    state.treasury.balanceSats === null || state.treasury.balanceSats === undefined ? "–" : nf.format(state.treasury.balanceSats),
                    h("span", { style: { fontSize: "0.5em", fontWeight: 500, ...muted } }, " sats")),
                chip.lightningAddress ? h("span", { style: { ...small, ...muted } }, "Chip in at ", h("span", { style: { color: C.text } }, chip.lightningAddress)) : null) : null);
    }

    function Treasury({ state }) {
        const chip = state.chipIn ?? {};
        return h(Card, { title: "Chip in" },
            chip.lightningAddress ? h(Well, { label: "Lightning address", value: chip.lightningAddress, copy: chip.lightningAddress }) : null,
            h(Well, { label: "Treasury address", value: short(state.treasury.address, 14, 8), copy: state.treasury.address }),
            h("p", { style: { ...p0, ...muted, ...small } },
                "Pay from any Lightning or Arkade wallet. Chip-ins are donations toward the hive's purpose, and every one lands in the treasury as Bitcoin."));
    }

    function YourPart({ state, gov }) {
        const me = viewer();
        if (!gov) return null;
        const mine = allowancesFor(gov, me);
        const node = me ? gov.members?.[me]?.node : null;
        return h(Card, { title: "Your allowances", aside: mine.length ? h("span", { style: { ...muted, ...small } }, `${mine.length} running`) : null },
            !me ? h(Empty, null, "Connect to the community to see your allowances.")
                : mine.length === 0 ? h(Empty, null, "No running proposal includes you yet. Propose work from the hive's channel, or ask to be named on one.")
                : h("ul", { style: list }, mine.map((p, i) => h("li", { key: p.id, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("strong", null, p.title), h("span", { style: { fontWeight: 600, ...tnum } }, `${sats(p.allowanceSats ?? 500)} a day`)),
                    h(Meter, { value: p.usedSats, total: p.budgetSats, tone: "good", label: `${sats(p.usedSats)} of ${sats(p.budgetSats)} used` }),
                    h("div", { style: { ...row, ...muted, ...small } }, h("span", { style: tnum }, `${sats(p.usedSats)} of ${sats(p.budgetSats)} used by the hive`), h("span", null, `until ${day(p.ends)}`))))),
            me ? h("div", { style: { ...small, ...muted, padding: "var(--space-2) var(--space-3)", background: C.inset, borderRadius: C.chip } },
                node
                    ? ["Your node ", h("code", { key: "n" }, short(node)), " calls the model ", h("code", { key: "m" }, "hive"), " from any OpenAI-compatible tool. You can also ask the hive's agent in the channel."]
                    : ["To spend from your own MeshLLM node, set it up as a member",
                        state.agent ? [" with ", h("code", { key: "c" }, `install-member.sh --agent ${state.agent.nodeId}`)] : null,
                        ", then post ", h("code", { key: "p" }, "Hive node: <your node id>"), " in the hive's channel. You can always ask the hive's agent instead."]) : null);
    }

    /** Before the bot coordinates, budgets are known only by what members used from them. */
    function Budgets({ state }) {
        const used = state.proposals ?? [];
        return h(Card, { title: "Budgets in use" },
            used.length === 0
                ? h(Empty, null, "No member has used a budget yet.")
                : h("ul", { style: list }, used.map((b, i) => h("li", { key: b.proposal, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("code", null, b.proposal), h("span", { style: { fontWeight: 600, ...tnum } }, `${sats(b.usedSats)} used`)),
                    h("span", { style: { ...muted, ...small } }, `${b.members} member${b.members === 1 ? "" : "s"}, ${b.requests} request${b.requests === 1 ? "" : "s"}, last ${when(b.lastUsedAt)}`)))),
            state.agent ? h("p", { style: { ...p0, ...muted, ...small } }, "Members set up their node with ", h("code", null, `install-member.sh --agent ${state.agent.nodeId}`), ".") : null);
    }

    function ProposalRow({ p, gov, me, first }) {
        const keeper = Boolean(me && gov.keepers.includes(me));
        const needsMe = keeper && p.state === "open" && p.discussionEnds <= nowS() && !p.approvals.includes(me);
        const right = p.state === "open" ? (p.discussionEnds > nowS() ? `closes ${until(p.discussionEnds)}` : "waiting for keepers")
            : p.state === "running" ? `until ${day(p.ends)}`
            : p.state === "approved" ? `opens ${day(p.starts)}`
            : day(p.postedAt);
        return h("li", { style: { ...item, ...(first ? { borderTop: 0, paddingTop: 0 } : {}) } },
            h("div", { style: { display: "flex", gap: "var(--space-2)", alignItems: "flex-start", justifyContent: "space-between" } },
                h("strong", { style: { lineHeight: 1.35 } }, p.title),
                h(Pill, { tone: needsMe ? "honey" : STAGE_TONE[p.state] }, needsMe ? "Needs your decision" : STAGE[p.state] ?? p.state)),
            p.state === "running" ? h(Meter, { value: p.usedSats, total: p.budgetSats, tone: "good", label: `${sats(p.usedSats)} of ${sats(p.budgetSats)} used` }) : null,
            h("div", { style: { ...row, ...muted, ...small, alignItems: "center" } },
                h("span", { style: { display: "inline-flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap", ...tnum } },
                    h("span", { style: { color: C.text, fontWeight: 600 } }, p.state === "running" ? `${sats(p.usedSats)} of ${sats(p.budgetSats)}` : sats(p.budgetSats)),
                    h("span", null, `👍 ${p.support}`),
                    h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } }, h(Pips, { n: p.approvals.length, of: gov.threshold }), `${p.approvals.length} of ${gov.threshold}`)),
                h("span", null, right)),
            p.state === "declined" && p.reason ? h("span", { style: { ...small, color: C.bad } }, p.reason) : null);
    }

    function Proposals({ state, gov, filter, title = "Proposals", empty }) {
        const me = viewer();
        if (!gov) return state ? h(Budgets, { state }) : null;
        const shown = gov.proposals.filter(filter);
        return h(Card, { title, aside: h("span", { style: { ...muted, ...small } }, `${shown.length}`) },
            shown.length === 0
                ? h(Empty, null, empty ?? "Nothing here. Propose work with the Propose button in the hive's channel.")
                : h("ul", { style: list }, shown.map((p, i) => h(ProposalRow, { key: p.id, p, gov, me, first: i === 0 }))));
    }

    function Funding({ state }) {
        return h(Card, { title: "Jobs to fund", aside: state.funding.length ? h(Pill, { tone: "honey" }, `${state.funding.length} waiting`) : null },
            state.funding.length === 0
                ? h(Empty, null, "No job is waiting for funding.")
                : h("ul", { style: list }, state.funding.map((j, i) => h("li", { key: j.jobId, style: { ...item, gap: "var(--space-3)", ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: { ...row, alignItems: "center" } },
                        h("strong", { style: tnum }, `${sats(j.capSats)} for ${modelName(j.model)}`),
                        h("span", { style: { ...muted, ...small } }, `deadline ${until(j.deadline)}`)),
                    h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-3)" } },
                        h("div", { style: { flex: "1 1 170px" } }, h(Well, { label: "Send exactly", value: sats(j.capSats), copy: String(j.capSats), mono: false })),
                        h("div", { style: { flex: "3 1 260px", minWidth: 0 } }, h(Well, { label: "To escrow", value: short(j.escrowAddress, 14, 8), copy: j.escrowAddress }))),
                    h("p", { style: { ...p0, ...muted, ...small } },
                        `For provider ${short(j.providerPk)}. Send it in one payment from the treasury; anything else comes back after the deadline.${j.minCoinExpiry ? ` The coins you send must be valid until ${day(j.minCoinExpiry)}, so renew the wallet first if it has not renewed in a few weeks.` : ""}`)))));
    }

    function Keepers({ gov }) {
        if (!gov) return null;
        const me = viewer();
        return h(Card, { title: "Keepers", aside: h("span", { style: { ...muted, ...small } }, `${gov.threshold} of ${gov.keepers.length} approve`) },
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)" } },
                gov.keepers.map((k) => h("span", { key: k, style: { display: "inline-flex", gap: 8, alignItems: "center", padding: "5px 12px 5px 8px", background: C.inset, borderRadius: C.pill } },
                    h(Hex, { size: 14, filled: k === me }), h("code", { style: small }, short(k, 8, 4)), k === me ? h("span", { style: { ...small, ...muted } }, "you") : null))),
            h("p", { style: { ...p0, ...muted, ...small } }, "Keepers approve proposals with ✅ in the channel and fund their jobs from the treasury with their own wallets."));
    }

    function Jobs({ state }) {
        const shown = state.jobs.slice(0, 20);
        const tone = { claimed: "good", returned: "quiet", open: "honey", awaiting_funding: "honey", declined: "bad", lapsed: "quiet" };
        return h(Card, { title: "Jobs" },
            shown.length === 0
                ? h(Empty, null, "No jobs yet.")
                : h("ul", { style: list }, shown.map((j, i) => h("li", { key: j.jobId, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: { ...row, alignItems: "center" } }, h("strong", null, modelName(j.model)), h(Pill, { tone: tone[j.status] }, STATUS[j.status] ?? j.status)),
                    h("div", { style: { ...row, ...muted, ...small } },
                        h("span", null, `Provider ${short(j.providerPk ?? j.providerPeer)}`),
                        h("span", { style: tnum }, j.status === "claimed" ? `paid ${sats(j.paidSats)}, returned ${sats(j.returnedSats)}`
                            : j.status === "returned" ? `returned ${sats(j.returnedSats)}` : `used ${sats(j.usedSats)} of ${sats(j.capSats)}`))))));
    }

    function Providers({ state }) {
        return h(Card, { title: "Providers" },
            state.providers.length === 0
                ? h(Empty, null, "No provider has served this hive yet.")
                : h("ul", { style: list }, state.providers.map((p, i) => h("li", { key: p.providerPk ?? p.providerPeer, style: { ...item, ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("div", { style: row }, h("code", null, short(p.providerPk ?? p.providerPeer)), h("span", { style: { fontWeight: 600, ...tnum } }, `earned ${sats(p.earnedSats)}`)),
                    h("div", { style: { ...row, ...muted, ...small } }, h("span", null, p.models.map(modelName).join(", ")), h("span", null, `${p.openJobs} open, ${p.jobs} total`))))));
    }

    function Flows({ state }) {
        const recent = [
            ...state.contributions.map((c) => ({ at: c.at, sats: c.sats, in: true, text: `Chip-in over ${rail(c.rail)}`, key: `c${c.reference}${c.at}` })),
            ...state.payouts.map((p) => ({ at: p.at, sats: p.sats, in: false, text: `Paid provider ${short(p.providerPk)}`, key: `p${p.txid}` })),
        ].sort((a, b) => b.at - a.at).slice(0, 15);
        return h(Card, { title: "Chip-ins and payouts" },
            recent.length === 0
                ? h(Empty, null, "Nothing yet.")
                : h("ul", { style: list }, recent.map((r, i) => h("li", { key: r.key, style: { ...item, ...row, flexDirection: "row", alignItems: "baseline", ...(i === 0 ? { borderTop: 0, paddingTop: 0 } : {}) } },
                    h("span", { style: stack(2) }, h("span", null, r.text), h("span", { style: { ...muted, ...small } }, stamp(r.at))),
                    h("span", { style: { fontWeight: 600, ...tnum, color: r.in ? C.good : C.text } }, `${r.in ? "+" : "−"}${sats(r.sats)}`)))));
    }

    const TABS = [["home", "Overview"], ["proposals", "Proposals"], ["keepers", "Keepers"], ["money", "Money"]];
    const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: "var(--space-4)", alignItems: "start" };

    function HivePage(props) {
        const view = useSnapshot();
        const [tab, setTab] = React.useState(TABS.some(([k]) => k === props?.initialTab) ? props.initialTab : "home");
        React.useEffect(() => { if (!snapshot.state) load(); }, []);
        const { state, gov, error, loadedAt } = view;
        const me = viewer();
        const keeper = Boolean(me && gov?.keepers.includes(me));
        const decide = keeper ? gov.proposals.filter((p) => p.state === "open" && p.discussionEnds <= nowS() && !p.approvals.includes(me)) : [];
        const waiting = keeper ? decide.length + (state?.funding.length ?? 0) : 0;
        const live = (p) => ["open", "approved", "running"].includes(p.state);
        const col = (...children) => h("div", { style: stack("var(--space-4)") }, ...children);
        const needsHost = h(Card, null, h(Empty, null, error ? "The hive's host is out of reach, so the treasury and jobs are not shown." : "Loading the treasury…"));
        let body = null;
        if (state || gov) {
            body = tab === "home" ? h("div", { style: grid },
                    col(h(YourPart, { state: state ?? {}, gov }), gov || state ? h(Proposals, { state, gov, filter: live, title: "Live proposals" }) : null),
                    col(state?.funding.length ? h(Funding, { state }) : null, state ? h(Treasury, { state }) : needsHost))
                : tab === "proposals" ? col(
                    h(Proposals, { state, gov, filter: live, title: "Live proposals" }),
                    gov ? h(Proposals, { state, gov, filter: (p) => !live(p), title: "Past proposals", empty: "None yet." }) : null)
                : tab === "keepers" ? col(
                    keeper ? h(Proposals, { state, gov, filter: (p) => decide.includes(p), title: "Waiting for your decision", empty: "No proposal needs your decision." }) : null,
                    state ? h(Funding, { state }) : needsHost, h(Keepers, { gov }))
                : state ? h("div", { style: grid }, col(h(Flows, { state }), h(Jobs, { state })), col(h(Providers, { state })))
                : needsHost;
        }
        return h("div", { style: { padding: "var(--space-panel-inset)", ...stack("var(--space-5, 20px)"), width: "100%", maxWidth: 1080, boxSizing: "border-box" } },
            h(Head, { state, loadedAt }),
            h("div", { role: "tablist", style: { display: "inline-flex", flexWrap: "wrap", gap: 4, padding: 3, background: C.inset, borderRadius: C.pill, alignSelf: "flex-start" } },
                TABS.map(([k, text]) => h("button", { key: k, type: "button", role: "tab", "aria-selected": tab === k,
                    style: { border: 0, borderRadius: C.pill, padding: "5px 14px", font: "inherit", cursor: "pointer", display: "inline-flex", gap: 6, alignItems: "center",
                        background: tab === k ? C.panel : "transparent", color: tab === k ? C.text : C.subtle, fontWeight: tab === k ? 600 : 500, boxShadow: tab === k ? "var(--shadow-xs)" : "none" },
                    onClick: () => setTab(k) }, text,
                    k === "keepers" && waiting ? h("span", { style: { ...TONE.honey, borderRadius: C.pill, padding: "0 7px", fontSize: "0.8em", fontWeight: 600, ...tnum } }, `${waiting}`) : null))),
            error ? h("p", { role: "alert", style: { ...p0, color: C.bad } }, `Could not reach the hive: ${error}`) : null,
            !state && !gov ? h("p", { style: muted }, error ? "" : "Loading the hive…") : body);
    }

    ctx.pages.register({ id: "main", title: HIVE_NAME, primary: true, component: HivePage });
}
