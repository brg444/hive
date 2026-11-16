// What a keeper's Hive plugin checks before it offers to approve a payment: the treasury these
// keepers' keys and the hive's terms build, the escrow a job's own terms build and that it gives back
// to that treasury, the address a withdrawal pays and the keeper's message that asked for it, the
// limits a payment must stay within, and the exact message the treasury's covenant will rebuild, from
// which the approval's text follows. The checks are the hive's own code (packages/ark and
// packages/treasury), bundled into the plugin, so the plugin decides for itself; the desk only
// carries approvals between keepers and the treasury.
import { instantiate } from "../../../packages/ark/src/contract.ts";
import { MAINNET_PINS, networkCeilings } from "../../../packages/ark/src/deployment.ts";
import { jobEscrow } from "../../../packages/ark/src/job-escrow.ts";
import { parseArkAddress } from "../../../packages/ark/src/taproot.ts";
import {
    approvalText,
    codeOf,
    declineText,
    MAX_AMOUNT_SATS,
    paymentWord,
    payMessage,
    withdrawalOf,
    withdrawalText,
} from "../../../packages/treasury/src/message.ts";
import { TREASURY_ARTIFACT, treasuryArguments } from "../../../packages/treasury/src/terms.ts";

const XONLY = (k) => String(k ?? "").slice(-64);
/** The longest an approval may stay valid: the desk asks for 23 hours at most. */
export const MAX_VALIDITY_SECONDS = 86_400;
/** The most a renewal of a mainnet treasury may take, whatever the host's terms say. */
const MAINNET_MAX_RENEWAL_FEE_SATS = 2_000;

/** The Operator the payments are checked against: on mainnet, the keys this plugin was built knowing. */
function operatorOf(payments) {
    const o = payments?.operator;
    if (!o?.server || !o?.emulator) throw new Error("The hive's host did not say which Operator its treasury is on.");
    if (o.network === "bitcoin" && (o.server !== MAINNET_PINS.operatorKey || o.emulator !== MAINNET_PINS.emulatorKey || o.exitDelay !== MAINNET_PINS.exitDelaySeconds))
        throw new Error("The hive's host names an Operator other than Arkade's.");
    return { deployment: { network: o.network }, keys: { server: o.server, emulator: o.emulator }, operator: { unilateralExitDelay: o.exitDelay } };
}

const derived = new Map();
/**
 * The treasury's script, rebuilt here from the keepers' Buzz keys, the counter and the terms the
 * host states, on the Operator the payments are checked against. The host chooses the counter and
 * its own delegate key; the keepers, the contract and the Operator it cannot choose.
 */
export function treasuryScript(payments, keepers) {
    const conn = operatorOf(payments);
    const t = payments?.terms;
    if (!t?.delegateKey) throw new Error("The hive's host did not state its treasury's terms.");
    const terms = { keepers, counter: payments.counter, delegateKey: t.delegateKey, renewalWindowSeconds: t.renewalWindowSeconds,
        maxFeeSats: t.maxFeeSats, exitDelaySeconds: t.exitDelaySeconds };
    const key = JSON.stringify([terms, conn.keys]);
    if (!derived.has(key)) {
        if (derived.size > 8) derived.clear();
        derived.set(key, instantiate(TREASURY_ARTIFACT, treasuryArguments(terms), { ...conn.keys, delegate: t.delegateKey }).pkScript);
    }
    return derived.get(key);
}

/**
 * A payment, checked: what the keeper approves and anything that keeps them from approving it.
 *
 * payments: the state's `payments`; payment: one of its `payments`; keepers: the hive's keepers as
 * the plugin knows them; treasury: the treasury's address members chip in to.
 * budgetSats: what approved proposals have left by the plugin's own count, or null when it has none.
 * agent: the key this hive's agent signs receipts with, as a keeper named it in the channel or as
 *   this plugin remembers it; null when it knows none yet.
 * events: the channel's signed events when the plugin reads them itself, else null.
 * approved: this keeper's own recent approvals, [{ code, amountSats, recipient, at }], from the
 *   channel and from what this plugin wrote.
 */
