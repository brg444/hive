// What the keeper console does with the key once the keeper has unlocked it: check a payment against
// the Operator and the job's own terms, then sign it, and nothing else. The checks and the signing
// are the hive's own code (packages/steward), bundled into the console, so the console decides for
// itself; the signing desk only carries messages between keepers.
import { Arkd, deriveAccount, jobEscrow, MAINNET_PINS, sendMessages, treasuryArguments } from "../../../packages/ark/src/index.ts";
import { checkPayment, keeperView } from "../../../packages/steward/src/policy.ts";
import { deskAuthDigest, nonceBatch, signOver, signShared } from "../../../packages/steward/src/keeper.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/**
 * The Operator as the console reads it: its keys and terms straight from the Operator, and the
 * delegatee's keys (the treasury is built with them) through the hive's desk, which relays them
 * because the delegatee serves no browser. A desk that relayed other keys would describe another
 * treasury, whose address the console compares with the hive's before anything is signed.
 */
/** The console built for real funds (`build.mjs --mainnet`) knows mainnet's Operator itself. */
export const MAINNET = typeof __HIVE_MAINNET__ !== "undefined" && __HIVE_MAINNET__ === true;
const MAINNET_ARKD = "https://arkade.computer";

export async function connection(desk, hive) {
    // The mainnet console reads the Operator at its own address and holds it to the pinned keys,
    // whatever the desk says: a dishonest host cannot slip in an Operator or an Emulator of its own.
    if (MAINNET && hive.network !== "bitcoin") throw new Error("This console signs for mainnet hives only.");
    if (!MAINNET && hive.network === "bitcoin") throw new Error("This is the test networks' console: open your hive's desk in the mainnet console.");
    const arkd = new Arkd(MAINNET ? MAINNET_ARKD : hive.deployment.arkdUrl);
    const operator = await arkd.info();
    if (operator.network !== hive.network) throw new Error(`The Operator is on ${operator.network}, the hive on ${hive.network}.`);
    if (MAINNET && (operator.signerPubkey !== MAINNET_PINS.operatorKey || operator.unilateralExitDelay !== MAINNET_PINS.exitDelaySeconds))
        throw new Error("The Operator does not match the keys this console was built with.");
    const res = await fetch(`${desk}/desk/v1/delegatee`);
    if (!res.ok) throw new Error("The hive's desk did not relay the delegatee's keys.");
    const info = await res.json();
    if (info.serverPubkey !== operator.signerPubkey) throw new Error("The delegatee serves another Operator.");
    if (MAINNET && info.emulatorPubkey !== MAINNET_PINS.emulatorKey) throw new Error("The delegatee names an Emulator this console does not know.");
    return {
        deployment: { network: hive.network },
        operator,
        keys: { server: operator.signerPubkey, emulator: info.emulatorPubkey, delegate: info.delegatePubkey },
        arkd,
    };
}

/** The treasury the hive's keepers' keys build on this Operator, as the script its coins sit at. */
export function treasuryScriptOf(conn, hive) {
    return deriveAccount(conn, "treasury", treasuryArguments(keeperView(hive.keepers, hive.treasury.terms).treasuryTerms)).pkScript;
}

/**
 * What the console can say about a job before anyone plans its payment: whether the address is the
 * escrow the job's terms build, and whether that escrow gives back to this hive's treasury.
 */
export function escrowFacts(conn, hive, request) {
    let address = null;
    try { address = jobEscrow(conn, request.params).address; } catch { /* malformed terms */ }
    return {
        escrowMatches: address !== null && address === request.address.trim().toLowerCase() && request.params.jobId === request.jobId
            && request.params.providerPk === request.providerPk && request.params.deadline === request.deadline,
        returnsHere: request.params.treasuryProgram === hive.treasury.script.slice(4),
    };
}

/** The keeper's public key, as the hive lists it. */
export const publicKeyOf = (secret) => hex(secp256k1.getPublicKey(secret, true));

/** A fresh batch of nonces to share, and the secrets the console keeps until it signs. */
export function freshNonces(secret, count = 32) {
    return nonceBatch(secret, count);
}

/** A request to the desk, signed so nobody else can start or cancel a payment in this keeper's name. */
export function deskAuth(secret, hiveName, action, jobId, at = Math.floor(Date.now() / 1000)) {
    const digest = deskAuthDigest(hiveName, action, jobId, at);
    return { keeper: publicKeyOf(secret), at, signature: hex(schnorr.sign(digest, secret)) };
}

/** The keeper's signature over the hive's listing. */
export function signListing(secret, listingId) {
    return hex(schnorr.sign(unhex(listingId), secret));
}

/**
 * Checks one session of a payment and returns its messages, recomputed here: the console never
 * signs a message it was handed. Throws, with the check's code, when anything is off.
 */
export async function checkSession(conn, hive, session, shown, remainingSats) {
    const view = keeperView(hive.keepers, hive.treasury.terms);
    const treasury = hive.treasury.script;
    // The keeper approves the request the console showed them; the session must carry exactly it.
    const checked = await checkPayment(view, conn, session, { request: shown, remainingSats }, Math.floor(Date.now() / 1000));
    // The treasury these keys build must be the hive's, as its channel and listing name it.
    const plan = session.purpose.plan;
    if (!plan.coins.every((c) => c.script === treasury)) throw Object.assign(new Error("These coins are not the hive's treasury."), { code: "NOT_OUR_TREASURY" });
    return checked;
}

/** Signs a session first, over the other keeper's shared nonces: the nonces and partials to send. */
export function signFirst(pairSession, secret, messages) {
    return signOver(pairSession, secret, messages);
}

/** Signs a session second, with this keeper's own shared nonces; their secrets must be in `kept`. */
export function signSecond(pairSession, secret, messages, kept) {
    return signShared(pairSession, secret, messages, kept);
}

export { sendMessages };
