/**
 * The v5 treasury on a local regtest stack, through @hive/treasury and @hive/executor, with the
 * operator's default fees:
 *
 *   1. Two keepers make passkeys in a browser (Chromium's virtual authenticator, with PRF); the
 *      third holds a raw P-256 key. Hive builds the treasury from them, and its address is the one
 *      the SDK builds from the same artifact.
 *   2. The host issues the counter and funds the treasury with the whole supply; a member chips in.
 *   3. Two keepers approve a payment; anyone merges the chip-in; the approvals still pay.
 *   4. The same approvals pay nothing twice; one keeper alone, another recipient, or an approval
 *      past its lapse time pays nothing.
 *   5. A stranger cannot renew the treasury; the delegatee can, and the treasury pays its fee.
 *   6. A payment approved before the renewal pays after it.
 *
 * Needs the regtest stack (arkd on 7070, the Emulator on 7073) and Playwright's Chromium:
 *
 *   node --experimental-eventsource --import tsx test/treasury-v5-regtest.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type Artifact, instantiate } from "@hive/ark";
import {
  type CovenantApproval,
  mergeIntoTreasury,
  payFromTreasury,
  type TreasuryCoin,
  treasuryClient,
  treasuryContract,
  unitsOn,
} from "@hive/executor";
import { hex } from "@hive/kit";
import {
  bitcoinKeyOf,
  counterOf,
  KEY_SALT,
  keeperKey,
  keeperKeyFromSpki,
  PASSKEY,
  type Payment,
  passkeyApproval,
  payMessage,
  RAW_P256,
  rawApproval,
  recipientOf,
  sdkArguments,
  TREASURY_ARTIFACT,
  type TreasuryTerms,
  treasuryArguments,
} from "@hive/treasury";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chromium, type Page } from "./support/keeper-console.js";
import { newWallet, renewAsDelegatee, sendOffchain, waitFor } from "./support/treasury-sdk.js";

const ARKD = "http://localhost:7070";
const EMULATOR = "http://localhost:7073";
const SUPPLY = 1_000_000n;
const MAX_FEE = 2_000;
const now = () => Math.floor(Date.now() / 1000);

const info = (await (await fetch(`${ARKD}/v1/info`)).json()) as {
  signerPubkey: string;
  unilateralExitDelay: string;
  fees?: unknown;
};
const emulatorKey = ((await (await fetch(`${EMULATOR}/v1/info`)).json()) as { signerPubkey: string })
  .signerPubkey;
step("operator", { fees: info.fees });
const client = await treasuryClient({ network: "regtest", arkdUrl: ARKD, emulatorUrl: EMULATOR });

// 1. The keepers, and the treasury Hive builds from them.
const site = await serveBlankPage();
const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
const maya = await passkeyDevice("maya");
const jonas = await passkeyDevice("jonas");
const priyaSecret = p256.utils.randomSecretKey();
const priya = {
  key: keeperKey(p256.getPublicKey(priyaSecret, true)),
  bitcoinKey: secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
};
const delegate = secp256k1.utils.randomSecretKey();

const host = await newWallet(ARKD, EMULATOR);
sendOffchain(await host.getAddress(), 20_000);
await waitFor("the host's funds", async () => (await host.getBalance()).available >= 20_000);
const { assetId } = await host.assetManager.issue({ amount: SUPPLY } as never);
const counter = counterOf(assetId);
step("counter issued by the host", { assetId });

const terms: TreasuryTerms = {
  keepers: [
    { kind: PASSKEY, key: hex(maya.key), bitcoinKey: hex(maya.bitcoinKey), site: "localhost" },
    { kind: PASSKEY, key: hex(jonas.key), bitcoinKey: hex(jonas.bitcoinKey), site: "localhost" },
    { kind: RAW_P256, key: hex(priya.key), bitcoinKey: hex(priya.bitcoinKey), site: "localhost" },
  ],
  counter,
  delegateKey: hex(secp256k1.getPublicKey(delegate, true)),
  renewalWindowSeconds: 30 * 86_400,
  maxFeeSats: MAX_FEE,
  exitDelaySeconds: Number(info.unilateralExitDelay),
};
const treasury = treasuryContract(client, TREASURY_ARTIFACT, sdkArguments(terms));
const hive = instantiate(TREASURY_ARTIFACT as unknown as Artifact, treasuryArguments(terms), {
  server: info.signerPubkey,
  emulator: emulatorKey,
  delegate: terms.delegateKey,
});
assert.equal(hive.pkScript, hex(treasury.pkScript), "Hive and the SDK build the same treasury");
step("treasury built from the keepers", { address: treasury.address });

const units = (c: TreasuryCoin) => unitsOn(c, assetId);
const coins = async () => (await treasury.getUtxos()) as TreasuryCoin[];

// 2. The host funds it with the whole counter supply; a member chips in beside it.
await host.send({
  recipients: [{ address: treasury.address, amount: 1_000, assets: [{ assetId, amount: SUPPLY }] }],
} as never);
let coin = await waitFor("the treasury coin", async () => (await coins()).find((c) => units(c) === SUPPLY));
sendOffchain(treasury.address, 60_000);
const chipIn = await waitFor("the chip-in", async () =>
  (await coins()).find((c) => c.value === 60_000 && units(c) === 0n),
);
step("funded", { treasury: coin.value, units: String(units(coin)), chipIn: chipIn.value });

// 3. Two keepers approve a payment to a member; anyone merges the chip-in; the approvals still pay.
const member = await newWallet(ARKD, EMULATOR);
const to = recipientOf(await member.getAddress());
const one: Payment = { left: SUPPLY, amount: 20_000n, validUntil: now() + 3600, program: to.program };
const oneMessage = payMessage(counter, one);
const oneApprovals: (CovenantApproval | null)[] = [
  await maya.approve(oneMessage),
  null,
  rawApproval(priya.key, oneMessage, p256.sign(oneMessage, priyaSecret)),
];
await mergeIntoTreasury(treasury, coin, chipIn, assetId);
coin = await waitFor("the merged coin", async () =>
  (await coins()).find((c) => c.value === 61_000 && units(c) === SUPPLY),
);
step("merged", { value: coin.value });
const pay = (c: TreasuryCoin, p: Payment, approvals: (CovenantApproval | null)[]) =>
  payFromTreasury(
    treasury,
    c,
    assetId,
    { amount: BigInt(p.amount), program: p.program as Uint8Array, validUntil: p.validUntil },
    approvals,
  );
await pay(coin, one, oneApprovals);
coin = await waitFor("the change", async () => (await coins()).find((c) => units(c) === SUPPLY - 1n));
assert.equal(coin.value, 41_000);
await waitFor("the member's payment", async () => (await member.getBalance()).available >= 20_000);
step("paid, with approvals made before the merge", { value: coin.value, units: String(units(coin)) });

// 4. Approvals pay once, need two keepers, name the recipient, and lapse.
await assert.rejects(pay(coin, one, oneApprovals));
step("the same approvals again: refused");
const two: Payment = { left: SUPPLY - 1n, amount: 5_000n, validUntil: now() + 3600, program: to.program };
const twoMessage = payMessage(counter, two);
const twoApprovals: (CovenantApproval | null)[] = [
  await maya.approve(twoMessage),
  await jonas.approve(twoMessage),
  null,
];
await assert.rejects(pay(coin, two, [twoApprovals[0]!, null, null]));
step("one keeper alone: refused");
const elsewhere = recipientOf(await (await newWallet(ARKD, EMULATOR)).getAddress()).program;
await assert.rejects(pay(coin, { ...two, program: elsewhere }, twoApprovals));
step("another recipient: refused");
const lapsed: Payment = { ...two, validUntil: now() - 60 };
const lapsedMessage = payMessage(counter, lapsed);
await assert.rejects(
  pay(coin, lapsed, [await maya.approve(lapsedMessage), await jonas.approve(lapsedMessage), null]),
);
step("an approval past its lapse time: refused");

// 5. Only the delegatee renews; the treasury pays the operator's fee.
await assert.rejects(
  renewAsDelegatee(client, treasury, coin, { delegate: secp256k1.utils.randomSecretKey(), maxFee: MAX_FEE }),
);
step("a stranger's renewal: refused");
const before = coin;
const renewed = await renewAsDelegatee(client, treasury, coin, { delegate, maxFee: MAX_FEE });
coin = await waitFor(
  "the renewed coin",
  async () => (await coins()).find((c) => c.txid !== before.txid && units(c) === SUPPLY - 1n),
  180,
);
assert.equal(coin.value, before.value - renewed.fee);
step("renewed by the delegatee", { fee: renewed.fee, value: coin.value });

// 6. The payment approved before the renewal pays after it.
await pay(coin, two, twoApprovals);
coin = await waitFor("the second change", async () => (await coins()).find((c) => units(c) === SUPPLY - 2n));
assert.equal(coin.value, before.value - renewed.fee - 5_000);
step("paid, with approvals made before the renewal", { value: coin.value, units: String(units(coin)) });

await browser.close();
site.close();
console.log("PASSED");
process.exit(0);

// ---- helpers ---------------------------------------------------------------------------------

function step(name: string, detail: Record<string, unknown> = {}) {
  console.log(`- ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

/** A keeper's device: a browser profile with a platform passkey (with PRF) for the keeper site. */
async function passkeyDevice(name: string) {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  // tsx names the functions it compiles with a helper the page does not have.
  await page.addInitScript("window.__name = (f) => f");
  await page.goto(site.url);
  const made = await page.evaluate(
    async ({ name, salt }: { name: string; salt: string }) => {
      const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: "localhost", name: "Hive keepers" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          extensions: { prf: { eval: { first: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)) } } },
        },
      })) as PublicKeyCredential;
      const response = cred.response as AuthenticatorAttestationResponse;
      const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf;
      return { id: b64(cred.rawId), spki: b64(response.getPublicKey()!), prf: b64(prf!.results!.first!) };
    },
    { name, salt: Buffer.from(KEY_SALT).toString("base64") },
  );
  const key = keeperKeyFromSpki(Buffer.from(made.spki, "base64"));
  return {
    key,
    bitcoinKey: bitcoinKeyOf(Buffer.from(made.prf, "base64")),
    async approve(message: Uint8Array): Promise<CovenantApproval> {
      const got = await page.evaluate(
        async ({ id, challenge }: { id: string; challenge: string }) => {
          const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
          const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
          const a = (await navigator.credentials.get({
            publicKey: {
              challenge: unb64(challenge),
              rpId: "localhost",
              allowCredentials: [{ type: "public-key", id: unb64(id) }],
              userVerification: "required",
            },
          })) as PublicKeyCredential;
          const r = a.response as AuthenticatorAssertionResponse;
          return {
            authData: b64(r.authenticatorData),
            clientDataJSON: new TextDecoder().decode(r.clientDataJSON),
            sig: b64(r.signature),
          };
        },
        { id: made.id, challenge: Buffer.from(message).toString("base64") },
      );
      return passkeyApproval(key, message, "localhost", {
        authenticatorData: Buffer.from(got.authData, "base64"),
        clientDataJSON: got.clientDataJSON,
        signature: Buffer.from(got.sig, "base64"),
      });
    },
  };
}

/** Any page on localhost: passkeys for rpId "localhost" work there. */
async function serveBlankPage() {
  const server = createServer((_, res) =>
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Keeper</title>"),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://localhost:${port}/`, close: () => server.close() };
}
