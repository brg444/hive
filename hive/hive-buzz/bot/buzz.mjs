// Talks to the community's relay through Buzz's own agent CLI (`buzz`, from block/buzz), so request
// signing, the owner authorization header, retries and any future relay auth stay Buzz's concern.
// The key and the authorization travel in the child's environment, never in its arguments.
import { spawn } from "node:child_process";

export class BuzzError extends Error {
    constructor(message, { code, stderr } = {}) {
        super(message);
        this.code = code;
        this.stderr = stderr;
    }
}

export function buzzCli({ bin = "buzz", relay, secret, authTag, timeoutMs = 60_000 }) {
    const env = {
        ...process.env,
        BUZZ_RELAY_URL: relay,
        BUZZ_PRIVATE_KEY: secret,
        BUZZ_OUTPUT_FORMAT: "json",
        ...(authTag ? { BUZZ_AUTH_TAG: JSON.stringify(authTag) } : {}),
    };
    function run(args, input) {
        return new Promise((resolve, reject) => {
            const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
            let out = "", err = "";
            const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
            child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
            child.stderr.on("data", (d) => { if (err.length < 1 << 16) err += d; });
            child.on("error", (e) => { clearTimeout(timer); reject(new BuzzError(`cannot run ${bin}: ${e.message}`)); });
            child.on("close", (code) => {
                clearTimeout(timer);
                if (code !== 0) {
                    let message = err.trim();
                    try { message = JSON.parse(message.split("\n").pop()).message ?? message; } catch { /* plain text */ }
                    return reject(new BuzzError(`buzz ${args[0]} ${args[1]} failed (exit ${code}): ${message}`, { code, stderr: err }));
                }
                try { resolve(JSON.parse(out)); } catch { resolve(out.trim()); }
            });
            child.stdin.end(input ?? "");
        });
    }
    return {
        /** Post a message; resolves only once the relay accepted it. Mentioned keys must be channel members. */
        async send(channel, text, { mentions = [], files = [] } = {}) {
            const args = ["messages", "send", "--channel", channel, "--content", "-"];
            for (const key of mentions) args.push("--mention", key);
            for (const file of files) args.push("--file", file);
            const res = await run(args, text);
            if (res?.accepted === false) throw new BuzzError(`the relay refused the message: ${res.message ?? "no reason given"}`);
            return res;
        },
        /** The channel's messages, reactions and deletions since `since`, oldest first, paging back as needed. */
        async channelEvents(channel, since) {
            const all = new Map();
            let before;
            for (let page = 0; page < 20; page++) {
                const args = ["messages", "get", "--channel", channel, "--kinds", "9,7,5", "--limit", "500", "--since", String(since)];
                if (before) args.push("--before", String(before));
                const res = await run(args);
                const rows = Array.isArray(res) ? res : [];
                for (const e of rows) all.set(e.id, e);
                if (rows.length < 500) break;
                before = Math.min(...rows.map((e) => e.created_at));
            }
            return [...all.values()].sort((a, b) => a.created_at - b.created_at);
        },
        /** Display names for keys, from their Buzz profiles; keys without one are left out. */
        async names(keys) {
            if (!keys.length) return {};
            const res = await run(["users", "get", "--pubkey", ...keys]).catch(() => []);
            const rows = Array.isArray(res) ? res : res?.users ?? res?.profiles ?? [];
            const out = {};
            for (const r of rows) {
                const key = r.pubkey ?? r.pk;
                const name = r.display_name ?? r.displayName ?? r.name ?? r.profile?.display_name ?? r.profile?.name;
                if (key && name) out[key] = String(name).slice(0, 60);
            }
            return out;
        },
        setProfile({ name, about, avatar }) {
            const args = ["users", "set-profile", "--name", name];
            if (about) args.push("--about", about);
            if (avatar) args.push("--avatar", avatar);
            return run(args);
        },
        run,
    };
}
