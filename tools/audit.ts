/**
 * Recheck v4 gate evidence without the network.
 *
 *   pnpm audit:v4              every run under docs/evidence/v4/
 *   pnpm audit:v4 --offline    the offline smoke runs under .local/offline-evidence/
 *   pnpm audit:v4 <run dir>    one run
 *
 * Every signature is checked against the keys and terms the evidence itself
 * records, every address against our own derivation, and every balance
 * against the run's arithmetic. The report names this tool's own hash.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  ARTIFACTS,
  arkAddress,
  type ClaimPlan,
  claimMessage,
  claimSpend,
  claimVariables,
  deriveAccount,
  type EscrowTerms,
  escrowArguments,
  instantiate,
  MUTINYNET,
  type Network,
  type Pair,
  pairKeys,
  parseArkAddress,
  parseArkTx,
  refundSpend,
  revealedPreimage,
  type SendPlan,
  type ServiceKeys,
  type SpendRequest,
  sendMessages,
  sendSpend,
  sendTerms,
  spendFingerprint,
  spendRequestMessage,
  type TreasuryTerms,
  treasuryArguments,
  treasuryPlanVariables,
  type WalletTerms,
  walletArguments,
  walletPlanVariables,
  xOnly,
} from "@hive/ark";
import { type Attempt, buildSpend } from "@hive/executor";
import { fail, hex, LOCAL_ROOT, repositoryRoot, sha256Hex, unhex } from "@hive/kit";
import {
  escrowTermsFromQuote,
  quoteCostSats,
  requireValidReceipt,
  requireValidSignedQuote,
  type SignedQuote,
} from "@hive/protocol";
import { schnorr } from "@noble/curves/secp256k1.js";
import { refusalChecks } from "../gates/support/covenant.js";
import { evidenceRoot } from "../gates/support/run.js";
import { type EvidenceProfile, evidenceProfile, type Suite } from "../gates/support/schema.js";

type Check = { name: string; ok: boolean; detail?: string };
// biome-ignore lint/suspicious/noExplicitAny: evidence is JSON read back from disk; every field used is checked.
type Evidence = Record<string, any>;

class Audit {
  readonly checks: Check[] = [];
  check(name: string, ok: unknown, detail?: string): void {
    this.checks.push({ name, ok: Boolean(ok), ...(ok ? {} : detail ? { detail } : {}) });
  }
  attempt(name: string, action: () => unknown): void {
    try {
      this.check(name, action() !== false);
    } catch (error) {
      this.check(name, false, error instanceof Error ? error.message.slice(0, 200) : String(error));
    }
  }
}

const sortedJson = (v: unknown): unknown =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([k, w]) => [k, sortedJson(w)]),
      )
    : Array.isArray(v)
      ? v.map(sortedJson)
      : v;

const verify = (signature: string, message: Uint8Array, key: string) =>
  schnorr.verify(unhex(signature), message, unhex(key.length === 66 ? key.slice(2) : key));

function verifyRequest(a: Audit, name: string, request: SpendRequest, pubkey: string): void {
  a.check(`${name}: registered by ${pubkey.slice(0, 12)}…`, request.pubkey === pubkey);
  a.attempt(`${name}: spend request signature`, () =>
    verify(
      request.signature,
      spendRequestMessage(
        spendFingerprint(request.templateId, request.variables, request.outpoints),
        request.expiresAt,
      ),
      request.pubkey,
    ),
  );
}

/**
 * A send's attestations: each coin's signature over the terms, under the
 * owner the account names. The transaction the indexer showed is
 * the one those attestations build, whichever route executed it.
 */
