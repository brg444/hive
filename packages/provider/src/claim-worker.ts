import { ensure, serveWorker } from "@hive/kit";
import { signClaim } from "./claim.js";

await serveWorker(
  async (request, args) => {
    ensure(args.length === 1, "INVALID_CONFIG_PATH");
    return signClaim(args[0]!, request);
  },
  { maxRequestBytes: 65_536, fallbackCode: "CLAIM_POLICY_OR_STATE_REJECTED" },
);
