/**
 * Runs the site locally with three sample hives: `pnpm dev [--port 8790]`.
 * The pages are read from `app/` on every request, so an edit to
 * `app/hives.html` or `app/page.html` shows on the next refresh, and `pnpm dev`
 * restarts this process when a TypeScript file changes. Every number, key and
 * transaction id is made up for this run and kept in memory. Nothing reaches a
 * network, and chip-in stays closed because no hive takes payment requests.
 * Change the sample hives below to see the pages in other states.
 */
import { randomBytes } from "node:crypto";
import { hex } from "@hive/kit";
import type { HiveView } from "@hive/hive";
import {
  HIVE_PROFILE,
  type HiveListingBody,
  hiveListingId,
  type SignedHiveListing,
  signHiveListing,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { type HostedHive, startHiveHost } from "../app/server.js";

type Escrow = HiveView["escrows"][number];

const DAY = 1440;
const sampleHex = (bytes = 32) => randomBytes(bytes).toString("hex");
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const taprootScript = () => `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`;
const sampleAddress = () => `tark1qp${sampleHex(30)}`;

function sampleListing(
  hive: string,
  name: string,
  purpose: string,
  treasuryScript: string,
  lightningAddress: string | null,
): SignedHiveListing {
  const keepers = [0, 1, 2].map(() => schnorr.utils.randomSecretKey());
  const body: HiveListingBody = {
    profile: HIVE_PROFILE,
    network: "regtest",
    hive,
    name,
    purpose,
    stewardKeys: keepers.map((key) => hex(secp256k1.getPublicKey(key, true))) as [string, string, string],
    treasuryScript,
    lightningAddress,
    createdAt: String(Math.floor(Date.now() / 1000)),
  };
  const signatures = keepers.map((key) => signHiveListing(body, key).signature) as [string, string, string];
  return { body, listingId: hiveListingId(body), signatures };
}

const providers = [taprootScript(), taprootScript(), taprootScript()];

function sampleJob(
  status: Escrow["status"],
  model: string,
  provider: number,
  deadlineMinutes: number,
  usedSats: number,
  close?: [number, number],
): Escrow {
  return {
    escrowId: sampleHex(),
    model,
    providerPayoutScript: providers[provider] as string,
    capSats: 20_000,
    timeoutAt: minutesFromNow(deadlineMinutes),
    address: `tark1q${sampleHex(28)}`,
    coin: { txid: sampleHex(), vout: 0, amountSats: 20_000 },
    status,
    receipt: usedSats ? { amountSats: usedSats, signature: sampleHex(64) } : null,
    close: close
      ? {
          kind: close[0] > 0 ? "claim" : "refund",
          txid: sampleHex(),
          providerSats: close[0],
          treasurySats: close[1],
        }
      : null,
  };
}

function busyHive(treasuryScript: string): HiveView {
  const coin = (vout: number, amountSats: number, days: number) => ({
    txid: sampleHex(),
    vout,
    amountSats,
    expiresAt: minutesFromNow(days * DAY),
  });
  return {
    schema: "hive-view/v4",
    generatedAt: new Date().toISOString(),
    treasury: {
      address: sampleAddress(),
      script: treasuryScript,
      lightningAddress: "buzz-builders@localhost",
      balanceSats: 418_550,
      coins: [
        coin(0, 194_850, 29),
        coin(0, 100_000, 3),
        coin(1, 61_900, 28),
        coin(1, 35_000, 28),
        coin(0, 21_000, 29),
        coin(1, 5_800, 28),
      ],
    },
    contributions: [
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: 21_000,
        createdAt: minutesFromNow(-2),
        expiresAt: minutesFromNow(29 * DAY),
        spent: false,
        rail: "lightning",
      },
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: 100_000,
        createdAt: minutesFromNow(-130),
        expiresAt: minutesFromNow(3 * DAY),
        spent: false,
        rail: "arkade",
      },
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: 250_000,
        createdAt: minutesFromNow(-3 * DAY),
        expiresAt: null,
        spent: true,
        rail: "direct",
      },
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: 149_000,
        createdAt: minutesFromNow(-5 * DAY),
        expiresAt: null,
        spent: true,
        rail: "lightning",
      },
    ],
    renewals: [
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: 194_850,
        commitmentTxid: sampleHex(),
        sources: [sampleHex()],
      },
    ],
    unattributed: [],
    escrows: [
      sampleJob("refunded", "local-gguf/sha256-847545e6", 0, -4 * DAY, 0, [0, 20_000]),
      sampleJob("claimed", "local-gguf/sha256-63384c6c", 2, -3 * DAY, 11_000, [11_000, 9_000]),
      sampleJob("claimed", "local-gguf/sha256-b144db06", 1, -2 * DAY, 16_100, [16_100, 3_900]),
      sampleJob("claimed", "local-gguf/sha256-847545e6", 0, -DAY, 19_800, [20_000, 0]),
      sampleJob("claimed", "local-gguf/sha256-63384c6c", 2, -180, 14_200, [14_200, 5_800]),
      sampleJob("open", "local-gguf/sha256-b144db06", 1, 130, 12_880),
      sampleJob("open", "local-gguf/sha256-847545e6", 0, 41, 7_420),
    ],
    totals: { contributedSats: 520_000, inEscrowSats: 40_000, paidSats: 61_300, refundedSats: 38_700 },
  };
}

function quietHive(
  treasuryScript: string,
  balanceSats: number,
  contributedSats: number,
  paidSats: number,
): HiveView {
  return {
    schema: "hive-view/v4",
    generatedAt: new Date().toISOString(),
    treasury: {
      address: sampleAddress(),
      script: treasuryScript,
      lightningAddress: null,
      balanceSats,
      coins: [{ txid: sampleHex(), vout: 0, amountSats: balanceSats, expiresAt: minutesFromNow(20 * DAY) }],
    },
    contributions: [
      {
        txid: sampleHex(),
        vout: 0,
        amountSats: contributedSats,
        createdAt: minutesFromNow(-600),
        expiresAt: null,
        spent: false,
        rail: "arkade",
      },
    ],
    renewals: [],
    unattributed: [],
    escrows: [],
    totals: { contributedSats, inEscrowSats: 0, paidSats, refundedSats: 0 },
  };
}

const portFlag = process.argv.indexOf("--port");
const port = portFlag === -1 ? 8790 : Number(process.argv[portFlag + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("usage: pnpm dev [--port <1-65535>]");
  process.exit(2);
}

const builders = taprootScript();
const nightShift = taprootScript();
const openWeights = taprootScript();
const hives: HostedHive[] = [
  {
    listing: sampleListing(
      "buzz-builders",
      "Buzz Builders",
      "Inference for builders in the Buzz community.",
      builders,
      "buzz-builders@localhost",
    ),
    view: async () => busyHive(builders),
  },
  {
    listing: sampleListing(
      "night-shift",
      "Night Shift",
      "Overnight batch inference for open-source maintainers.",
      nightShift,
      null,
    ),
    view: async () => quietHive(nightShift, 1_204_000, 1_650_000, 385_700),
  },
  {
    listing: sampleListing(
      "open-weights-club",
      "Open Weights Club",
      "Benchmarks open-weight models and publishes the results.",
      openWeights,
      null,
    ),
    view: async () => quietHive(openWeights, 96_300, 140_000, 43_650),
  },
];

const host = await startHiveHost({ hives, port, livePages: true });
console.log(`Sample hives at ${host.url}/ (edit app/*.html and refresh; Ctrl-C to stop)`);
