// End-to-end: the bot sets a hive up in a real, membership-gated Buzz relay's channel. Keepers
// volunteer with ✅, the member who authorized the bot confirms them, the bot posts the plugin built
// for the channel, the treasury and the first-proposal steps, and closes the setup once a member
// proposes; from then on it coordinates with the keepers it was given in the channel.
//
//   node test/onboard-relay-e2e.mjs --relay http://localhost:3300 --owner-key-file <file>
//       --member-key-file <file> --buzz <path to the buzz CLI>
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAuthTag } from "../bot/identity.mjs";
import { buzzCli } from "../bot/buzz.mjs";
import { formatProposal } from "../shared/proposal.mjs";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const relay = arg("--relay", "http://localhost:3300");
const bin = arg("--buzz", "buzz");
const ownerSecret = readFileSync(arg("--owner-key-file"), "utf8").trim();
const memberSecret = readFileSync(arg("--member-key-file"), "utf8").trim();
const pub = (sk) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)));
const ownerPub = pub(ownerSecret), memberPub = pub(memberSecret);
const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "hive-onboard-e2e-"));
const botState = join(work, "bot");
const children = [];
const step = (name, detail = {}) => console.log(`- ${name}: ${JSON.stringify(detail)}`);
const bot = (...args) => execFileSync("node", [join(root, "bot/hive-bot.mjs"), ...args, "--state", botState, "--buzz", bin], { encoding: "utf8" });
const record = () => JSON.parse(readFileSync(join(botState, "onboarding.json"), "utf8"));

async function startApi() {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const log = join(work, "agent.jsonl");
    writeFileSync(log, "");
    const child = spawn("node", [join(root, "api/src/server.mjs"), "--name", "Onboarding Hive", "--agent-log", log,
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
    const member = buzzCli({ bin, relay, secret: memberSecret });
    const botPub = bot("init").match(/Bot public key: ([0-9a-f]{64})/)[1];
    bot("authorize", "--auth-tag", JSON.stringify(signAuthTag(ownerSecret, botPub)));
    bot("profile", "--relay", relay, "--name", "Hive");
    const created = await owner.run(["channels", "create", "--name", `hive-onboard-${Date.now()}`, "--type", "stream", "--visibility", "open"]);
    const channel = created.channel_id ?? created.id ?? created.channel?.id;
    await owner.run(["channels", "add-member", "--channel", channel, "--pubkey", botPub, "--role", "bot"]);
    await owner.run(["channels", "add-member", "--channel", channel, "--pubkey", memberPub, "--role", "member"]).catch(() => {});
    step("channel", { channel });

    // The plugin is built for the hive's public HTTPS address; this test's hive-api is local.
    const api = await startApi();
    const run = () => bot("run", "--relay", relay, "--channel", channel, "--api", api, "--once", "--onboard", "--keepers-needed", "2", "--name", "Onboarding Hive",
        "--plugin-api", "https://hive.example.org");
    const steps = (out) => out.split("\n").filter((l) => l.includes('"onboarding"')).map((l) => JSON.parse(l).step);

    assert.deepEqual(steps(run()), ["call"]);
    assert.deepEqual(steps(run()), [], "nothing until keepers volunteer");
    for (const k of [owner, member]) await k.run(["reactions", "add", "--event", record().posts.call, "--emoji", "✅"]);
    assert.deepEqual(steps(run()), ["confirm"]);
    await member.run(["reactions", "add", "--event", record().posts.confirm, "--emoji", "✅"]);
    assert.deepEqual(steps(run()), [], "only the member who authorized the bot confirms");
    await owner.run(["reactions", "add", "--event", record().posts.confirm, "--emoji", "✅"]);
    assert.deepEqual(steps(run()), ["plugin", "treasury", "propose"]);
    assert.deepEqual(record().keepers.sort(), [ownerPub, memberPub].sort());
    assert.ok(existsSync(join(botState, "governance.json")), "coordinating with the keepers from the channel");

    // What members see.
    const said = await owner.run(["messages", "get", "--channel", channel, "--limit", "20"]);
    const fromBot = (Array.isArray(said) ? said : []).filter((e) => e.pubkey === botPub).sort((a, b) => a.created_at - b.created_at);
    const plugin = fromBot.find((e) => e.content.startsWith("Keepers are set"));
    step("plugin message", { attachment: plugin.tags.filter((t) => t[0] === "imeta").map((t) => t.find((v) => v.startsWith("url ")) ?? t[1]), mentions: plugin.tags.filter((t) => t[0] === "p").length });
    assert.ok(plugin.tags.some((t) => t[0] === "imeta"), "the plugin is attached");
    assert.ok(fromBot.some((e) => e.content.startsWith("The treasury is ready.")), "the host already has a treasury");
    for (const e of fromBot) console.log(`\n[${e.content.split("\n")[0].slice(0, 60)}…]`);

    await member.run(["messages", "send", "--channel", channel, "--content", "-"], formatProposal({ title: "Weekly summaries", budgetSats: 12000, start: null, end: null,
        who: "everyone", allowanceSats: 500, purpose: "A weekly summary of this channel.", work: "", provider: "", report: "" }));
    assert.deepEqual(steps(run()), ["done"]);
    assert.deepEqual(steps(run()), []);
    const gov = JSON.parse(readFileSync(join(botState, "governance.json"), "utf8"));
    step("governance", { keepers: gov.keepers.length, proposals: gov.proposals.map((p) => `${p.title}: ${p.state}`) });
    assert.equal(gov.proposals[0].title, "Weekly summaries");
    console.log("PASSED");
}

main().catch((e) => { console.error(e); console.log("FAILED"); process.exitCode = 1; }).finally(() => children.forEach((c) => c.kill()));
