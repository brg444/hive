import { RFQ_AD_KIND } from "@arkade-os/swap/nostr";
import { type Connection, deriveAccount, pairKeys, treasuryArguments } from "@hive/ark";
import { decimal, ensure, fail, unixNow } from "@hive/kit";
import {
  canonicalJson,
  HIVE_PROFILE,
  type HiveNetwork,
  relayUrl,
  type SignedHiveListing,
  validateHiveListing,
} from "@hive/protocol";
import { type Event, finalizeEvent, SimplePool, verifyEvent } from "nostr-tools";

/**
 * Hive listings on Nostr, published the way a provider advertises its card:
 * an addressable event of the RFQ advertisement kind, its `d` tag naming the
 * profile and the hive, its content the signed listing in canonical JSON.
 * A `t` tag lets a reader ask relays for hive listings alone.
 *
 * The event's author proves nothing: anyone may republish a listing, and a
 * reader trusts only the keepers' signatures inside it and the treasury those
 * keepers' keys derive. The `treasury` tag carries the terms that derivation
 * needs; whoever writes it, no terms make another hive's keys derive this
 * treasury.
 */
export const HIVE_LISTING_KIND = RFQ_AD_KIND;

/** The treasury terms a reader needs to derive the listed treasury from its keepers' keys. */
export interface ListedTreasuryTerms {
  exitDelaySeconds: number;
  renewalWindowSeconds: number;
  maxFeeSats: number;
}

/** A listing as a reader found it on a relay. */
export interface FoundHiveListing {
  listing: SignedHiveListing;
  terms: ListedTreasuryTerms;
  /** The Nostr key that published this copy; any key may. */
  publisher: string;
  publishedAt: number;
}

const MAX_CONTENT_BYTES = 16_384;
const MAX_RELAYS = 4;

/** One to four relay URLs for the listing's network, as provider cards allow. */
export function listingRelays(relays: readonly string[], network: HiveNetwork): string[] {
  ensure(relays.length > 0 && relays.length <= MAX_RELAYS, "INVALID", "one to four relay URLs required");
  ensure(new Set(relays).size === relays.length, "INVALID", "duplicate relay URL");
  return relays.map((relay) => relayUrl(relay, network));
}

function termsTag(terms: ListedTreasuryTerms): string[] {
  return [
    "treasury",
    String(terms.exitDelaySeconds),
    String(terms.renewalWindowSeconds),
    String(terms.maxFeeSats),
  ];
}

function parseTerms(tag: string[] | undefined): ListedTreasuryTerms {
  if (tag?.length !== 4) fail("INVALID_LISTING_EVENT", "treasury terms tag");
  const [exit, window, fee] = tag
    .slice(1)
    .map((value, i) =>
      Number(decimal(value, ["exit delay", "renewal window", "renewal fee"][i]!, 1n, 1_000_000_000n)),
    );
  return { exitDelaySeconds: exit!, renewalWindowSeconds: window!, maxFeeSats: fee! };
}

/** The listing as a signed Nostr event, ready for any relay. */
export function hiveListingEvent(
  listing: SignedHiveListing,
  terms: ListedTreasuryTerms,
  secretKey: Uint8Array,
  createdAt = Number(unixNow()),
): Event {
  const checked = validateHiveListing(listing);
  return finalizeEvent(
    {
      kind: HIVE_LISTING_KIND,
      created_at: createdAt,
      tags: [["d", `${HIVE_PROFILE}:${checked.body.hive}`], ["t", HIVE_PROFILE], termsTag(terms)],
      content: canonicalJson(checked),
    },
    secretKey,
  );
}

/**
 * Reads one event as a hive listing: the event's own signature, its kind and
 * tags, and the listing inside with all three keepers' signatures. It does not
 * check the treasury; `currentHiveListings` does, with a connection.
 */
