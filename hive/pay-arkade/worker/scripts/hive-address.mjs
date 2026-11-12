// Register a hive's Lightning address on an lnurl-server, with the treasury as its offline
// Arkade receive identity, then show what a payer is offered.
//
//   node scripts/hive-address.mjs register <server> <handle> <treasury ark address> <state dir>
//   node scripts/hive-address.mjs quote <server> <handle> <sats>
//   node scripts/hive-address.mjs verify <verify url>
//   node scripts/hive-address.mjs delete <server> <handle> <state dir>
//
// The session token that owns the address and the claim key are kept in <state dir>. The claim key
// is only the covenant's receiver for recovery leaves: on lnurl-server 0.6 the server claims each
// swap through the covenant's non-interactive leaf, which can pay only the registered address.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);

async function openSession(server) {
    const controller = new AbortController();
    const res = await fetch(`${server}/lnurl/session`, { method: "POST", signal: controller.signal });
    if (!res.ok) throw new Error(`session: ${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("session closed before session_created");
        buffer += new TextDecoder().decode(value);
        const match = buffer.match(/event: session_created\ndata: (.*)\n/);
        if (match) return { ...JSON.parse(match[1]), close: () => controller.abort() };
    }
}

async function call(server, method, path, body, bearer) {
    const res = await fetch(`${server}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

if (cmd === "register") {
    let [server, handle, treasury, dir] = args;
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, "claim.key");
    if (!existsSync(keyFile)) writeFileSync(keyFile, hex.encode(secp256k1.utils.randomSecretKey()) + "\n", { mode: 0o600 });
    const secret = hex.decode(readFileSync(keyFile, "utf8").trim());
    const claimPublicKey = hex.encode(secp256k1.getPublicKey(secret, true));
    const session = await openSession(server);
    try {
        // "random" asks the server to pick the name, for servers where choosing one needs a claim code.
        const claimed = await call(server, "POST", "/lnurl/address",
            handle === "random" ? { token: session.token } : { token: session.token, username: handle });
        console.log("claim address:", claimed.status, JSON.stringify(claimed.body));
        if (claimed.status >= 300) process.exit(1);
        handle = claimed.body.username ?? claimed.body.handle ?? handle;
        const registered = await call(server, "POST", `/lnurl/address/${handle}/arkade`, { arkadeAddress: treasury, claimPublicKey }, session.token);
        console.log("register arkade identity:", registered.status, JSON.stringify(registered.body));
        writeFileSync(join(dir, "session.json"), JSON.stringify({ server, handle, token: session.token }) + "\n", { mode: 0o600 });
    } finally {
        session.close();
    }
    const pay = await call(server, "GET", `/.well-known/lnurlp/${handle}`);
    console.log("pay request:", JSON.stringify(pay.body, null, 1));
} else if (cmd === "quote") {
    const [server, handle, sats] = args;
    const pay = await call(server, "GET", `/.well-known/lnurlp/${handle}`);
    const callback = pay.body.callback;
    const q = await call(server, "GET", `${callback.replace(server, "")}?amount=${Number(sats) * 1000}`);
    console.log(JSON.stringify(q.body, null, 1));
} else if (cmd === "verify") {
    const res = await fetch(args[0]);
    console.log(await res.text());
} else if (cmd === "delete") {
    const [server, handle, dir] = args;
    const { token } = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    const res = await call(server, "DELETE", `/lnurl/address/${handle}`, undefined, token);
    console.log("delete:", res.status, JSON.stringify(res.body));
} else {
    console.error("usage: register | quote | verify | delete");
    process.exit(2);
}
