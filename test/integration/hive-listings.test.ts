import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { type TestContext, test } from "node:test";
import { faultCode, hex } from "@hive/kit";
import {
  hiveListingEvent,
  type ListedTreasuryTerms,
  listingRelays,
  publishHiveListing,
  readHiveListingEvent,
} from "@hive/hive";
import {
  HIVE_PROFILE,
  type HiveListingBody,
  hiveListingId,
  type SignedHiveListing,
  signHiveListing,
  validateHiveListing,
} from "@hive/protocol";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { finalizeEvent } from "nostr-tools";
import { startLocalRelay } from "../../gates/support/relay.js";
import { findHives, initHive, loadHive, opsPaths, publishListing, writeListing } from "../../tools/ops.js";
import { startFakeNetwork } from "../support/fake-network.js";

/**
 * A hive's listing travels over Nostr the way a provider's card does, and a
 * reader keeps only listings whose keepers' keys derive the treasury they name.
 */

async function setup(t: TestContext) {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 2 * 86_400 });
  t.after(() => fake.close());
  const relay = await startLocalRelay();
  t.after(() => relay.close());
  const hive = `listed-${randomUUID().slice(0, 8)}`;
  t.after(() => {
    rmSync(opsPaths(hive).local(), { recursive: true, force: true });
    rmSync(opsPaths(hive).secret(), { recursive: true, force: true });
  });
  const record = await initHive(hive, { network: "regtest", deployment: fake.deployment() }, {});
  const terms: ListedTreasuryTerms = {
    exitDelaySeconds: record.treasury.exitDelaySeconds,
    renewalWindowSeconds: record.treasury.renewalWindowSeconds,
    maxFeeSats: record.treasury.maxFeeSats,
  };
  const find = () => findHives("regtest", [relay.url], { deployment: fake.deployment(), maxWaitMs: 2_000 });
  return { fake, relay, hive, terms, find };
}

/** A listing signed by three keys that are not the treasury's keepers. */
function forged(body: Omit<HiveListingBody, "stewardKeys">): SignedHiveListing {
  const keys = [0, 1, 2].map(() => schnorr.utils.randomSecretKey());
  const full: HiveListingBody = {
    ...body,
    stewardKeys: keys.map((k) => hex(secp256k1.getPublicKey(k, true))) as [string, string, string],
  };
  const signatures = keys.map((k) => signHiveListing(full, k).signature) as [string, string, string];
  return validateHiveListing({ body: full, listingId: hiveListingId(full), signatures });
}

test("a hive's listing reaches a reader over Nostr, and its newest signed version wins", async (t) => {
  const { relay, hive, terms, find } = await setup(t);
  assert.deepEqual((await find()).hives, []);

  const first = writeListing(hive, { name: "Listed Hive", purpose: "Inference for the tests." });
  const published = await publishListing(hive, [relay.url]);
  assert.equal(published.listingId, first.listingId);
  let found = await find();
  assert.equal(found.hives.length, 1);
  assert.equal(found.hives[0]!.listing.listingId, first.listingId);
  assert.equal(found.hives[0]!.publisher, published.publisher);

  // Anyone may republish the keepers' listing; it is still one hive.
  await publishHiveListing(first, terms, schnorr.utils.randomSecretKey(), [relay.url]);
  found = await find();
  assert.equal(found.found, 2);
  assert.equal(found.hives.length, 1);

  // The keepers sign a newer listing; readers show it, whoever still carries the old one.
  const second = writeListing(
    hive,
    { name: "Listed Hive", purpose: "Now with a new purpose." },
    String(BigInt(first.body.createdAt) + 10n),
  );
  await publishListing(hive, [relay.url]);
  found = await find();
  assert.equal(found.hives.length, 1);
  assert.equal(found.hives[0]!.listing.listingId, second.listingId);
  assert.equal(found.hives[0]!.listing.body.purpose, "Now with a new purpose.");
});