export function readHiveListingEvent(event: Event): FoundHiveListing {
  ensure(verifyEvent(event) && event.kind === HIVE_LISTING_KIND, "INVALID_LISTING_EVENT");
  ensure(
    event.tags.some((tag) => tag.length === 2 && tag[0] === "t" && tag[1] === HIVE_PROFILE),
    "INVALID_LISTING_EVENT",
    "not a hive listing",
  );
  ensure(Buffer.byteLength(event.content) <= MAX_CONTENT_BYTES, "INVALID_LISTING_EVENT", "listing too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    fail("INVALID_LISTING_EVENT", "listing is not JSON");
  }
  const listing = validateHiveListing(parsed);
  ensure(canonicalJson(listing) === event.content, "INVALID_LISTING_EVENT", "listing is not canonical");
  const d = event.tags.filter((tag) => tag[0] === "d");
  ensure(
    d.length === 1 && d[0]!.length === 2 && d[0]![1] === `${HIVE_PROFILE}:${listing.body.hive}`,
    "INVALID_LISTING_EVENT",
    "d tag does not name the listed hive",
  );
  const terms = parseTerms(event.tags.find((tag) => tag[0] === "treasury"));
  return { listing, terms, publisher: event.pubkey, publishedAt: event.created_at };
}

/** Whether the listing's three keepers' keys, with these terms, derive the treasury it names. */
export function listingMatchesTreasury(
  conn: Pick<Connection, "deployment" | "keys">,
  found: Pick<FoundHiveListing, "listing" | "terms">,
): boolean {
  const { body } = found.listing;
  if (body.network !== conn.deployment.network) return false;
  const account = deriveAccount(
    conn,
    "treasury",
    treasuryArguments({ pairs: pairKeys(body.stewardKeys), ...found.terms }),
  );
  return account.pkScript === body.treasuryScript;
}

/**
 * The listings to show: each one whose keepers' keys derive the treasury it
 * names, and for each treasury only the one its keepers signed last. A copy
 * republished by anyone counts the same as the keepers' own.
 */
export function currentHiveListings(
  conn: Pick<Connection, "deployment" | "keys">,
  found: readonly FoundHiveListing[],
): FoundHiveListing[] {
  const latest = new Map<string, FoundHiveListing>();
  for (const entry of found) {
    if (!listingMatchesTreasury(conn, entry)) continue;
    const { body, listingId } = entry.listing;
    const held = latest.get(body.treasuryScript);
    const heldAt = held ? BigInt(held.listing.body.createdAt) : -1n;
    const at = BigInt(body.createdAt);
    if (!held || at > heldAt || (at === heldAt && listingId < held.listing.listingId)) {
      latest.set(body.treasuryScript, entry);
    }
  }
  return [...latest.values()].sort((a, b) => a.listing.body.name.localeCompare(b.listing.body.name));
}

/**
 * Publishes the listing to its relays; at least one must accept it. A relay
 * keeps one event per author and `d` tag, and of two from the same second the
 * one with the lower id, so a publisher that sends again passes a later
 * `createdAt`.
 */
export async function publishHiveListing(
  listing: SignedHiveListing,
  terms: ListedTreasuryTerms,
  secretKey: Uint8Array,
  relays: readonly string[],
  createdAt?: number,
): Promise<Event> {
  const urls = listingRelays(relays, listing.body.network);
  const event = hiveListingEvent(listing, terms, secretKey, createdAt);
  const nostr = new SimplePool();
  try {
    await Promise.any(nostr.publish(urls, event));
  } finally {
    nostr.close(urls);
  }
  return event;
}

/**
 * Every hive listing the relays hold for this network, read and checked one by
 * one. An event that fails its checks is left out.
 */
export async function fetchHiveListings(
  relays: readonly string[],
  network: HiveNetwork,
  options: { maxWaitMs?: number } = {},
): Promise<FoundHiveListing[]> {
  const urls = listingRelays(relays, network);
  const nostr = new SimplePool();
  try {
    const events = await nostr.querySync(
      urls,
      { kinds: [HIVE_LISTING_KIND], "#t": [HIVE_PROFILE] },
      { maxWait: options.maxWaitMs ?? 5_000 },
    );
    const found: FoundHiveListing[] = [];
    for (const event of events) {
      try {
        const entry = readHiveListingEvent(event);
        if (entry.listing.body.network === network) found.push(entry);
      } catch {
        // Relays carry whatever anyone sends; a malformed listing is skipped.
      }
    }
    return found;
  } finally {
    nostr.close(urls);
  }
}
