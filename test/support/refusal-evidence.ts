import {
  type ClaimPlan,
  claimMessage,
  claimSpend,
  claimVariables,
  connect,
  type EscrowTerms,
  escrowAccount,
  escrowClaimTemplate,
  pairKeys,
  planVariables,
  receiptMessage,
  sendMessages,
  sendSpend,
  signedSend,
  signTogether,
  spendRequestFor,
  type TreasuryTerms,
  treasuryAccount,
  treasuryVariables,
  xOnly,
} from "@hive/ark";
import { type Action, buildSpend, restEmulator, type SpendRequest, selfRoute } from "@hive/executor";
import { hex } from "@hive/kit";
import { planTreasurySend, type Treasury } from "@hive/hive";
import { escrowTermsFromQuote } from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { captureRejection, type RejectionBasis, type RejectionRecord } from "../../gates/support/covenant.js";
import { startFakeNetwork } from "./fake-network.js";
import { makeQuote } from "./quotes.js";

export interface RefusalFixtureContext {
  fake: Awaited<ReturnType<typeof startFakeNetwork>>;
  conn: Awaited<ReturnType<typeof connect>>;
  claimAction: Action;
  sendAction: Action;
}

/** Fresh public rejection records from both real client routes against the offline model. */
export async function refusalProofFixture(
  inspect?: (context: RefusalFixtureContext) => Promise<void>,
): Promise<Record<string, unknown>> {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 172800 });
  try {
    const conn = await connect(fake.deployment());
    const secrets = [0, 1, 2].map(() => schnorr.utils.randomSecretKey());
    const keys = secrets.map((key) => hex(secp256k1.getPublicKey(key, true))) as [string, string, string];
    const terms: TreasuryTerms = {
      pairs: pairKeys(keys),
      exitDelaySeconds: fake.exitDelaySeconds,
      renewalWindowSeconds: 600,
      maxFeeSats: 500,
    };
    const treasuryAccountValue = await treasuryAccount(conn, terms);
    const treasury: Treasury = {
      conn,
      terms,
      stewardKeys: keys,
      stewards: [] as never,
      artifactId: treasuryAccountValue.artifactId,
    };
    const pair = (message: Uint8Array) => signTogether([secrets[1]!, secrets[2]!], keys, "12", message);
    const { quote, secrets: roleKeys } = makeQuote({
      operatorKey: hex(xOnly(conn.keys.server)),
      emulatorKey: hex(xOnly(conn.keys.emulator)),
      treasuryScript: treasuryAccountValue.pkScript,
      stewardPairKeys: [terms.pairs["01"], terms.pairs["02"], terms.pairs["12"]],
      exitDelaySeconds: String(fake.exitDelaySeconds),
    });
    const escrowTerms = escrowTermsFromQuote(quote) as EscrowTerms;
    const escrow = await escrowAccount(conn, escrowTerms);
    const coin = fake.mint(escrow.pkScript, 20_000);
    const until = Math.floor(Date.now() / 1000) + 300;
    const claim: ClaimPlan = {
      escrow: escrowTerms,
      coin: { txid: coin.txid, vout: coin.vout, amount: coin.amount, script: coin.script },
      amount: coin.amount,
      expiresAt: until,
      receiptSig: hex(
        schnorr.sign(receiptMessage(quote.quoteId, coin.amount), schnorr.utils.randomSecretKey()),
      ),
      claimSig: hex(schnorr.sign(claimMessage(quote.quoteId, coin.amount), roleKeys.workload)),
      templateId: await conn.delegatee.registerTemplate(escrowClaimTemplate(escrow.artifactId, false)),
    };
    const claimRequest = spendRequestFor(
      claim.templateId,
      claimVariables(claim),
      [`${coin.txid}:${coin.vout}`],
      until,
      terms.pairs["12"],
    );
    const claimAction = {
      txid: "",
      spend: claimSpend(claim, escrow.instance),
      request: claimRequest.request(pair(claimRequest.message)),
      validUntil: until,
    };
    claimAction.txid = buildSpend(claimAction.spend, conn.operator.checkpointTapscript).txid;
    fake.mint(treasuryAccountValue.pkScript, 5000);
    const plan = await planTreasurySend(treasury, {
      pair: "12",
      amount: 1000,
      destination: `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`,
      validSeconds: 300,
    });
    const signatures = sendMessages(
      plan,
      treasuryAccountValue.instance,
      conn.operator.checkpointTapscript,
    ).map(pair);
    const swapped = {
      ...plan,
      destination: `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`,
    };
    const sendVariables = {
      ...planVariables(treasuryVariables(terms), swapped),
      ...Object.fromEntries(signatures.map((sig, i) => [`sig_${i}`, sig])),
    };
    const sendRequest = spendRequestFor(
      plan.templateId,
      sendVariables,
      signedSend(plan, signatures).outpoints,
      plan.validUntil,
      terms.pairs["12"],
    );
    const sendAction = {
      txid: "",
      spend: sendSpend(swapped, treasuryAccountValue.instance, signatures),
      request: sendRequest.request(pair(sendRequest.message)),
      validUntil: plan.validUntil,
    };
    sendAction.txid = buildSpend(sendAction.spend, conn.operator.checkpointTapscript).txid;
    const self = selfRoute({
      emulator: restEmulator(fake.emulatorUrl),
      emulatorKey: conn.keys.emulator,
      serverKey: conn.keys.server,
      checkpointTapscript: conn.operator.checkpointTapscript,
      prevTxs: { getVirtualTxs: async (txids) => ({ txs: await conn.arkd.virtualTxs(txids) }) },
    });
    await inspect?.({ fake, conn, claimAction, sendAction });
    const results: Record<string, RejectionRecord> = {};
    for (const [label, route, action] of [
      ["selfForgedClaim", "self", claimAction],
      ["selfSwappedSend", "self", sendAction],
      ["compromisedClaim", "delegatee", claimAction],
      ["compromisedSend", "delegatee", sendAction],
    ] as const) {
      results[label] = await captureRejection({
        record: {
          label,
          route,
          basis: (label.endsWith("Claim")
            ? { kind: "forged-claim", plan: claim, keys: conn.keys }
            : {
                kind: "swapped-send",
                plan,
                destination: swapped.destination,
                signatures,
                treasury: terms,
                keys: conn.keys,
              }) as RejectionBasis,
          action: action as Action & { spend: typeof action.spend; request: SpendRequest },
          checkpointTapscript: conn.operator.checkpointTapscript,
        },
        mode: "offline",
        observe: () => conn.arkd.coins({ outpoints: action.request.outpoints }),
        model: () => fake.covenantRejections,
        async submit() {
          if (route === "self") return { answer: await self.submit(action) };
          const posted = await conn.delegatee.spend(action.request);
          fake.tick();
          return {
            answer: { result: "accepted", reference: posted.id },
            attempt: (await conn.delegatee.spendState(posted.id)).attempts[0]!,
          };
        },
      });
    }
    const amount = 1000;
    const genuinePlan = {
      ...claim,
      amount,
      receiptSig: hex(schnorr.sign(receiptMessage(quote.quoteId, amount), roleKeys.payer)),
      claimSig: hex(schnorr.sign(claimMessage(quote.quoteId, amount), roleKeys.workload)),
    };
    const genuine = claimSpend(genuinePlan, escrow.instance);
    const txid = buildSpend(genuine, conn.operator.checkpointTapscript).txid;
    await self.submit({ txid, spend: genuine, validUntil: until });
    return {
      ...results,
      providerPaid: amount,
      genuineClaimExecution: {
        plan: genuinePlan,
        txid,
        spend: genuine,
        checkpointTapscript: conn.operator.checkpointTapscript,
        outputs: await conn.arkd.coins({ scripts: [genuine.outputs[0]!.script] }),
      },
    };
  } finally {
    await fake.close();
  }
}