test("a reader leaves out listings whose keys do not derive the treasury they name", async (t) => {
  const { relay, hive, terms, find } = await setup(t);
  const real = writeListing(hive, { name: "Listed Hive" });
  await publishListing(hive, [relay.url]);
  const { stewardKeys: _keys, ...rest } = real.body;

  // A newer listing for the same treasury, signed by keys that are not its keepers.
  const takeover = forged({
    ...rest,
    purpose: "Send here instead.",
    createdAt: String(BigInt(rest.createdAt) + 60n),
  });
  await publishHiveListing(takeover, terms, schnorr.utils.randomSecretKey(), [relay.url]);
  // A look-alike with the same name and its own treasury that no keys derive.
  const lookalike = forged({ ...rest, hive: "look-alike", treasuryScript: `5120${"ab".repeat(32)}` });
  await publishHiveListing(lookalike, terms, schnorr.utils.randomSecretKey(), [relay.url]);

  const found = await find();
  assert.equal(found.found, 3);
  assert.deepEqual(
    found.hives.map((h) => h.listing.listingId),
    [real.listingId],
  );
  assert.equal(loadHive(hive).treasuryScript, found.hives[0]!.listing.body.treasuryScript);
});

test("a listing event is read only as published: kind, tags and canonical content", async (t) => {
  const { hive, terms } = await setup(t);
  const listing = writeListing(hive, { name: "Listed Hive" });
  const key = schnorr.utils.randomSecretKey();
  const event = hiveListingEvent(listing, terms, key);
  assert.equal(readHiveListingEvent(event).listing.listingId, listing.listingId);
  assert.deepEqual(readHiveListingEvent(event).terms, terms);
  assert.ok(event.tags.some((tag) => tag[0] === "d" && tag[1] === `${HIVE_PROFILE}:${hive}`));

  const resign = (patch: { tags?: string[][]; content?: string }) =>
    finalizeEvent(
      {
        kind: event.kind,
        created_at: event.created_at,
        tags: patch.tags ?? event.tags,
        content: patch.content ?? event.content,
      },
      key,
    );
  const fault = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (error) {
      return faultCode(error);
    }
  };
  // Another hive's d tag, no topic tag, no treasury terms, re-spaced content, an altered body.
  const tags = event.tags.filter((tag) => tag[0] !== "d");
  assert.equal(
    fault(() => readHiveListingEvent(resign({ tags: [...tags, ["d", `${HIVE_PROFILE}:other`]] }))),
    "INVALID_LISTING_EVENT",
  );
  assert.equal(
    fault(() => readHiveListingEvent(resign({ tags: event.tags.filter((tag) => tag[0] !== "t") }))),
    "INVALID_LISTING_EVENT",
  );
  assert.equal(
    fault(() => readHiveListingEvent(resign({ tags: event.tags.filter((tag) => tag[0] !== "treasury") }))),
    "INVALID_LISTING_EVENT",
  );
  assert.equal(
    fault(() => readHiveListingEvent(resign({ content: JSON.stringify(listing, null, 1) }))),
    "INVALID_LISTING_EVENT",
  );
  assert.equal(
    fault(() =>
      readHiveListingEvent(resign({ content: event.content.replace("Listed Hive", "Listed Hivf") })),
    ),
    "LISTING_DIGEST",
  );
  // A tampered event fails its own signature.
  assert.equal(
    fault(() => readHiveListingEvent({ ...event, content: `${event.content} ` })),
    "INVALID_LISTING_EVENT",
  );

  // Relays follow the provider card's rules: local on regtest, TLS elsewhere, at most four.
  assert.equal(
    fault(() => listingRelays(["wss://relay.example/"], "regtest")),
    "INVALID",
  );
  assert.equal(
    fault(() => listingRelays(["ws://relay.example/"], "mutinynet")),
    "INVALID",
  );
  assert.equal(
    fault(() => listingRelays([], "regtest")),
    "INVALID",
  );
  assert.deepEqual(listingRelays(["wss://relay.example/"], "mutinynet"), ["wss://relay.example/"]);
});