function verifySend(
  a: Audit,
  name: string,
  plan: SendPlan,
  request: SpendRequest,
  instance: ReturnType<typeof instantiate>,
  unroll: string,
  owner: string,
  journal: { status?: string; txid?: string | null; arkTxid?: string | null; attempts?: Attempt[] },
  profile: EvidenceProfile,
  nonpayment = false,
): void {
  a.check(`${name}: complete outcome`, journal.status === (nonpayment ? "expired" : "done"));
  a.check(`${name}: a nonempty input plan`, plan.coins.length > 0);
  a.check(`${name}: request uses the planned template`, request.templateId === plan.templateId);
  const signatures = plan.coins.map((_, i) => request.variables[`sig_${i}`]!);
  a.check(
    `${name}: request variables are exactly the attested plan`,
    JSON.stringify(sortedJson(request.variables)) ===
      JSON.stringify(
        sortedJson({
          ...plan.variables,
          ...Object.fromEntries(signatures.map((signature, i) => [`sig_${i}`, signature])),
        }),
      ),
  );
  a.check(
    `${name}: request spends the planned coins`,
    JSON.stringify(request.outpoints) === JSON.stringify(plan.coins.map((c) => `${c.txid}:${c.vout}`)),
  );
  a.attempt(`${name}: one attestation per coin, by the owner`, () =>
    sendMessages(plan, instance, unroll).every((message, i) =>
      verify(request.variables[`sig_${i}`]!, message, owner),
    ),
  );
  a.attempt(`${name}: the transaction is the one its attestations build`, () => {
    const built = buildSpend(sendSpend(plan, instance, signatures), unroll).txid;
    return (
      (nonpayment
        ? journal.txid == null && built === journal.arkTxid
        : built === journal.txid && (profile.version === 1 || built === journal.arkTxid)) ||
      fail("AUDIT", "observed or prepared transaction identity differs from reconstruction")
    );
  });
  if (!nonpayment && journal.attempts?.length)
    a.check(
      `${name}: executed by ${
        journal.attempts
          .filter((t) => t.result === "accepted")
          .map((t) => t.route)
          .join(", ") || "nobody"
      }`,
      journal.attempts.some((t) => t.result === "accepted"),
    );
}

