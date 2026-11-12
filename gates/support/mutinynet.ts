import { spawnSync } from "node:child_process";
import { ensure, readBoundedResponse } from "@hive/kit";
import { decodeInvoice } from "@hive/protocol";

/**
 * The Mutinynet faucet as the outside world's Lightning wallet. It pays the
 * hive's invoices through `mutinynet-cli`, which keeps its own login
 * (`mutinynet-cli login`) out of this process, and issues the invoices
 * providers cash out to. `BUZZ_FAUCET_CLI` names the CLI.
 */
export const MUTINYNET_LNURL = "https://lnurl.mutinynet.arkade.sh";
export const MUTINYNET_RELAY = "wss://nostr.arkade.sh/";
const FAUCET_URL = process.env.MUTINYNET_FAUCET_URL ?? "https://faucet.mutinynet.com";

/**
 * The faucet pays `invoice`; the CLI prints the payment hash, which must be the
 * invoice's own. Without the CLI the invoice is printed for a person to pay at
 * https://faucet.mutinynet.com, and the gate waits for the payment to land.
 */
export async function faucetPays(invoice: string): Promise<void> {
  const expected = decodeInvoice(invoice);
  ensure(expected.network === "signet", "FAUCET_INVOICE", "not a Mutinynet invoice");
  const cli = process.env.BUZZ_FAUCET_CLI ?? "mutinynet-cli";
  if (spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 }).status !== 0) {
    process.stdout.write(
      `${JSON.stringify({ action: "pay this invoice from https://faucet.mutinynet.com (Lightning tab)", invoice })}\n`,
    );
    return;
  }
  const result = spawnSync(cli, ["lightning", invoice], { encoding: "utf8", timeout: 120_000 });
  ensure(result.status === 0, "FAUCET_PAYMENT", (result.stderr || result.stdout || "").trim().slice(0, 300));
  const paymentHash = result.stdout.trim().split("\n").at(-1)?.trim();
  ensure(paymentHash === expected.paymentHash, "FAUCET_PAYMENT", "the faucet reported another payment");
}

/** An invoice from the faucet's own node; issuing one needs no login. */
export async function faucetInvoice(amountSats: number): Promise<string> {
  const response = await fetch(`${FAUCET_URL}/api/bolt11`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount_sats: amountSats }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = JSON.parse((await readBoundedResponse(response, 16 * 1024)).toString("utf8")) as {
    bolt11?: string;
  };
  ensure(response.ok && typeof body.bolt11 === "string", "FAUCET_INVOICE", `status ${response.status}`);
  const facts = decodeInvoice(body.bolt11);
  ensure(facts.network === "signet" && facts.amountSats === amountSats, "FAUCET_INVOICE");
  return body.bolt11;
}
