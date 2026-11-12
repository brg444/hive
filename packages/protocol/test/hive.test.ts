import assert from "node:assert/strict";
import { test } from "node:test";
import { faultCode, hex } from "@hive/kit";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import {
  HIVE_PROFILE,
  type HiveListingBody,
  hiveListingId,
  type SignedHiveListing,
  signHiveListing,
  validateHiveListing,
} from "../src/index.js";

const secrets = [1, 2, 3].map(() => schnorr.utils.randomSecretKey());
const body: HiveListingBody = {
  profile: HIVE_PROFILE,
  network: "regtest",
  hive: "buzz-builders",
  name: "Buzz Builders",
  purpose: "Inference for builders in the Buzz community.",
  stewardKeys: secrets.map((s) => hex(secp256k1.getPublicKey(s, true))) as [string, string, string],
  treasuryScript: `5120${hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))}`,
  lightningAddress: "buzz-builders@localhost:7072",
  createdAt: "1791700000",
};

function listing(of: HiveListingBody = body, signers = secrets): SignedHiveListing {
  const signed = signers.map((s) => signHiveListing(of, s));
  const signatures = ["", "", ""];
  for (const s of signed) signatures[s.keeper] = s.signature;
  return { body: of, listingId: hiveListingId(of), signatures: signatures as [string, string, string] };
}

const code = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (error) {
    return faultCode(error, "THREW");
  }
};

test("a listing all three keepers signed validates", () => {
  const valid = validateHiveListing(listing());
  assert.equal(valid.body.hive, "buzz-builders");
  // Signing order does not matter: each signature lands at its keeper's place.
  assert.equal(
    code(() => validateHiveListing(listing(body, [secrets[2]!, secrets[0]!, secrets[1]!]))),
    "ok",
  );
});

test("a listing is refused unless every keeper signed this exact text", () => {
  const signed = listing();
  // Two signatures are not enough: each keeper consents to keeping this hive.
  assert.equal(
    code(() =>
      validateHiveListing({ ...signed, signatures: [signed.signatures[0], signed.signatures[1], ""] }),
    ),
    "INVALID",
  );
  const swapped = {
    ...signed,
    signatures: [signed.signatures[1], signed.signatures[0], signed.signatures[2]],
  };
  assert.equal(
    code(() => validateHiveListing(swapped)),
    "LISTING_SIGNATURE",
  );
  // A host that renames the hive or points it elsewhere breaks the digest and every signature.
  const renamed = { ...signed, body: { ...body, name: "Someone Else's Hive" } };
  assert.equal(
    code(() => validateHiveListing(renamed)),
    "LISTING_DIGEST",
  );
  const redigested = { ...renamed, listingId: hiveListingId(renamed.body) };
  assert.equal(
    code(() => validateHiveListing(redigested)),
    "LISTING_SIGNATURE",
  );
  const elsewhere = { ...body, lightningAddress: "thief@localhost" };
  assert.equal(
    code(() => validateHiveListing({ ...signed, body: elsewhere, listingId: hiveListingId(elsewhere) })),
    "LISTING_SIGNATURE",
  );
});

test("only the hive's keepers can sign its listing", () => {
  assert.equal(
    code(() => signHiveListing(body, schnorr.utils.randomSecretKey())),
    "LISTING_SIGNER",
  );
});

test("listing fields are checked before anything is signed", () => {
  const bad: [Partial<HiveListingBody>, string][] = [
    [{ hive: "Buzz Builders" }, "INVALID"],
    [{ name: "" }, "INVALID"],
    [{ name: " padded" }, "INVALID"],
    [{ name: "line\nbreak" }, "INVALID"],
    [{ purpose: "x".repeat(281) }, "INVALID"],
    [{ stewardKeys: [body.stewardKeys[0], body.stewardKeys[0], body.stewardKeys[2]] }, "INVALID"],
    [{ treasuryScript: "0014".padEnd(68, "0") }, "INVALID"],
    [{ lightningAddress: "not an address" }, "INVALID"],
    [{ network: "bitcoin" }, "INVALID"],
  ];
  for (const [change, expected] of bad) {
    assert.equal(
      code(() => signHiveListing({ ...body, ...change } as HiveListingBody, secrets[0]!)),
      expected,
    );
  }
  assert.equal(
    code(() => signHiveListing({ ...body, lightningAddress: null }, secrets[0]!)),
    "ok",
  );
});
