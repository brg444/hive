#!/usr/bin/env node
// The hive's bot: a Buzz agent identity that posts what happens in the hive into its channel. It
// reads only the hive's public state and holds only its own Buzz key, so it can run anywhere that
// reaches hive-api, apart from the machine that holds the hive's receipt key.
//
//   hive-bot init      --state <dir>
//   hive-bot authorize --state <dir> --auth-tag '<JSON from Buzz>'      (or --auth-tag - for stdin)
//   hive-bot profile   --state <dir> --relay <community URL> [--name Hive] [--about <text>]
//   hive-bot run       --state <dir> --relay <community URL> --channel <channel UUID>
//                      --api <hive-api base URL> [--interval 60] [--low-treasury-sats 0] [--once]
//                      [--keepers <npub or hex, comma-separated> [--threshold 2] [--small-sats 20000] [--members-file <path>]
//                       [--governance-file <path>] [--since-days 90] [--as-of <unix seconds>]]
//
// With --keepers the bot also coordinates: it reads proposals, reactions and replies in the channel,
// writes where each proposal stands to the governance file (which hive-api serves to the plugin), and
// writes the agent's members file from the running proposals. --as-of judges proposals as of another
// time, for rehearsing a decision without waiting out its discussion.
//
//   hive-bot seed      --state <dir> --channel <channel UUID> --keepers <npub or hex, ...> [--threshold 2]
//
// seed writes a governance file with the channel and keepers and no proposals, without touching
// the relay, so the plugin can be tried in a channel before the bot runs: proposals typed there show
// as cards with live counts, and the Propose button and status line appear.
//
//   hive-bot run ... --onboard [--keepers-needed 3] [--threshold 2] [--name "Hive"] [--plugin-api <HTTPS address>]
//
// --onboard sets the hive up in its channel, step by step: it asks who will keep the treasury
// (each keeper reacts ✅), has the member who authorized the bot confirm them, posts the plugin built
// for that channel and those keepers, says what happens with the treasury, and walks members through
// the first proposal. Once keepers are confirmed, the bot coordinates with them as with --keepers.
// The plugin calls hive-api at --plugin-api, its public HTTPS address, when the bot reaches it at
// another (--api http://127.0.0.1:8787 on the same host, say).
//
// Every command takes --buzz <path to the buzz CLI>. Without it the bot uses the one inside the Buzz
// desktop app when installed (macOS), else buzz on PATH.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkAuthTag, loadAuthTag, loadOrCreateKey, saveAuthTag } from "./identity.mjs";
import { markSaid, plan } from "./announce.mjs";
import { buzzCli } from "./buzz.mjs";
import { coordinate, membersFile } from "./coordinator.mjs";
import { EMPTY, onboardingPlan } from "./onboard.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bech32 } from "@scure/base";

const [command, ...argv] = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const die = (message, code = 1) => { console.error(`hive-bot: ${message}`); process.exit(code); };
const log = (event) => console.log(JSON.stringify({ at: Math.floor(Date.now() / 1000), ...event }));

const stateDir = arg("--state") ?? die("--state <dir> is required", 2);

function authorized(key) {
    const auth = loadAuthTag(stateDir, key.pubkey);
    if (!auth) die("this bot is not authorized yet: run `hive-bot init` for the steps");
    return auth;
}

function client(key, auth) {
    const relay = arg("--relay") ?? die("--relay <community URL> is required", 2);
    return buzzCli({ bin: buzzBinary(), relay, secret: key.secret, authTag: auth.tag });
}

/**
 * The buzz CLI: --buzz when given, else the copy the Buzz desktop app ships inside itself, else
 * `buzz` on PATH. With Buzz installed there is nothing to build.
 */
function buzzBinary() {
    if (arg("--buzz")) return arg("--buzz");
    const home = process.env.HOME ?? "";
    const bundled = [
        "/Applications/Buzz.app/Contents/Resources/bin/buzz",
        join(home, "Applications/Buzz.app/Contents/Resources/bin/buzz"),
    ].find((path) => existsSync(path));
    return bundled ?? "buzz";
}

async function fetchState(api) {
    const res = await fetch(`${api.replace(/\/+$/, "")}/hive/v1/state`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`hive-api answered ${res.status}`);
    return res.json();
}

/** A keeper as Buzz shows them (npub1...) or as hex; null when it is neither. */
function keeperKey(text) {
    const k = text.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(k)) return k;
    try {
        const { prefix, words } = bech32.decode(k);
        const bytes = bech32.fromWords(words);
        if (prefix === "npub" && bytes.length === 32) return Buffer.from(bytes).toString("hex");
    } catch { /* not an npub */ }
    return null;
}

