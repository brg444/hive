import { ensure, serveWorker } from "@hive/kit";
import { signChallenge } from "./challenge.js";

await serveWorker(
  async (request, args) => {
    ensure(args.length === 1, "INVALID_CONFIG_PATH");
    return signChallenge(args[0]!, request);
  },
  { maxRequestBytes: 65_536, fallbackCode: "METERING_AUTHORIZATION_REJECTED" },
);