function auditLifecycle(a: Audit, e: Evidence, profile: EvidenceProfile): void {
  const network = e.network as Network;
  const keys = e.operator.keys as ServiceKeys;
  const info = e.operator.info as { checkpointTapscript: string; unilateralExitDelay: number };
  const conn = { deployment: { network, arkdUrl: "", delegateeUrl: "" }, keys };
  a.check(
    "both inference completions are recorded",
    Array.isArray(e.inferences) &&
      e.inferences.length === 2 &&
      e.inferences.every(
        (r: Evidence) =>
          typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && typeof r.requestId === "string",
      ),
  );
  a.check(
    "the replay completed without another charge or receipt",
    e.replay?.usageChanged === false &&
      e.replay?.receiptsChanged === false &&
      Boolean(e.replay?.latest?.latestReceipt),
  );
  if (network === "mutinynet") {
    const pins = MUTINYNET.pins!;
    a.check(
      "the Mutinynet keys are the pinned ones",
      keys.server === pins.operatorKey &&
        keys.emulator === pins.emulatorKey &&
        keys.delegate === pins.delegateKey,
    );
  }
  // The treasury: its pair keys come from the three stewards, its address from our own derivation.
  a.check(
    "pair keys aggregate the three stewards",
    JSON.stringify(pairKeys(e.hive.stewardKeys)) === JSON.stringify(e.hive.pairKeys),
  );
  const terms: TreasuryTerms = {
    pairs: e.hive.pairKeys,
    exitDelaySeconds: info.unilateralExitDelay,
    renewalWindowSeconds: e.hive.renewal.windowSeconds,
    maxFeeSats: e.hive.renewal.maxFeeSats,
  };
  const treasury = instantiate(ARTIFACTS.treasury, treasuryArguments(terms), keys);
  a.check("treasury script derives from its terms", treasury.pkScript === e.hive.treasuryScript);
  a.check(
    "treasury address names the Operator",
    arkAddress(network, keys.server, treasury.pkScript) === e.hive.treasuryAddress,
  );

  // The quotes, the escrows they define, the receipt and the claim.
  const quotes = { paid: e.escrows.paid.quote as SignedQuote, unpaid: e.escrows.unpaid.quote as SignedQuote };
  for (const [label, quote] of Object.entries(quotes)) {
    a.attempt(`${label} quote is signed by the provider`, () => requireValidSignedQuote(quote));
    a.check(
      `${label} quote names this Operator, Emulator and treasury`,
      quote.body.operatorKey === hex(xOnly(keys.server)) &&
        quote.body.emulatorKey === hex(xOnly(keys.emulator)) &&
        quote.body.treasuryScript === e.hive.treasuryScript &&
        JSON.stringify(quote.body.stewardPairKeys) ===
          JSON.stringify([terms.pairs["01"], terms.pairs["02"], terms.pairs["12"]]),
    );
    const escrow = deriveAccount(conn, "escrow", escrowArguments(escrowTermsFromQuote(quote) as EscrowTerms));
    const viewed = (e.view.escrows as { escrowId: string; address: string }[]).find(
      (v) => v.escrowId === quote.quoteId,
    );
    a.check(`${label} escrow address derives from its quote`, viewed?.address === escrow.address);
  }
  const paid = quotes.paid;
  // The receipt the claim daemon froze the sidecar on, and the tokens it prices.
  const decision = e.closeDecision;
  a.check("the claim daemon's decision is recorded", decision?.escrowId === paid.quoteId && decision.receipt);
  if (decision?.receipt) {
    a.attempt("the payer's latest receipt verifies", () =>
      requireValidReceipt(decision.receipt, {
        escrowId: paid.quoteId,
        payerReceiptKey: paid.body.payerReceiptKey,
        capSats: paid.body.capSats,
      }),
    );
    a.check(
      "the receipt is the quoted price of the metered tokens",
      decision.receipt.amountSats ===
        quoteCostSats(paid.body, decision.cumulativeInputTokens, decision.cumulativeOutputTokens).toString(),
    );
    a.check("the claim is the receipt's amount", e.claim.amountSats === Number(decision.receipt.amountSats));
  }

  // Each escrow's funding: a pair's attestations and request, paying exactly the cap to the escrow its quote defines.
  for (const [label, quote] of Object.entries(quotes)) {
    const escrow = deriveAccount(conn, "escrow", escrowArguments(escrowTermsFromQuote(quote) as EscrowTerms));
    const journals = (e.fundings?.[label] ?? []) as {
      status: string;
      txid: string | null;
      arkTxid?: string | null;
      attestations?: string[] | null;
      outcome?: { observedAt: number; inputs: Evidence[] };
      attempts?: Attempt[];
      plan: SendPlan;
      request: SpendRequest | null;
    }[];
    const done = journals.filter((j) => j.status === "done");
    a.check(`${label} escrow was funded once`, done.length === 1);
    for (const [i, j] of journals.entries()) {
      const name = `${label} funding ${i + 1}`;
      const nonpayment = j.status === "expired";
      if (nonpayment) {
        const inputs = j.outcome?.inputs ?? [];
        a.check(
          `${name}: complete non-payment observation`,
          inputs.length === j.plan.coins.length &&
            inputs.length > 0 &&
            Number.isSafeInteger(j.outcome?.observedAt) &&
            j.outcome!.observedAt >= j.plan.validUntil + (j.request ? 600 : -60) &&
            j.plan.coins.every((planned) => {
              const matches = inputs.filter((c) => c.txid === planned.txid && c.vout === planned.vout);
              const coin = matches[0];
              return (
                matches.length === 1 &&
                coin!.amount === planned.amount &&
                coin!.script === planned.script &&
                coin!.isSpent === false &&
                coin!.isSwept === false &&
                !coin!.arkTxid &&
                !coin!.spentBy &&
                !coin!.settledBy
              );
            }),
        );
        if (!j.request) {
          a.check(
            `${name}: closed without spending authority`,
            j.txid == null && j.arkTxid == null && (j.attestations == null || j.attestations.length === 0),
          );
          continue;
        }
      }
      a.check(`${name}: funding authority is recorded`, Boolean(j.request));
      a.check(`${name}: complete outcome`, j.status === "done" || nonpayment);
      if (!j.request) continue;
      a.check(
        `${name}: pays the cap to the escrow`,
        j.plan.destination === escrow.pkScript && j.plan.amount === Number(quote.body.capSats),
      );
      a.check(
        `${name}: variables are the treasury's terms`,
        JSON.stringify(j.plan.variables) === JSON.stringify(treasuryPlanVariables(terms, sendTerms(j.plan))),
      );
      verifySend(
        a,
        name,
        j.plan,
        j.request,
        treasury,
        info.checkpointTapscript,
        terms.pairs[j.plan.pair!],
        j,
        profile,
        nonpayment,
      );
      verifyRequest(a, name, j.request, terms.pairs[j.plan.pair!]);
    }
  }

  // The claim a pair registered: the provider's signature and the payer's receipt, nothing else.
  const registrations = (e.claimRegistrations ?? []) as {
    claim: ClaimPlan;
    request: SpendRequest;
    pair: Pair;
  }[];
  // The provider executes its claim itself, or hands it to the desk where a pair registers it.
  const selfClaimed = ((e.claim.submissions ?? []) as { route?: string; result?: string }[]).some(
    (t) => t.route === "self" && t.result === "accepted",
  );
  a.check(
    `the claim was ${selfClaimed ? "executed by the provider" : "registered through the desk"}`,
    selfClaimed || registrations.length >= 1,
  );
  const paidTerms = escrowTermsFromQuote(paid) as EscrowTerms;
  const paidEscrow = instantiate(ARTIFACTS.escrow, escrowArguments(paidTerms), keys);
  a.attempt("the claim transaction is the one the receipt and the provider's signature build", () => {
    const coin = e.escrows.paid.coin as { txid: string; vout: number; amountSats: number };
    const plan: ClaimPlan = {
      escrow: paidTerms,
      coin: { txid: coin.txid, vout: coin.vout, amount: coin.amountSats, script: paidEscrow.pkScript },
      amount: e.claim.amountSats,
      receiptSig: decision.receipt.signature,
      claimSig: e.claim.claimSignature,
      templateId: "",
      expiresAt: paidTerms.timeoutAt,
    };
    const built = buildSpend(claimSpend(plan, paidEscrow), info.checkpointTapscript).txid;
    return built === e.claim.txid || fail("AUDIT", `${built} != ${e.claim.txid}`);
  });
  for (const [i, r] of registrations.entries()) {
    const name = `claim registration ${i + 1}`;
    a.check(
      `${name}: the escrow terms come from the quote`,
      JSON.stringify(sortedJson(r.claim.escrow)) === JSON.stringify(sortedJson(escrowTermsFromQuote(paid))),
    );
    a.check(
      `${name}: the provider's signature and amount`,
      r.claim.claimSig === e.claim.claimSignature && r.claim.amount === e.claim.amountSats,
    );
    a.check(`${name}: the payer's receipt`, r.claim.receiptSig === decision?.receipt?.signature);
    a.check(
      `${name}: the variables are the claim's`,
      JSON.stringify(r.request.variables) === JSON.stringify(claimVariables(r.claim)),
    );
    a.check(
      `${name}: spends the escrow coin only`,
      JSON.stringify(r.request.outpoints) === JSON.stringify([`${r.claim.coin.txid}:${r.claim.coin.vout}`]),
    );
    verifyRequest(a, name, r.request, terms.pairs[r.pair]);
  }
  a.attempt("the provider's claim signature verifies under its workload key", () =>
    verify(
      e.claim.claimSignature,
      claimMessage(paid.quoteId, e.claim.amountSats),
      paid.body.providerWorkloadKey,
    ),
  );
  a.check("the provider was paid the claim", e.claim.paidSats === e.claim.amountSats);
  a.check(
    "the unused escrow was refunded in full",
    e.refund.treasurySats === Number(quotes.unpaid.body.capSats),
  );
  a.attempt(
    `the refund, executed by the ${e.refund.executedBy ?? "watch"}, is the one the refund leaf builds`,
    () => {
      const unpaidTerms = escrowTermsFromQuote(quotes.unpaid) as EscrowTerms;
      const unpaidEscrow = instantiate(ARTIFACTS.escrow, escrowArguments(unpaidTerms), keys);
      const coin = e.escrows.unpaid.coin as { txid: string; vout: number; amountSats: number };
      const built = buildSpend(
        refundSpend(
          {
            escrow: unpaidTerms,
            coin: {
              txid: coin.txid,
              vout: coin.vout,
              amount: coin.amountSats,
              script: unpaidEscrow.pkScript,
            },
            templateId: "",
            expiresAt: 0,
          },
          unpaidEscrow,
        ),
        info.checkpointTapscript,
      ).txid;
      return built === e.refund.txid || fail("AUDIT", `${built} != ${e.refund.txid}`);
    },
  );

  // The withdrawal: a pair's attestations and request, for the approved destination.
  type Part = {
    status: string;
    txid: string;
    arkTxid?: string;
    attempts?: Attempt[];
    plan: SendPlan;
    request: SpendRequest;
  };
  a.check("the withdrawal has completed parts", Array.isArray(e.withdrawal) && e.withdrawal.length > 0);
  for (const [i, part] of (e.withdrawal as Part[]).entries()) {
    const name = `withdrawal part ${i + 1}`;
    const pairKey = terms.pairs[part.plan.pair!];
    a.check(
      `${name}: variables are the treasury's terms`,
      JSON.stringify(part.plan.variables) ===
        JSON.stringify(treasuryPlanVariables(terms, sendTerms(part.plan))),
    );
    a.check(`${name}: pays the provider's wallet`, part.plan.destination === e.provider.payoutScript);
    verifySend(a, name, part.plan, part.request, treasury, info.checkpointTapscript, pairKey, part, profile);
    verifyRequest(a, name, part.request, pairKey);
  }

  // The sweep: the payout wallet's owner signs, and the wallet derives from that owner.
  const walletTerms: WalletTerms = {
    owner: e.provider.payoutOwner,
    exitDelaySeconds: info.unilateralExitDelay,
    renewalWindowSeconds: e.provider.payoutWallet.renewalWindowSeconds,
    maxFeeSats: e.provider.payoutWallet.maxFeeSats,
  };
  const wallet = instantiate(ARTIFACTS.wallet, walletArguments(walletTerms), keys);
  a.check("the payout wallet derives from its owner", wallet.pkScript === e.provider.payoutScript);
  const owner = hex(xOnly(walletTerms.owner));
  a.check("the sweep has completed parts", Array.isArray(e.sweep) && e.sweep.length > 0);
  for (const [i, part] of (e.sweep as Part[]).entries()) {
    const name = `sweep part ${i + 1}`;
    a.check(
      `${name}: variables are the wallet's terms`,
      JSON.stringify(part.plan.variables) ===
        JSON.stringify(walletPlanVariables(walletTerms, sendTerms(part.plan))),
    );
    a.check(`${name}: pays the treasury`, part.plan.destination === e.hive.treasuryScript);
    verifySend(a, name, part.plan, part.request, wallet, info.checkpointTapscript, owner, part, profile);
    verifyRequest(a, name, part.request, owner);
  }

  if (e.cashout) {
    if (profile.version === 2) {
      a.check("the cash-out funding authority is recorded", Boolean(e.cashout.funding?.journal));
      if (e.cashout.funding?.journal) {
        const part = e.cashout.funding.journal as Part;
        verifySend(
          a,
          "cash-out funding",
          part.plan,
          part.request,
          wallet,
          info.checkpointTapscript,
          owner,
          part,
          profile,
        );
        verifyRequest(a, "cash-out funding", part.request, owner);
        a.check(
          "the cash-out funding pays the lockup",
          part.plan.destination === e.cashout.lockup.script &&
            part.plan.amount === e.cashout.fundAmount &&
            part.txid === e.cashout.funding.txid,
        );
        a.attempt("the cash-out funding output is the rebuilt payment", () => {
          const signatures = part.plan.coins.map((_, i) => part.request.variables[`sig_${i}`]!);
          const tx = buildSpend(sendSpend(part.plan, wallet, signatures), info.checkpointTapscript).arkTx;
          const output = tx.getOutput(e.cashout.funding.outpoint.vout);
          return (
            tx.id === e.cashout.funding.outpoint.txid &&
            output.amount === BigInt(e.cashout.fundAmount) &&
            hex(output.script!) === e.cashout.lockup.script
          );
        });
      }
      a.attempt("the cash-out settlement transaction reveals the preimage", () => {
        const tx = parseArkTx(e.cashout.settlement.transaction);
        return (
          tx.id === e.cashout.settlement.claimTxid &&
          revealedPreimage(tx, e.cashout.paymentHash) === e.cashout.settlement.preimage
        );
      });
    }
    a.check(
      "the cash-out settled on the invoice's preimage",
      sha256Hex(unhex(e.cashout.settlement.preimage)) === e.cashout.paymentHash,
    );
    a.check("the cash-out fee is the quoted spread", e.cashout.fundAmount >= e.cashout.invoiceSats);
  }
  const cashed = e.cashout ? Number(e.cashout.fundAmount) : 0;
  // Renewals the delegatee made during the run, each paid from the coins it renewed.
  const renewals = (e.renewals ?? []) as {
    script: string;
    commitmentTxid: string;
    renewed: { outpoint: string; amountSats: number | null }[];
    outputs: { outpoint: string; amountSats: number }[];
    feeSats: number;
  }[];
  for (const r of renewals) {
    const limit =
      r.script === e.hive.treasuryScript ? e.hive.renewal.maxFeeSats : e.provider.payoutWallet.maxFeeSats;
    const inSats = r.renewed.reduce((n, c) => n + (c.amountSats ?? Number.NaN), 0);
    const outSats = r.outputs.reduce((n, c) => n + c.amountSats, 0);
    a.check(
      `renewal ${r.commitmentTxid.slice(0, 16)}: an account's own coins, fee within its limit`,
      [e.hive.treasuryScript, e.provider.payoutScript].includes(r.script) &&
        r.outputs.length > 0 &&
        r.feeSats === inSats - outSats &&
        r.feeSats >= 0 &&
        r.feeSats <= limit * r.renewed.length,
    );
  }
  const renewalFees = renewals.reduce((n, r) => n + r.feeSats, 0);
  a.check("the renewal fees add up", renewalFees === (e.renewalFees ?? 0));
  a.check(
    "everything but the cash-out and the renewal fees returned to the treasury",
    e.balances.treasurySats === 60_000 - cashed - renewalFees,
  );
  a.check(
    "no sats remain in the escrows or the wallet",
    e.balances.providerWalletSats + e.balances.paidEscrowSats + e.balances.unpaidEscrowSats === 0,
  );
}