export function checkPayment({ payments, payment, keepers, treasury, budgetSats = null, agent = null, events = null, approved = [], now = Math.floor(Date.now() / 1000) }) {
    const problems = [];
    let conn = null;
    try { conn = operatorOf(payments); } catch (e) { problems.push(e.message); }
    if (keepers?.length && (payments?.keepers ?? []).join() !== keepers.join())
        problems.push("The hive's host names other keepers than this channel confirmed.");
    // The treasury is the one these keepers' keys build: neither its script nor its address is the host's to name.
    let script = null;
    if (conn) {
        try {
            script = treasuryScript(payments, keepers?.length === 3 ? keepers : payments.keepers);
            if (script !== payments.treasuryScript) problems.push("The treasury the host pays from is not the one the keepers' keys and its terms build.");
            if (conn.deployment.network === "bitcoin" && !(payments.terms.maxFeeSats <= MAINNET_MAX_RENEWAL_FEE_SATS))
                problems.push(`The treasury's terms let a renewal take more than ${MAINNET_MAX_RENEWAL_FEE_SATS} sats.`);
        } catch (e) { problems.push(e?.message?.startsWith("The hive's host") ? e.message : "The treasury cannot be rebuilt from the terms the hive's host states."); }
    }
    try {
        const home = parseArkAddress(String(treasury ?? ""));
        if (script && home.pkScript !== script) problems.push("The address members chip in to is not this hive's treasury.");
    } catch { problems.push("The hive's treasury address is missing or not an Arkade address."); }
    let program = null;
    let agentPk = null;
    if (payment.kind === "withdrawal") {
        try {
            const to = parseArkAddress(payment.address);
            if (conn && XONLY(to.serverKey) !== XONLY(conn.keys.server)) problems.push("The withdrawal pays an address on another Operator.");
            if (script && to.pkScript === script) problems.push("The withdrawal pays the treasury itself.");
            program = to.pkScript.slice(4);
        } catch { problems.push("The withdrawal's address is not an Arkade address."); }
        if (payment.withdrawal?.amountSats !== payment.amountSats) problems.push("The amount is not the one the keeper asked for.");
        // A withdrawal starts with a keeper's message in the channel: the desk invents none.
        if (events) {
            const asked = events.find((e) => e.id === payment.id && e.kind === 9 && (keepers ?? []).includes(e.pubkey));
            const said = asked ? withdrawalOf(asked.content) : null;
            if (!said) problems.push("No keeper's message in this channel asks for this withdrawal.");
            else if (said.amountSats !== payment.amountSats || said.address !== String(payment.address).toLowerCase())
                problems.push("The keeper's message asks for another amount or address.");
        }
    } else {
        const r = payment.request;
        if (!r) problems.push("The job's terms are missing.");
        else if (conn) {
            try {
                const escrow = jobEscrow(conn, r.params);
                if (escrow.address !== String(r.address).toLowerCase() || escrow.address !== payment.address) problems.push("The address is not the escrow the job's terms build.");
                if (r.params.jobId !== r.jobId || r.params.providerPk !== r.providerPk || r.params.deadline !== r.deadline) problems.push("The job's terms disagree with themselves.");
                if (script && r.params.treasuryProgram !== script.slice(4)) problems.push("The escrow gives back to another treasury than this hive's.");
                program = escrow.pkScript.slice(4);
                agentPk = r.params.agentPk;
            } catch { problems.push("The job's terms do not build an escrow."); }
            if (r.capSats !== payment.amountSats) problems.push("The amount is not the job's cap.");
            if (!(r.deadline > now)) problems.push("The job's deadline has passed.");
            const ceilings = networkCeilings(conn.deployment.network);
            if (ceilings && payment.amountSats > ceilings.escrowSats) problems.push(`The job asks more than the ${ceilings.escrowSats.toLocaleString("en-US")} sats an escrow may hold on mainnet.`);
            if (budgetSats !== null && payment.amountSats > budgetSats) problems.push(`The job asks more than approved proposals have left: ${Math.max(0, budgetSats).toLocaleString("en-US")} sats.`);
            // Whoever holds the agent's key signs the receipts that pay this job's provider.
            if (agent && agentPk && agentPk !== agent) problems.push(`The job's receipts would be signed by another agent (${agentPk.slice(0, 8)}…) than this hive's (${agent.slice(0, 8)}…).`);
        }
    }
    if (!(payment.validUntil > now + 60)) problems.push("The payment's approvals lapse too soon.");
    if (!(payment.validUntil <= now + MAX_VALIDITY_SECONDS)) problems.push("The payment's approvals would stay valid for more than a day.");
    if (!(Number.isSafeInteger(payment.amountSats) && payment.amountSats > 0 && BigInt(payment.amountSats) <= MAX_AMOUNT_SATS)) problems.push("The amount is not one an approval can name.");
    if (program && payment.program !== program) problems.push("The desk would pay another script than the one checked here.");
    // One payment is open at a time, under the treasury's own number: an approval under any other
    // number would wait in the channel for the treasury to reach it.
    if (payment.left === null || payment.left === undefined || String(payments?.units) !== String(payment.left))
        problems.push("It is not this payment's turn: the treasury stands at another number.");
    let code = null;
    try {
        if (!program) throw new Error();
        const terms = { left: BigInt(payment.left), amount: BigInt(payment.amountSats), validUntil: payment.validUntil, program };
        code = codeOf(payMessage(payments.counter, terms));
        if (payment.code && payment.code !== code) problems.push("The desk asks for another approval than the one checked here.");
        // An approval names the payment's number, so the same payment approved under two numbers
        // could pay under both: a keeper approves it once until that approval has lapsed.
        const earlier = approved.find((a) => a.code !== code && a.amountSats === payment.amountSats && a.recipient === program.slice(0, 8) && a.at > now - MAX_VALIDITY_SECONDS);
        if (earlier) problems.push(`You approved this amount to this recipient under another number on ${new Date(earlier.at * 1000).toLocaleString()}. That approval can still pay for up to a day after it; approving again could pay twice.`);
        return { problems, code, agentPk, mine: approved.some((a) => a.code === code),
            approve: approvalText(payments.counter, terms), decline: declineText(payments.counter, terms) };
    } catch {
        if (!problems.length) problems.push("The payment could not be rebuilt.");
        return { problems, code, agentPk, mine: false, approve: null, decline: null };
    }
}

/** A withdrawal a keeper asks for: the message they send, or what is wrong with it. */
export function withdrawalRequest(amountSats, address, payments) {
    const a = String(address ?? "").trim().toLowerCase();
    const n = Number(String(amountSats ?? "").replace(/[,_\s]/g, ""));
    if (!Number.isSafeInteger(n) || n <= 0) return { text: null, problem: "Give the amount in whole sats." };
    try {
        const to = parseArkAddress(a);
        const server = payments?.operator?.server;
        if (server && XONLY(to.serverKey) !== XONLY(server)) return { text: null, problem: "That address is on another Arkade Operator than the hive's." };
    } catch { return { text: null, problem: "That is not an Arkade address." }; }
    return { text: withdrawalText(n, a), problem: null };
}

export { paymentWord, withdrawalOf };
