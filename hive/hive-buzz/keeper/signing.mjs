// What the keeper console checks before the keeper's passkey approves anything: the treasury the
// keepers' keys build, the escrow a job's terms build, the address a withdrawal pays, and the exact
// message the contract will rebuild. The checks are the hive's own code (packages/ark and
// packages/treasury), bundled into the console, so the console decides for itself; the desk only
// carries approvals between keepers and the treasury.
import { Arkd, instantiate, jobEscrow, MAINNET_PINS, parseArkAddress } from "../../../packages/ark/src/index.ts";
import { deskAuthDigest, withdrawalId } from "../../../packages/steward/src/keeper.ts";
import { keeperSecret, payMessage, TREASURY_ARTIFACT, treasuryArguments } from "../../../packages/treasury/src/index.ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/** The console built for real funds (`build.mjs --mainnet`) knows mainnet's Operator itself. */
export const MAINNET = typeof __HIVE_MAINNET__ !== "undefined" && __HIVE_MAINNET__ === true;
const MAINNET_ARKD = "https://arkade.computer";

/**
 * The Operator as the console reads it: its keys and terms straight from the Operator, and the
 * delegatee's keys (the treasury is built with them) through the hive's desk, which relays them
 * because the delegatee serves no browser. A desk that relayed other keys would describe another
 * treasury, whose address the console compares with the hive's before anything is approved.
 */
export async function connection(desk, hive) {
    // The mainnet console reads the Operator at its own address and holds it to the pinned keys,
    // whatever the desk says: a dishonest host cannot slip in an Operator or an Emulator of its own.
    if (MAINNET && hive.network !== "bitcoin") throw new Error("This console approves for mainnet hives only.");
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

/** The treasury's terms as the desk describes them, for the contract's arguments. */
export function termsOf(hive) {
    const t = hive.treasury.terms;
    return {
        keepers: hive.passkeys,
        counter: t.counter,
        delegateKey: t.delegateKey,
        renewalWindowSeconds: t.renewalWindowSeconds,
        maxFeeSats: t.maxFeeSats,
        exitDelaySeconds: t.exitDelaySeconds,
    };
}

/**
 * The treasury the hive's keepers' keys build on this Operator, as the script its coins sit at. The
 * keepers' Bitcoin keys are the ones the hive lists, its delegate key the delegatee's own, and its exit
 * delay the Operator's: a desk that changed any of them describes another treasury.
 */
export function treasuryScriptOf(conn, hive) {
    const terms = termsOf(hive);
    if (terms.keepers.map((k) => k.bitcoinKey).join() !== hive.keepers.join()) throw new Error("The desk names the keepers' keys twice, differently.");
    if (terms.delegateKey !== conn.keys.delegate) throw new Error("The treasury names another delegatee than the hive's.");
    if (terms.exitDelaySeconds !== conn.operator.unilateralExitDelay) throw new Error("The treasury's exit delay is not the Operator's.");
    return instantiate(TREASURY_ARTIFACT, treasuryArguments(terms), conn.keys).pkScript;
}

/**
 * What the console can say about a job before anyone starts its payment: whether the address is the
 * escrow the job's terms build, and whether that escrow gives back to this hive's treasury.
 */
export function escrowFacts(conn, hive, request) {
    let escrow = null;
    try { escrow = jobEscrow(conn, request.params); } catch { /* malformed terms */ }
    return {
        escrowMatches: escrow !== null && escrow.address === request.address.trim().toLowerCase() && request.params.jobId === request.jobId
            && request.params.providerPk === request.providerPk && request.params.deadline === request.deadline,
        returnsHere: request.params.treasuryProgram === hive.treasury.script.slice(4),
        program: escrow ? escrow.pkScript.slice(4) : null,
    };
}

/**
 * The script an Arkade address pays, worked out here from the address the keeper reads: a
 * withdrawal is approved for this script and no other. An address on another Operator is refused.
 */
export function withdrawalScript(conn, address) {
    let decoded;
    try { decoded = parseArkAddress(String(address)); } catch { throw new Error("This is not an Arkade address."); }
    if (decoded.serverKey !== conn.keys.server.slice(-64)) throw new Error("This address belongs to another Operator than the hive's.");
    if (!/^5120[0-9a-f]{64}$/.test(decoded.pkScript)) throw new Error("This address does not pay a taproot script.");
    return decoded.pkScript;
}

/** The keeper's Bitcoin key, from the passkey's PRF output: the key the hive lists, compressed. */
export const bitcoinSecret = (prf) => keeperSecret(prf);
export const publicKeyOf = (secret) => hex(secp256k1.getPublicKey(secret, true));

/** A request to the desk, signed so nobody else can start or cancel a payment in this keeper's name. */
export function deskAuth(secret, hiveName, action, id, at = Math.floor(Date.now() / 1000)) {
    const digest = deskAuthDigest(hiveName, action, id, at);
    return { keeper: publicKeyOf(secret), at, signature: hex(schnorr.sign(digest, secret)) };
}

/**
 * The message the keeper's passkey signs, rebuilt here: the hive's counter, the payment's number, the
 * amount, the lapse time and the program the console worked out itself from what the keeper read.
 */
export function approvalMessage(hive, payment, program) {
    return payMessage(hive.treasury.terms.counter, {
        left: BigInt(payment.left),
        amount: BigInt(payment.amountSats),
        validUntil: payment.validUntil,
        program: unhex(program),
    });
}

export { hex, unhex, withdrawalId };