function auditRefusals(a: Audit, e: Evidence, profile: EvidenceProfile): void {
  a.check("no refusal check failed", Array.isArray(e.failed) && e.failed.length === 0);
  a.check(
    "exactly the required refusal cases are recorded",
    JSON.stringify(Object.keys(e.checks ?? {}).sort()) === JSON.stringify([...profile.refusalCases].sort()),
  );
  if (profile.version === 2) {
    const derived = refusalChecks(
      e.results ?? {},
      e.status === "offline-smoke" ? "offline" : "live",
      e.expectedPaidSats,
    );
    for (const name of profile.refusalCases) {
      a.check(`refusal: ${name}`, derived[name] === true);
      a.check(`refusal ${name}: saved check follows its observations`, e.checks?.[name] === derived[name]);
    }
    return;
  }
  for (const name of profile.refusalCases) a.check(`refusal: ${name}`, e.checks?.[name] === true);
  a.check("the forged claim never moved the escrow", e.results.escrowAfterForgedClaim?.spent === false);
  a.check("the swapped send never moved the treasury", e.results.treasuryAfterSwappedSend?.spent === false);
}

function auditRenewal(a: Audit, e: Evidence, profile: EvidenceProfile): void {
  const max = e.treasury.renewal.maxFeeSats;
  const treasuryScript = parseArkAddress(e.treasury.address).pkScript;
  a.check(
    "the wallet script matches its address",
    parseArkAddress(e.wallet.address).pkScript === e.wallet.script,
  );
  a.check(
    "both treasury and wallet renewals are recorded",
    Array.isArray(e.renewals) &&
      e.renewals.length >= 2 &&
      new Set(e.renewals.map((r: Evidence) => r.script)).size === 2 &&
      e.renewals.some((r: Evidence) => r.script === e.wallet.script) &&
      e.renewals.some((r: Evidence) => r.script === treasuryScript) &&
      new Set(e.renewals.map((r: Evidence) => r.outpoint)).size === e.renewals.length,
  );
  for (const r of e.renewals as Evidence[]) {
    a.check(`${r.outpoint}: renewed`, r.renewed !== null);
    a.check(
      `${r.outpoint}: distinct complete replacement identity`,
      typeof r.renewed?.outpoint === "string" &&
        /^[0-9a-f]{64}:\d+$/.test(r.renewed.outpoint) &&
        e.renewals.filter((other: Evidence) => other.renewed?.outpoint === r.renewed.outpoint).length === 1,
    );
    if (profile.version === 2)
      a.check(
        `${r.outpoint}: replacement observation matches the account and batch`,
        r.renewed?.script === r.script &&
          Array.isArray(r.renewed.commitmentTxids) &&
          r.renewed.commitmentTxids.includes(r.commitmentTxid),
      );
    if (r.script === treasuryScript)
      a.check(
        `${r.outpoint}: replacement is attributed to its renewal inputs`,
        (e.view.renewals as Evidence[]).some(
          (coin) =>
            `${coin.txid}:${coin.vout}` === r.renewed?.outpoint &&
            coin.amountSats === r.renewed.amountSats &&
            coin.commitmentTxid === r.commitmentTxid &&
            coin.sources.includes(r.outpoint),
        ) &&
          !(e.view.contributions as Evidence[]).some(
            (coin) => `${coin.txid}:${coin.vout}` === r.renewed?.outpoint,
          ),
      );
    a.check(
      `${r.outpoint}: fee within the leaf's limit`,
      Number.isSafeInteger(r.feeSats) &&
        r.feeSats >= 0 &&
        r.feeSats <= max &&
        r.amountSats - r.renewed?.amountSats === r.feeSats,
    );
    a.check(`${r.outpoint}: the renewed coin outlives the old`, r.renewed?.expiresAt > r.expiredAt);
    a.check(
      `${r.outpoint}: the delegatee reports the renewal`,
      (e.delegatee.attempts as { outpoints: string[]; success: boolean; txid: string }[]).some(
        (t) => t.success && t.txid === r.commitmentTxid && t.outpoints.includes(r.outpoint),
      ),
    );
  }
}

