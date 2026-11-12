// End-to-end: the hive's bot posting as an authorized agent to a real, membership-gated Buzz relay
// (the self-hosted deployment from block/buzz deploy/compose, which admits agents by NIP-OA).
//
//   node test/bot-relay-e2e.mjs --relay http://localhost:3300 --owner-key-file <file with a member's
//       hex secret> --member-key-file <another member's hex secret> --buzz <path to the buzz CLI>
//
// The second part is governance: the owner proposes in the channel, the member supports it and names
// a node, both approve as keepers, and the bot coordinates; hive-api then serves what was decided.
//
// The owner's key stands in for the Buzz desktop's "Authorize external identity", which signs the
// same NIP-OA tag (empty conditions) for a pasted public key.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAuthTag } from "../bot/identity.mjs";
import { buzzCli } from "../bot/buzz.mjs";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const relay = arg("--relay", "http://localhost:3300");
const bin = arg("--buzz", "buzz");
const ownerSecret = readFileSync(arg("--owner-key-file"), "utf8").trim();
const ownerPub = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerSecret)));
const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "hive-bot-e2e-"));
const botState = join(work, "bot");
const children = [];
const step = (name, detail = {}) => console.log(`- ${name}: ${JSON.stringify(detail)}`);

function bot(...args) {
    return execFileSync("node", [join(root, "bot/hive-bot.mjs"), ...args, "--state", botState, "--buzz", bin], { encoding: "utf8" });
}

async function startApi(agentLog, extra = []) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn("node", [join(root, "api/src/server.mjs"), "--name", "E2E Hive", "--agent-log", agentLog, ...extra,
        "--treasury", "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjamec4ucczpczsplu0846wkt7l7kvxw6z6nluvq6m3a7j7h2ewh0m4zgpxr4t3",
        "--operator", "http://127.0.0.1:9", "--cache-secs", "0", "--port", String(port)], { stdio: "ignore" });
    children.push(child);
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return `http://127.0.0.1:${port}`; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("hive-api did not start");
}

async function main() {
    const owner = buzzCli({ bin, relay, secret: ownerSecret });

    // The bot's key, made on this machine.
    const init = bot("init");
    const botPub = init.match(/Bot public key: ([0-9a-f]{64})/)[1];
    step("bot key", { pubkey: botPub });

    // Without an owner's authorization the relay does not admit the bot.
    const bare = buzzCli({ bin, relay, secret: readFileSync(join(botState, "bot.key"), "utf8").trim() });
    const refused = await bare.setProfile({ name: "Hive" }).then(() => null, (e) => e.message);
    step("unauthorized bot refused", { refused: Boolean(refused), message: refused?.slice(0, 140) });
    assert.ok(refused, "a bot with no owner authorization must not be admitted");

    // The owner authorizes the key; the bot checks the authorization and keeps it.
    const tag = signAuthTag(ownerSecret, botPub);
    console.log(bot("authorize", "--auth-tag", JSON.stringify(tag)).trim());
    console.log(bot("profile", "--relay", relay, "--name", "Hive").trim());

    // The owner makes a channel and adds the bot to it as a bot.
    const created = await owner.run(["channels", "create", "--name", `hive-bot-e2e-${Date.now()}`, "--type", "stream", "--visibility", "open"]);
    const channel = created.channel_id ?? created.id ?? created.channel?.id;
    assert.match(String(channel), /^[0-9a-f-]{36}$/, JSON.stringify(created));
    await owner.run(["channels", "add-member", "--channel", channel, "--pubkey", botPub, "--role", "bot"]);
    step("channel", { channel });

    // The hive's state, served by hive-api from an agent log this test writes.
    const agentLog = join(work, "agent.jsonl");
    writeFileSync(agentLog, "");
    const governanceFile = join(work, "governance.json");
    const api = await startApi(agentLog, ["--governance", governanceFile]);
    const run = () => bot("run", "--relay", relay, "--channel", channel, "--api", api, "--once");
    const posted = (out) => out.split("\n").filter((l) => l.includes('"posted"')).map((l) => JSON.parse(l).key);

    assert.deepEqual(posted(run()), [], "a first run with nothing pending says nothing");
    const now = Math.floor(Date.now() / 1000);
    appendFileSync(agentLog, JSON.stringify({ at: now, event: "funding_requested", request: {
        job_id: "e2e-job", address: "ark1qexampleescrowaddress", cap_sats: 2000, deadline: now + 900, min_coin_expiry: now + 90_000,
        provider_pk: "ab".repeat(32), model: "example/model" } }) + "\n");
    assert.deepEqual(posted(run()), ["funding:e2e-job"]);
    appendFileSync(agentLog, JSON.stringify({ at: now + 5, event: "job_open", job_id: "e2e-job" }) + "\n");
    assert.deepEqual(posted(run()), ["open:e2e-job"]);
    assert.deepEqual(posted(run()), [], "nothing is said twice");

    // What members see in the channel: the bot as author, authorized by its owner.
    const messages = await owner.run(["messages", "get", "--channel", channel, "--limit", "10"]);
    const list = Array.isArray(messages) ? messages : messages.messages ?? messages.events ?? [];
    const fromBot = list.filter((e) => e.pubkey === botPub);
    const auth = fromBot.map((e) => e.tags.find((t) => t[0] === "auth"));
    step("channel messages", { fromBot: fromBot.length, owners: [...new Set(auth.map((t) => t?.[1]))], texts: fromBot.map((e) => e.content.slice(0, 60)) });
    assert.equal(fromBot.length, 2);
    assert.ok(auth.every((t) => t && t[1] === ownerPub), "each message carries the owner's authorization");
    assert.ok(fromBot.some((e) => e.content.startsWith("Keepers, a job is waiting for funding. Send exactly 2,000 sats to ark1qexampleescrowaddress")));
    assert.ok(fromBot.some((e) => e.content.startsWith("A job with provider abababab…abab is open: 2,000 sats in escrow for example/model")));

    await governance({ owner, channel, api, governanceFile, botPub });
    console.log("PASSED");
}

