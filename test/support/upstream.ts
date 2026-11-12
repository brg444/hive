import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { closeServer, listenLocal, readBody } from "@hive/kit";

/** MeshLLM v0.78.1 response bodies recorded from a real run, served back by a local stub. */
export const mesh = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/mesh-usage.json"), "utf8"),
) as {
  models: { data: { id: string }[] };
  stream: { body: string };
  nonstream: { body: string };
};
export const MESH_MODEL = mesh.models.data[0]!.id;

export interface StubUpstream {
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}

/** Replays the recorded JSON or SSE body depending on `stream`; `rewrite` lets a test tamper with it. */
export async function stubUpstream(
  rewrite: (body: string, stream: boolean) => string = (body) => body,
  port = 0,
): Promise<StubUpstream> {
  const requests: unknown[] = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(mesh.models));
      return;
    }
    const body = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8")) as { stream?: boolean };
    requests.push(body);
    const stream = body.stream === true;
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    response.end(rewrite(stream ? mesh.stream.body : mesh.nonstream.body, stream));
  });
  const { url } = await listenLocal(server, port);
  return { url: `${url}/v1`, requests, close: () => closeServer(server) };
}
