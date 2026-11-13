import {
  delegateeRoute,
  observeSpend,
  type Route,
  type RouteName,
  Router,
  restEmulator,
  selfRoute,
  validateCheckpoint,
} from "@hive/executor";
import { ensure, fail, guard, mainnetEnabled } from "@hive/kit";
import type { ServiceKeys } from "./contract.js";
import { Arkd, Delegatee, type FetchLike, type OperatorInfo } from "./services.js";
import { AUTHORIZATION_GRACE_SECONDS } from "./spends.js";
import { type Network, xOnly } from "./taproot.js";

/**
 * Everything that ties the code to one network: the Arkade Operator, the
 * delegatee, and on public networks the keys both must report. A pinned key
 * that changes stops the hive until the pin is updated with a dated decision.
 */
export interface Deployment {
  network: Network;
  arkdUrl: string;
  delegateeUrl: string;
  /** The Emulator, for spends a participant executes itself; without it only the delegatee executes. */
  emulatorUrl?: string;
  pins?: {
    /** Operator signer, compressed. */
    operatorKey: string;
    /** Emulator signer, compressed. */
    emulatorKey: string;
    /** The delegatee's cosigner key, compressed; it is part of every renewable address. */
    delegateKey: string;
    exitDelaySeconds: number;
  };
}

/**
 * Ark Labs' public Mutinynet, read on October 9 and 10, 2026: the Operator,
 * the Emulator and the delegatee from its `/v1/info`.
 */
export const MUTINYNET: Deployment = {
  network: "mutinynet",
  arkdUrl: "https://mutinynet.arkade.sh",
  delegateeUrl: "https://delegatee.mutinynet.arkade.sh",
  emulatorUrl: "https://emulator.mutinynet.arkade.sh",
  pins: {
    operatorKey: "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a",
    emulatorKey: "03f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a",
    delegateKey: "03b7b369269133f17056e659f8f62b1a3adeb6217cabff6c216a9042d8de58eefb",
    exitDelaySeconds: 2048,
  },
};

/** A local stack: its keys are generated per stack and read from it. */
export function regtestDeployment(
  arkdUrl = process.env.BUZZ_ARKD_URL ?? "http://localhost:7070",
  delegateeUrl = process.env.BUZZ_DELEGATEE_URL ?? "http://localhost:7090",
  emulatorUrl = process.env.BUZZ_EMULATOR_URL ?? "http://localhost:7073",
): Deployment {
  return { network: "regtest", arkdUrl, delegateeUrl, emulatorUrl };
}

/**
 * The order in which routes execute spends: `BUZZ_EXECUTION`, a comma list
 * of `self` and `delegatee`, defaults to executing ourselves first and
 * handing over to the delegatee when we cannot.
 */
export function executionOrder(): RouteName[] {
  const order = (process.env.BUZZ_EXECUTION ?? "self,delegatee").split(",").map((s) => s.trim());
  ensure(
    order.length > 0 &&
      order.every((r) => r === "self" || r === "delegatee") &&
      new Set(order).size === order.length,
    "INVALID",
    "BUZZ_EXECUTION lists self and delegatee",
  );
  return order as RouteName[];
}

/**
 * Ark Labs' mainnet Operator, read on November 13, 2026, with the delegatee the hive's own server
 * runs (`tools/delegatee.sh` with `DELEGATEE_NETWORK=bitcoin`). The Operator's key and exit delay and
 * the Emulator's key are pinned here; the delegatee's address and its delegate key come from the
 * server that runs it, through `BUZZ_DELEGATEE_URL` and `BUZZ_DELEGATE_KEY`. No Emulator address is
 * named: payments go through the delegatee, never executed here. Real funds need
 * `BUZZ_MAINNET=enabled` as well.
 */
export const MAINNET_PINS = {
  operatorKey: "038202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
  emulatorKey: "0239c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e",
  exitDelaySeconds: 605_184,
} as const;

export function mainnetDeployment(
  delegateeUrl = process.env.BUZZ_DELEGATEE_URL,
  delegateKey = process.env.BUZZ_DELEGATE_KEY,
): Deployment {
  ensure(mainnetEnabled(), "MAINNET_DISABLED", "set BUZZ_MAINNET=enabled to use real funds");
  ensure(
    delegateeUrl && delegateKey,
    "NO_DELEGATEE",
    "set BUZZ_DELEGATEE_URL and BUZZ_DELEGATE_KEY to the delegatee this hive's server runs",
  );
  ensure(
    /^0[23][0-9a-f]{64}$/.test(delegateKey),
    "INVALID",
    "BUZZ_DELEGATE_KEY is the delegatee's compressed delegate key",
  );
  ensure(
    /^https:\/\//.test(delegateeUrl) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(delegateeUrl),
    "INVALID",
    "the delegatee's address",
  );
  return {
    network: "bitcoin",
    arkdUrl: "https://arkade.computer",
    delegateeUrl: delegateeUrl.replace(/\/+$/, ""),
    pins: { ...MAINNET_PINS, delegateKey },
  };
}

