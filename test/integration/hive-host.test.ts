import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TestContext, test } from "node:test";
import { Fault, faultCode, haltFile, hex, localPath } from "@hive/kit";
import type { HiveView } from "@hive/hive";
import {
  HIVE_PROFILE,
  type HiveListingBody,
  hiveListingId,
  type SignedHiveListing,
  signHiveListing,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { type ClaimHandIn, type HostedHive, startHiveHost } from "../../app/server.js";

/** Many hives on one server: separate paths, separate switches, one directory and one claim desk. */
const run = randomUUID().slice(0, 8);

function listing(hive: string, overrides: Partial<HiveListingBody> = {}): SignedHiveListing {
  const secrets = [0, 1, 2].map(() => schnorr.utils.randomSecretKey());
  const body: HiveListingBody = {
    profile: HIVE_PROFILE,
    network: "regtest",
    hive,
    name: `Hive ${hive}`,
    purpose: "A test hive.",
    stewardKeys: secrets.map((s) => hex(secp256k1.getPublicKey(s, true))) as [string, string, string],
    treasuryScript: `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`,
    lightningAddress: null,
    createdAt: "1791700000",
    ...overrides,
  };
  const signatures = secrets.map((s) => signHiveListing(body, s).signature) as [string, string, string];
  return { body, listingId: hiveListingId(body), signatures };
}

function view(balanceSats: number, treasuryScript: string): HiveView {
  return {
    schema: "hive-view/v4",
    generatedAt: new Date().toISOString(),
    treasury: { address: "", script: treasuryScript, lightningAddress: null, balanceSats, coins: [] },
    contributions: [],
    renewals: [],
    unattributed: [],
    escrows: [],
    totals: { contributedSats: balanceSats, inEscrowSats: 0, paidSats: 0, refundedSats: 0 },
  };
}

async function host(t: TestContext, extra: Partial<Record<"a" | "b", Partial<HostedHive>>> = {}) {
  const ids = { a: `a-${run}`, b: `b-${run}` };
  const claims: { hive: string; body: ClaimHandIn }[] = [];
  const entry = (key: "a" | "b", balance: number): HostedHive => {
    const signed = listing(ids[key]);
    return {
      listing: signed,
      view: async () => view(balance, signed.body.treasuryScript),
      intake: {
        // Nothing listens here: a pour that passes the halt check fails on the way out.
        endpoint: { baseUrl: "http://127.0.0.1:9", username: key },
        network: "regtest",
        operatorKey: hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey())),
        requestsDirectory: localPath("v4-test", "hive-host", run, key),
      },
      claimDesk: async (body) => {
        claims.push({ hive: ids[key], body });
        return { spendId: `${key}-spend` };
      },
      ...extra[key],
    };
  };
  const hives = { a: entry("a", 418_550), b: entry("b", 96_300) };
  const served = await startHiveHost({ hives: [hives.a, hives.b] });
  t.after(async () => {
    await served.close();
    rmSync(localPath("v4-test", "hive-host", run), { recursive: true, force: true });
  });
  return { url: served.url, ids, hives, claims };
}

const json = async (response: Response) => [response.status, await response.json()] as const;
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a host serves each hive under its own path and lists them all", async (t) => {
  const { url, ids } = await host(t);
  const [status, { hives }] = await json(await fetch(`${url}/api/hives`));
  assert.equal(status, 200);
  assert.deepEqual(
    hives.map((h: { hive: string; balanceSats: number; halted: boolean }) => [
      h.hive,
      h.balanceSats,
      h.halted,
    ]),
    [
      [ids.a, 418_550, false],
      [ids.b, 96_300, false],
    ],
  );
  const balance = async (id: string) =>
    ((await (await fetch(`${url}/h/${id}/api/view`)).json()) as HiveView).treasury.balanceSats;
  assert.deepEqual([await balance(ids.a), await balance(ids.b)], [418_550, 96_300]);
  // Without its slash a hive's address redirects, so the page's relative calls stay inside the hive.
  const bare = await fetch(`${url}/h/${ids.a}`, { redirect: "manual" });
  assert.deepEqual([bare.status, bare.headers.get("location")], [308, `/h/${ids.a}/`]);
  assert.match(await (await fetch(`${url}/h/${ids.a}/`)).text(), /fetch\("api\/view"/);
  assert.match(await (await fetch(`${url}/`)).text(), /api\/hives/);
  // Each hive's status carries the listing its keepers signed, for its page to show.
  const statusB = (await (await fetch(`${url}/h/${ids.b}/api/status`)).json()) as {
    hive: string;
    listing: { body: { hive: string; name: string } };
  };
  assert.deepEqual(
    [statusB.hive, statusB.listing.body.hive, statusB.listing.body.name],
    [ids.b, ids.b, `Hive ${ids.b}`],
  );
  // The page's typefaces come from the host itself.
  const font = await fetch(`${url}/fonts/figtree.woff2`);
  assert.deepEqual([font.status, font.headers.get("content-type")], [200, "font/woff2"]);
  assert.equal((await fetch(`${url}/fonts/other.woff2`)).status, 404);
  const [missing, body] = await json(await fetch(`${url}/h/nobody/api/view`));
  assert.deepEqual([missing, body.error], [404, "UNKNOWN_HIVE"]);
});

