import { ensure, serveWorker } from "@hive/kit";
import { handleStewardRequest } from "./service.js";

// The steward's private-key process. Its only input is one typed request on
// stdin; its configuration path is the single argument.
await serveWorker(async (request, args) => {
  ensure(args.length === 1, "INVALID_CONFIG_PATH");
  return handleStewardRequest(args[0]!, request);
});