export function deploymentFor(network: string): Deployment {
  if (network === "regtest") return regtestDeployment();
  if (network === "mutinynet") return MUTINYNET;
  if (network === "bitcoin") return mainnetDeployment();
  return fail("UNSUPPORTED_NETWORK", network);
}

/**
 * Hard ceilings for real funds. Stewards refuse an escrow
 * above `escrowSats`, and the hive page refuses a contribution above
 * `contributionSats` or once the treasury holds `treasurySats`.
 */
export const MAINNET_CEILINGS = {
  escrowSats: 50_000,
  contributionSats: 100_000,
  treasurySats: 1_000_000,
} as const;

export const networkCeilings = (network: Network): typeof MAINNET_CEILINGS | undefined =>
  network === "bitcoin" ? MAINNET_CEILINGS : undefined;

/**
 * How long an escrow's coin must outlive its deadline. The delegatee refunds
 * once the chain's median time passes the deadline, and the escrow has no
 * renewal leaf, so the refund must land before the batch expires. Median time
 * trails the clock by about six blocks: an hour on mainnet, minutes on
 * Mutinynet and on a regtest stack that mines on demand.
 */
export const REFUND_MARGIN_SECONDS: Record<Network, number> = {
  regtest: 600,
  mutinynet: 1800,
  bitcoin: 3 * 3600,
};

/** A connection to both services, checked against each other and the pins. */
export interface Connection {
  deployment: Deployment;
  arkd: Arkd;
  delegatee: Delegatee;
  operator: OperatorInfo;
  keys: ServiceKeys;
  /** Executes spends: ourselves through the Emulator, or the delegatee, in `executionOrder()`. */
  router: Router;
}

export async function connect(deployment: Deployment, fetchImpl?: FetchLike): Promise<Connection> {
  const arkd = new Arkd(deployment.arkdUrl, fetchImpl);
  const delegatee = new Delegatee(deployment.delegateeUrl, fetchImpl);
  const [operator, info] = await Promise.all([arkd.info(), delegatee.info()]);
  const expected = deployment.network === "mutinynet" ? "mutinynet" : deployment.network;
  ensure(operator.network === expected, "DEPLOYMENT_MISMATCH", `the Operator is on ${operator.network}`);
  ensure(info.network === expected, "DEPLOYMENT_MISMATCH", `the delegatee is on ${info.network}`);
  ensure(
    info.serverPubkey === operator.signerPubkey,
    "DEPLOYMENT_MISMATCH",
    "the delegatee serves another Operator",
  );
  ensure(
    /^(?:[0-9a-f]{64}|0[23][0-9a-f]{64})$/i.test(operator.forfeitPubkey),
    "DEPLOYMENT_MISMATCH",
    "invalid advertised forfeit key",
  );
  guard("DEPLOYMENT_MISMATCH", () =>
    validateCheckpoint(operator.checkpointTapscript, {
      exitDelaySeconds: operator.unilateralExitDelay,
      forfeitKey: xOnly(operator.forfeitPubkey),
    }),
  );
  const pins = deployment.pins;
  if (pins) {
    ensure(operator.signerPubkey === pins.operatorKey, "DEPLOYMENT_PIN", "Operator key");
    ensure(info.emulatorPubkey === pins.emulatorKey, "DEPLOYMENT_PIN", "Emulator key");
    ensure(info.delegatePubkey === pins.delegateKey, "DEPLOYMENT_PIN", "delegate key");
    ensure(operator.unilateralExitDelay === pins.exitDelaySeconds, "DEPLOYMENT_PIN", "exit delay");
  }
  const routes: Route[] = [];
  for (const name of executionOrder()) {
    if (name === "delegatee")
      routes.push(
        delegateeRoute({ url: deployment.delegateeUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
      );
    if (name === "self" && deployment.emulatorUrl) {
      routes.push(
        selfRoute({
          emulator: restEmulator(deployment.emulatorUrl),
          emulatorKey: info.emulatorPubkey,
          prevTxs: (context) => ({
            getVirtualTxs: async (txids) => ({ txs: await arkd.virtualTxs(txids, context.signal) }),
          }),
          checkpointTapscript: operator.checkpointTapscript,
          serverKey: operator.signerPubkey,
        }),
      );
    }
  }
  const router = new Router({
    routes,
    graceSeconds: AUTHORIZATION_GRACE_SECONDS,
    observe: observeSpend({
      coins: (query, signal) => arkd.coins(query, signal),
      checkpointTapscript: operator.checkpointTapscript,
    }),
  });
  return {
    deployment,
    arkd,
    delegatee,
    operator,
    keys: { server: operator.signerPubkey, emulator: info.emulatorPubkey, delegate: info.delegatePubkey },
    router,
  };
}