const recordPath = () => join(stateDir, "said.json");
const loadRecord = () => (existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), "utf8")) : null);
function saveRecord(record) {
    const tmp = `${recordPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, recordPath());
}

function writeAtomic(path, value) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
}

/** Read the channel and write where proposals stand, plus the agent's members file. */
async function coordinateOnce(buzz, channel, state, gov) {
    const clock = Math.floor(Date.now() / 1000);
    const now = gov.asOf ?? clock;
    const events = await buzz.channelEvents(channel, clock - gov.sinceDays * 86400);
    const usage = Object.fromEntries((state.proposals ?? []).map((p) => [p.proposal, p.usedSats]));
    const result = coordinate(events, { keepers: gov.keepers, threshold: gov.threshold, smallSats: gov.smallSats, now, usage });
    const governance = { v: 1, channelId: channel, keepers: gov.keepers, threshold: gov.threshold, smallSats: gov.smallSats, updatedAt: now,
        proposals: result.proposals, members: Object.fromEntries(Object.entries(result.nodes).map(([k, v]) => [k, { node: v.node }])) };
    writeAtomic(gov.governanceFile, governance);
    if (gov.membersFile) writeAtomic(gov.membersFile, membersFile(result));
    log({ event: "coordinated", proposals: result.proposals.length, members: Object.keys(result.nodes).length });
    return governance;
}

const onboardingPath = () => join(stateDir, "onboarding.json");
const loadOnboarding = () => (existsSync(onboardingPath()) ? JSON.parse(readFileSync(onboardingPath(), "utf8")) : null);
const eventIdOf = (sent) => sent?.event_id ?? sent?.id ?? sent?.event?.id ?? null;

/** The plugin for this channel and these keepers, zipped for posting. */
function pluginZip({ api, name, channel, keepers, threshold, smallSats }) {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = join(stateDir, "plugin");
    const dir = execFileSync(process.execPath, [join(here, "../plugin/build.mjs"), "--api", api, "--name", name, "--out", out,
        "--channel", channel, "--keepers", keepers.join(","), "--threshold", String(threshold), "--small-sats", String(smallSats)], { encoding: "utf8" }).trim();
    const folder = dir.split("/").pop();
    const zip = join(out, `${folder}.zip`);
    execFileSync("zip", ["-qr", "-FS", zip, folder], { cwd: out });
    return zip;
}

/** One onboarding pass: post the next steps, recording each decision only once its message is accepted. */
async function onboardOnce(buzz, channel, state, ob) {
    const events = await buzz.channelEvents(channel, Math.floor(Date.now() / 1000) - 30 * 86400);
    let record = loadOnboarding() ?? { ...EMPTY, startedAt: Math.floor(Date.now() / 1000) };
    const proposals = record.keepers
        ? coordinate(events, { keepers: record.keepers, threshold: record.threshold, smallSats: ob.smallSats }).proposals : [];
    // Names for the people a post may mention: volunteers so far and the founder.
    const keys = [...new Set([ob.founder, ...events.filter((e) => e.kind === 7).map((e) => e.pubkey)])];
    const names = await buzz.names(keys);
    const { posts, record: next } = onboardingPlan(record, { events, bot: ob.bot, founder: ob.founder, needed: ob.needed, threshold: ob.threshold,
        smallSats: ob.smallSats, state, proposals, name: (k) => names[k] ?? k.slice(0, 8) });
    for (const post of posts) {
        const files = post.plugin ? [pluginZip({ api: ob.api, name: state?.name ?? ob.name, channel, keepers: next.keepers, threshold: next.threshold, smallSats: ob.smallSats })] : [];
        const sent = await buzz.send(channel, post.text, { mentions: post.mentions ?? [], files });
        record = { ...record, posts: { ...record.posts, [post.key]: eventIdOf(sent) ?? true } };
        if (post.key === "plugin") record = { ...record, keepers: next.keepers, threshold: next.threshold };
        if (post.key.startsWith("treasury")) record = { ...record, treasuryReady: next.treasuryReady };
        if (post.key === "done") record = { ...record, done: true };
        writeAtomic(onboardingPath(), record);
        log({ event: "onboarding", step: post.key });
    }
    return record;
}

/** One pass: fetch, plan, post in order; each message is recorded only once the relay accepts it. */
async function tick(buzz, channel, api, lowTreasurySats, gov, ob) {
    // While onboarding, the host may not be up yet; the steps that need it wait for it.
    const state = await fetchState(api).catch((e) => { if (!ob) throw e; return null; });
    if (ob && !loadOnboarding()?.done) await onboardOnce(buzz, channel, state, ob);
    const keepers = gov ?? (ob && loadOnboarding()?.keepers ? { ...ob.gov, keepers: loadOnboarding().keepers, threshold: loadOnboarding().threshold } : null);
    if (!state) return 0;
    if (keepers) state.governance = await coordinateOnce(buzz, channel, state, keepers);
    const { posts, record, newBudgets } = plan(state, loadRecord(), { lowTreasurySats });
    let current = record;
    saveRecord(current);
    for (const post of posts) {
        await buzz.send(channel, post.text);
        current = markSaid(current, post, newBudgets);
        saveRecord(current);
        log({ event: "posted", key: post.key });
    }
    return posts.length;
}

async function main() {
    if (command === "init") {
        const key = loadOrCreateKey(stateDir);
        const auth = loadAuthTag(stateDir, key.pubkey);
        console.log(`Bot public key: ${key.pubkey}`);
        if (auth) {
            console.log(`Authorized by ${auth.owner}.`);
        } else {
            console.log("\nTo let it post, an owner authorizes this key in the Buzz desktop app:");
            console.log("  Settings → Buzz → Security → Authorize external identity, paste the key above,");
            console.log("  then copy the authorization Buzz shows and run:");
            console.log(`  hive-bot authorize --state ${stateDir} --auth-tag '<the authorization>'`);
            console.log("\nAuthorize it from an identity that runs no Buzz coding agents: Buzz lets the holder of an");
            console.log("authorized key direct the owner's coding agents.");
        }
        return;
    }
    if (command === "authorize") {
        const key = loadOrCreateKey(stateDir);
        let raw = arg("--auth-tag") ?? die("--auth-tag '<JSON>' is required", 2);
        if (raw === "-") raw = readFileSync(0, "utf8");
        let checked;
        try { checked = checkAuthTag(raw.trim(), key.pubkey); } catch (e) { die(e.message); }
        if (checked.conditions) console.log(`Note: this authorization is limited to ${checked.conditions}.`);
        saveAuthTag(stateDir, checked.tag);
        console.log(`Authorized by ${checked.owner}. Next: hive-bot profile, then add ${key.pubkey} to the channel as a bot.`);
        return;
    }
    if (command === "profile") {
        const key = loadOrCreateKey(stateDir);
        const buzz = client(key, authorized(key));
        await buzz.setProfile({
            name: arg("--name", "Hive"),
            about: arg("--about", "Posts what happens in the hive: funding requests, jobs, payouts, returns and chip-ins."),
            avatar: arg("--avatar"),
        });
        console.log("Profile published.");
        return;
    }
    if (command === "seed") {
        const channel = arg("--channel") ?? die("--channel <UUID> is required", 2);
        const keepers = (arg("--keepers") ?? die("--keepers is required", 2)).split(",").map(keeperKey);
        if (keepers.some((k) => !k)) die("--keepers takes npub1... or 64-hex keys, comma-separated", 2);
        const path = arg("--governance-file", join(stateDir, "governance.json"));
        mkdirSync(dirname(path), { recursive: true });
        writeAtomic(path, { v: 1, channelId: channel, keepers, threshold: Number(arg("--threshold", "2")), smallSats: Number(arg("--small-sats", "20000")),
            updatedAt: Math.floor(Date.now() / 1000), proposals: [], members: {} });
        console.log(`Wrote ${path}. Start hive-api with --governance ${path}.`);
        return;
    }
    if (command === "run") {
        const key = loadOrCreateKey(stateDir);
        const buzz = client(key, authorized(key));
        const channel = arg("--channel") ?? die("--channel <UUID> is required", 2);
        const api = arg("--api") ?? die("--api <hive-api base URL> is required", 2);
        const interval = Math.max(15, Number(arg("--interval", "60"))) * 1000;
        const low = Number(arg("--low-treasury-sats", "0"));
        const keepers = arg("--keepers");
        const govBase = {
            threshold: Number(arg("--threshold", "2")),
            smallSats: Number(arg("--small-sats", "20000")),
            sinceDays: Number(arg("--since-days", "90")),
            governanceFile: arg("--governance-file", join(stateDir, "governance.json")),
            membersFile: arg("--members-file"),
            asOf: arg("--as-of") ? Number(arg("--as-of")) : null,
        };
        const gov = keepers ? { ...govBase, keepers: keepers.split(",").map(keeperKey).filter(Boolean) } : null;
        if (gov && gov.keepers.length < gov.threshold) die("--keepers needs at least --threshold valid public keys", 2);
        const ob = flag("--onboard") ? {
            api: arg("--plugin-api", api), gov: govBase, bot: key.pubkey, founder: authorized(key).owner, name: arg("--name", "Hive"),
            needed: Number(arg("--keepers-needed", "3")), threshold: govBase.threshold, smallSats: govBase.smallSats,
        } : null;
        if (ob && !(ob.needed >= ob.threshold && ob.threshold >= 1)) die("--keepers-needed must be at least --threshold", 2);
        let failures = 0;
        for (;;) {
            try {
                await tick(buzz, channel, api, low, gov, ob);
                failures = 0;
            } catch (e) {
                failures += 1;
                log({ event: "error", error: e.message });
                if (flag("--once")) process.exit(1);
            }
            if (flag("--once")) return;
            // Back off on repeated failures, up to ten intervals, with jitter so restarts spread out.
            const wait = interval * Math.min(10, 2 ** Math.min(failures, 4)) * (0.9 + Math.random() * 0.2);
            await new Promise((r) => setTimeout(r, failures ? wait : interval * (0.9 + Math.random() * 0.2)));
        }
    }
    die("usage: hive-bot init|authorize|profile|seed|run --state <dir> ...", 2);
}

main().catch((e) => die(e.message));
