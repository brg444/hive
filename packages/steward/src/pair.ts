import { combine, type Pair, pairKeys, pairMembers, pairSigners } from "@hive/ark";
import { ensure, hex } from "@hive/kit";
import type { StewardEndpoint } from "./client.js";
import type { SessionRequest } from "./purpose.js";

/**
 * The coordinator's side of a pair's signatures: three calls, relayed. The
 * pair's first key in sorted order gives its nonces, the other signs over them
 * in one round, then the first signs. The coordinator combines each pair of
 * partials and checks the result against the pair key; it never holds a key.
 */
export async function signWithPair(
  stewards: readonly [StewardEndpoint, StewardEndpoint, StewardEndpoint],
  stewardKeys: readonly [string, string, string],
  session: SessionRequest,
  messages: Uint8Array[],
): Promise<string[]> {
  const pair: Pair = session.pair;
  const signers = pairSigners(stewardKeys, pair);
  const [i, j] = pairMembers(pair);
  const byKey = new Map([
    [stewardKeys[i]!, stewards[i]!],
    [stewardKeys[j]!, stewards[j]!],
  ]);
  const first = byKey.get(hex(signers[0]!));
  const last = byKey.get(hex(signers[1]!));
  ensure(first && last, "INVALID", "pair members");
  const { publicNonces: a } = await first.nonce(session);
  ensure(a.length === messages.length, "STEWARD_RESPONSE", "nonce count");
  const { publicNonces: b, partials: pb } = await last.signLast(session, a);
  const { partials: pa } = await first.sign(session, b);
  ensure(
    b.length === messages.length && pa.length === messages.length && pb.length === messages.length,
    "STEWARD_RESPONSE",
  );
  const aggKey = pairKeys(stewardKeys)[pair];
  return messages.map((message, n) => combine(signers, [a[n]!, b[n]!], [pa[n]!, pb[n]!], message, aggKey));
}
