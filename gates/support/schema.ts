import { ensure } from "@hive/kit";

export const EVIDENCE_VERSION = 2;
export type Suite = "lifecycle" | "refusals" | "renewal";

export const LEGACY_REFUSALS = [
  "unapprovedQuote",
  "secondFunding",
  "firstPromise",
  "secondPromise",
  "unapprovedWithdrawal",
  "haltedPurchase",
  "forgedClaimAtDesk",
  "compromisedClaim",
  "escrowAfterForgedClaim",
  "compromisedSend",
  "treasuryAfterSwappedSend",
  "genuineClaimAfter",
  "providerPaid",
] as const;
export const REFUSAL_CASES = [...LEGACY_REFUSALS, "selfForgedClaim", "selfSwappedSend", "coinsAfterDirect"];

// The unversioned development producers are fixed historical schema profiles.
// Case presence never selects a profile: removing a case must fail its audit.
const LEGACY: Record<Suite, Record<string, "delegatee" | "routed">> = {
  lifecycle: {
    "8557641162d95e56e88f285977404311d444753f1dedf69e41cf502456c532da": "delegatee",
    a136ef785b2b15614278cb60e1bf379e24b7980b024158c9240e08f89e5b8bd7: "routed",
  },
  refusals: {
    "4c5caf055f15e2535880eee18375fde5ed1a536dfcfdc3d299d969cdb9c62148": "delegatee",
    d44abde7fecab5103d99e6fbe4a668fc9bac2a93fe0d6fbe8e2dde1ae7d42ceb: "delegatee",
    "5b8afa1a1166ee5583eb10c0b09d228ecb567ef3c25422530b30a873e2e50688": "delegatee",
    bb784ee4fdd97646aa7c5b834135af41e9afd649a6605e27480a53b87ca28508: "routed",
  },
  renewal: {
    bd16be342f98bb99ddf524583fbe69f2897ef747fb93218c7d12850b8261729c: "delegatee",
  },
};

export interface EvidenceProfile {
  version: 1 | 2;
  refusalCases: readonly string[];
}

export function evidenceProfile(
  suite: Suite,
  evidence: { schemaVersion?: unknown; sourceSha256?: Record<string, string> },
): EvidenceProfile {
  if (evidence.schemaVersion === EVIDENCE_VERSION) return { version: 2, refusalCases: REFUSAL_CASES };
  ensure(evidence.schemaVersion === undefined, "EVIDENCE_VERSION_UNSUPPORTED");
  const producer = evidence.sourceSha256?.[`gates/${suite}.ts`];
  const legacy = producer ? LEGACY[suite][producer] : undefined;
  ensure(legacy, "EVIDENCE_VERSION_REQUIRED", "unknown unversioned producer");
  return { version: 1, refusalCases: legacy === "routed" ? REFUSAL_CASES : LEGACY_REFUSALS };
}
