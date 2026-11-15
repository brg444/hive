// What a keeper's Hive plugin checks before it offers to approve a payment: the escrow a job's own
// terms build and that it gives back to this hive's treasury, the address a withdrawal pays, and
// the exact message the treasury's covenant will rebuild, from which the approval's text follows.
// The checks are the hive's own code (packages/ark and packages/treasury), bundled into the plugin,
// so the plugin decides for itself; the desk only carries approvals between keepers and the treasury.
import { jobEscrow } from "../../../packages/ark/src/job-escrow.ts";
import { MAINNET_PINS } from "../../../packages/ark/src/deployment.ts";
import { parseArkAddress } from "../../../packages/ark/src/taproot.ts";
import {
    approvalText,
    codeOf,
    declineText,
    paymentWord,
    payMessage,
    withdrawalOf,
    withdrawalText,
} from "../../../packages/treasury/src/message.ts";

const XONLY = (k) => String(k ?? "").slice(-64);

/** The Operator the payments are checked against: on mainnet, the keys this plugin was built knowing. */
function operatorOf(payments) {
    const o = payments?.operator;
    if (!o?.server || !o?.emulator) throw new Error("The hive's host did not say which Operator its treasury is on.");
    if (o.network === "bitcoin" && (o.server !== MAINNET_PINS.operatorKey || o.emulator !== MAINNET_PINS.emulatorKey || o.exitDelay !== MAINNET_PINS.exitDelaySeconds))
        throw new Error("The hive's host names an Operator other than Arkade's.");
    return { deployment: { network: o.network }, keys: { server: o.server, emulator: o.emulator }, operator: { unilateralExitDelay: o.exitDelay } };
}

/**
 * A payment, checked: what the keeper approves and anything that keeps them from approving it.
 * payments: the state's `payments`; payment: one of its `payments`; keepers: the hive's keepers as
 * the plugin knows them; treasury: the treasury's address members chip in to.
 */
export function checkPayment({ payments, payment, keepers, treasury, now = Math.floor(Date.now() / 1000) }) {
    const problems = [];
    let conn = null;
    try { conn = operatorOf(payments); } catch (e) { problems.push(e.message); }
    if (keepers?.length && (payments?.keepers ?? []).join() !== keepers.join())
        problems.push("The hive's host names other keepers than this channel confirmed.");
    let home = null;
    try {
        home = parseArkAddress(String(treasury ?? ""));
        if (home.pkScript !== payments.treasuryScript) problems.push("The treasury the host pays from is not the one members chip in to.");
    } catch { problems.push("The hive's treasury address is missing or not an Arkade address."); }
    let program = null;
    if (payment.kind === "withdrawal") {
        try {
            const to = parseArkAddress(payment.address);
            if (conn && XONLY(to.serverKey) !== XONLY(conn.keys.server)) problems.push("The withdrawal pays an address on another Operator.");
            if (to.pkScript === payments.treasuryScript) problems.push("The withdrawal pays the treasury itself.");
            program = to.pkScript.slice(4);
        } catch { problems.push("The withdrawal's address is not an Arkade address."); }
        if (payment.withdrawal?.amountSats !== payment.amountSats) problems.push("The amount is not the one the keeper asked for.");
    } else {
        const r = payment.request;
        if (!r) problems.push("The job's terms are missing.");
        else if (conn) {
            try {
                const escrow = jobEscrow(conn, r.params);
                if (escrow.address !== String(r.address).toLowerCase() || escrow.address !== payment.address) problems.push("The address is not the escrow the job's terms build.");
                if (r.params.jobId !== r.jobId || r.params.providerPk !== r.providerPk || r.params.deadline !== r.deadline) problems.push("The job's terms disagree with themselves.");
                if (home && r.params.treasuryProgram !== home.pkScript.slice(4)) problems.push("The escrow gives back to another treasury than this hive's.");
                program = escrow.pkScript.slice(4);
            } catch { problems.push("The job's terms do not build an escrow."); }
            if (r.capSats !== payment.amountSats) problems.push("The amount is not the job's cap.");
        }
    }
    if (!(payment.validUntil > now + 60)) problems.push("The payment's approvals lapse too soon.");
    if (program && payment.program !== program) problems.push("The desk would pay another script than the one checked here.");
    let code = null;
    try {
        if (!program) throw new Error();
        const message = payMessage(payments.counter, { left: BigInt(payment.left), amount: BigInt(payment.amountSats), validUntil: payment.validUntil, program });
        code = codeOf(message);
        if (payment.code && payment.code !== code) problems.push("The desk asks for another approval than the one checked here.");
        return { problems, code, approve: approvalText(message), decline: declineText(message) };
    } catch {
        if (!problems.length) problems.push("The payment could not be rebuilt.");
        return { problems, code, approve: null, decline: null };
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