/** A proposal decided in the channel, read back by the bot and served by hive-api. */
async function governance({ owner, channel, api, governanceFile, botPub }) {
    const memberSecret = readFileSync(arg("--member-key-file"), "utf8").trim();
    const memberPub = bytesToHex(schnorr.getPublicKey(hexToBytes(memberSecret)));
    const member = buzzCli({ bin, relay, secret: memberSecret });
    await owner.run(["channels", "add-member", "--channel", channel, "--pubkey", memberPub, "--role", "member"]).catch(() => {});
    const { formatProposal } = await import("../shared/proposal.mjs");
    const text = formatProposal({ title: "Nightly issue triage", budgetSats: 12000, start: null, end: null, who: "everyone", allowanceSats: 500,
        purpose: "Label and summarize new issues each night.", work: "About 400,000 tokens a week.", provider: "", report: "A weekly summary in this channel." });
    const sent = await owner.run(["messages", "send", "--channel", channel, "--content", "-"], text);
    const proposalEvent = sent.event_id ?? sent.id ?? sent.event?.id;
    assert.match(String(proposalEvent), /^[0-9a-f]{64}$/, JSON.stringify(sent));
    const node = "cd".repeat(32);
    await member.run(["reactions", "add", "--event", proposalEvent, "--emoji", "👍"]);
    await member.run(["messages", "send", "--channel", channel, "--content", "-"], `Hive node: ${node}`);
    for (const keeper of [owner, member]) await keeper.run(["reactions", "add", "--event", proposalEvent, "--emoji", "✅"]);
    step("proposal", { event: proposalEvent.slice(0, 12) });

    // Keepers as Buzz shows them (npub) or as hex.
    const { bech32 } = await import("@scure/base");
    const ownerNpub = bech32.encode("npub", bech32.toWords(schnorr.getPublicKey(hexToBytes(ownerSecret))));
    const keepers = [ownerNpub, memberPub, botPub].join(",");
    const membersPath = join(work, "members.json");
    const coordinate = (asOf) => bot("run", "--relay", relay, "--channel", channel, "--api", api, "--once",
        "--keepers", keepers, "--governance-file", governanceFile, "--members-file", membersPath, ...(asOf ? ["--as-of", String(asOf)] : []));
    const posted = (out) => out.split("\n").filter((l) => l.includes('"posted"')).map((l) => JSON.parse(l).key);

    // Now: two approvals, but the 24-hour discussion is still open.
    assert.deepEqual(posted(coordinate()), []);
    let state = await (await fetch(`${api}/hive/v1/state`)).json();
    let p = state.governance.proposals.find((x) => x.eventId === proposalEvent);
    step("served while open", { state: p.state, support: p.support, approvals: p.approvals.length, closes: p.discussionEnds });
    assert.equal(p.state, "open");
    assert.equal(p.support, 1);
    assert.equal(p.approvals.length, 2);
    assert.equal(state.governance.members[memberPub]?.node, node);

    // A day on: approved and running; the bot says so once, and the member's node may spend.
    const later = Math.floor(Date.now() / 1000) + 86400 + 60;
    const out = coordinate(later);
    assert.deepEqual(posted(out), [`approved:${p.id}`]);
    state = await (await fetch(`${api}/hive/v1/state`)).json();
    p = state.governance.proposals.find((x) => x.eventId === proposalEvent);
    assert.equal(p.state, "running");
    const members = JSON.parse(readFileSync(membersPath, "utf8")).members;
    assert.deepEqual(members[node], { name: memberPub.slice(0, 12), proposal: p.id, allowance_sats_per_day: 500 });
    assert.deepEqual(posted(coordinate(later)), [], "approval is announced once");
    const said = (await owner.run(["messages", "get", "--channel", channel, "--limit", "5"]));
    const approval = (Array.isArray(said) ? said : said.messages ?? said.events ?? []).find((e) => e.pubkey === botPub && e.content.startsWith("Approved:"));
    step("announced", { text: approval?.content });
    assert.ok(approval, "the approval is in the channel");
}

main().catch((e) => { console.error(e); console.log("FAILED"); process.exitCode = 1; }).finally(() => children.forEach((c) => c.kill()));