test("one hive's failing view leaves the other hives listed", async (t) => {
  const { url, ids } = await host(t, {
    b: {
      view: async () => {
        throw new Fault("INDEXER_DOWN");
      },
    },
  });
  const [, { hives }] = await json(await fetch(`${url}/api/hives`));
  const [a, b] = hives as { balanceSats: number | null; error: string | null }[];
  assert.deepEqual([a!.balanceSats, a!.error], [418_550, null]);
  assert.deepEqual([b!.balanceSats, b!.error], [null, "INDEXER_DOWN"]);
  const [failed, body] = await json(await fetch(`${url}/h/${ids.b}/api/view`));
  assert.deepEqual([failed, body.error], [400, "INDEXER_DOWN"]);
});

test("halting one hive stops its new contributions only; the operator's switch stops all", async (t) => {
  const { url, ids } = await host(t);
  const own = haltFile(ids.a);
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, "keepers investigating");
  t.after(() => rmSync(own, { force: true }));
  const status = async (id: string) =>
    (await (await fetch(`${url}/h/${id}/api/status`)).json()) as {
      halted: boolean;
      haltReason: string | null;
    };
  const halted = await status(ids.a);
  assert.deepEqual([halted.halted, halted.haltReason], [true, "keepers investigating"]);
  assert.equal((await status(ids.b)).halted, false);
  const pour = async (id: string) =>
    (await json(await post(`${url}/h/${id}/api/pour`, { rail: "arkade", amountSats: 2_000 })))[1].error;
  assert.equal(await pour(ids.a), "HALTED");
  // The other hive passes its switch and only fails reaching a Lightning address that is not there.
  assert.notEqual(await pour(ids.b), "HALTED");
  const [, listed] = await json(await fetch(`${url}/api/hives`));
  assert.deepEqual(
    listed.hives.map((h: { halted: boolean }) => h.halted),
    [true, false],
  );

  const global = localPath("v4-test", "hive-host", run, "HALT");
  mkdirSync(dirname(global), { recursive: true });
  writeFileSync(global, "operator incident");
  process.env.BUZZ_HALT_FILE = global;
  t.after(() => {
    delete process.env.BUZZ_HALT_FILE;
  });
  assert.equal((await status(ids.b)).haltReason, "operator incident");
  assert.equal(await pour(ids.b), "HALTED");
});

test("the host's claim desk hands each claim to the hive whose treasury the quote names", async (t) => {
  const { url, ids, hives, claims } = await host(t);
  const claim = (treasuryScript: string) => ({
    quote: { body: { treasuryScript } },
    receipt: {},
    claimSignature: "00",
  });
  const [ok, body] = await json(await post(`${url}/api/claim`, claim(hives.b.listing.body.treasuryScript)));
  assert.deepEqual([ok, body], [200, { hive: ids.b, spendId: "b-spend" }]);
  assert.deepEqual(
    claims.map((c) => c.hive),
    [ids.b],
  );
  const [refused, error] = await json(await post(`${url}/api/claim`, claim(`5120${"11".repeat(32)}`)));
  assert.deepEqual([refused, error.error], [400, "UNKNOWN_HIVE"]);
  // A hive's own desk still answers at its own path.
  const [direct] = await json(await post(`${url}/h/${ids.a}/api/claim`, claim("anything")));
  assert.equal(direct, 200);
  assert.deepEqual(
    claims.map((c) => c.hive),
    [ids.b, ids.a],
  );
});

test("a host refuses a listing its keepers did not all sign, and two hives with one name or treasury", async () => {
  const code = async (hives: HostedHive[]) => {
    try {
      const served = await startHiveHost({ hives });
      await served.close();
      return "started";
    } catch (error) {
      return faultCode(error, "THREW");
    }
  };
  const hive = (signed: SignedHiveListing): HostedHive => ({
    listing: signed,
    view: async () => view(0, signed.body.treasuryScript),
  });
  const good = listing(`c-${run}`);
  const renamed = { ...good, body: { ...good.body, name: "Taken Over" } };
  assert.equal(
    await code([hive({ ...renamed, listingId: hiveListingId(renamed.body) })]),
    "LISTING_SIGNATURE",
  );
  assert.equal(await code([hive(good), hive(listing(`c-${run}`))]), "DUPLICATE_HIVE");
  assert.equal(
    await code([hive(good), hive(listing(`d-${run}`, { treasuryScript: good.body.treasuryScript }))]),
    "DUPLICATE_TREASURY",
  );
  assert.equal(await code([hive(good)]), "started");
});