const AUDITS: Record<string, [Suite, (a: Audit, e: Evidence, profile: EvidenceProfile) => void]> = {
  "lifecycle.json": ["lifecycle", auditLifecycle],
  "refusals.json": ["refusals", auditRefusals],
  "renewal.json": ["renewal", auditRenewal],
};

function runs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((s) => s.isDirectory())
    .flatMap((suite) =>
      readdirSync(resolve(root, suite.name), { withFileTypes: true })
        .filter((r) => r.isDirectory())
        .map((r) => resolve(root, suite.name, r.name)),
    );
}

// Runs recorded before the project took the Hive name carry the old schema prefix and keep the
// hive's own section under its old key; read them under the current names.
const RECORDED_PREFIX = "buzzpool-";

function currentNames(evidence: Evidence): Evidence {
  if (typeof evidence.schema !== "string" || !evidence.schema.startsWith(RECORDED_PREFIX)) return evidence;
  const { pool: section, ...rest } = evidence;
  return {
    ...rest,
    schema: `hive-${evidence.schema.slice(RECORDED_PREFIX.length)}`,
    ...(section === undefined ? {} : { hive: section }),
  };
}

export function auditRun(
  directory: string,
  options: { funded: boolean } = { funded: true },
): { run: string; checks: Check[]; stopped: boolean } {
  const a = new Audit();
  const files = readdirSync(directory);
  const result = files.find((f) => f in AUDITS);
  if (!result) {
    a.check("the run has a result", files.includes("failure.json"), "neither a result nor a failure record");
    return {
      run: directory,
      checks: a.checks.map((c) => ({ ...c, name: `stopped run: ${c.name}` })),
      stopped: true,
    };
  }
  const [suite, audit] = AUDITS[result]!;
  const evidence = currentNames(JSON.parse(readFileSync(resolve(directory, result), "utf8")) as Evidence);
  a.check("schema", evidence.schema === `hive-${suite}/v4`);
  a.check("nothing skipped", evidence.skipped === 0);
  // An offline smoke run moves no value and never counts as funded evidence.
  a.check(
    "status",
    (options.funded ? ["passed"] : ["passed", "offline-smoke"]).includes(evidence.status),
    evidence.status,
  );
  a.check("source hashes recorded", evidence.sourceSha256 && Object.keys(evidence.sourceSha256).length > 0);
  try {
    const profile = evidenceProfile(suite, evidence);
    a.check(`evidence schema version ${profile.version}`, true);
    if (options.funded) a.check("funded evidence uses the current schema", profile.version === 2);
    audit(a, evidence, profile);
  } catch (error) {
    a.check("evidence readable", false, error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
  return { run: directory, checks: a.checks, stopped: false };
}

function main(argv: string[]): void {
  const explicit = argv.find((arg) => !arg.startsWith("--"));
  const offline = argv.includes("--offline");
  const root = offline
    ? evidenceRoot(resolve(LOCAL_ROOT, "offline-evidence"))
    : resolve(repositoryRoot, "docs/evidence/v4");
  const directories = explicit ? [resolve(explicit)] : runs(root);
  const funded = !offline && !(explicit && resolve(explicit).startsWith(`${LOCAL_ROOT}/`));
  const results = directories.map((d) => auditRun(d, { funded }));
  const failures = results.flatMap((r) =>
    r.checks.filter((c) => !c.ok).map((c) => ({ run: relative(repositoryRoot, r.run), ...c })),
  );
  // A stopped run is history, not a failure; a suite whose every run stopped has proved nothing.
  const suites = new Map<string, boolean>();
  for (const r of results) {
    const suite = relative(root, resolve(r.run, ".."));
    suites.set(suite, (suites.get(suite) ?? false) || !r.stopped);
  }
  const unproven = [...suites].filter(([, passed]) => !passed).map(([suite]) => suite);
  const report = {
    schema: "hive-audit/v4",
    tool: { path: "tools/audit.ts", sha256: sha256Hex(readFileSync(new URL(import.meta.url))) },
    root: relative(repositoryRoot, root),
    funded,
    runs: results.map((r) => ({
      run: relative(repositoryRoot, r.run),
      stopped: r.stopped,
      checks: r.checks.length,
      failed: r.checks.filter((c) => !c.ok).length,
    })),
    checks: results.reduce((n, r) => n + r.checks.length, 0),
    unproven,
    failures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length || unproven.length || results.length === 0) process.exitCode = 1;
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
