import { pathToFileURL } from "node:url";
import { RFQ_AD_KIND, RFQ_DIRECTED_KIND } from "@arkade-os/swap/nostr";
import { ensure } from "@hive/kit";
import { type Event, type Filter, verifyEvent } from "nostr-tools";
import { matchFilters } from "nostr-tools/filter";
import { WebSocket, WebSocketServer } from "ws";

export interface RelayStats {
  accepted: number;
  rejected: number;
  delivered: number;
  ephemeral: number;
  advertisements: number;
}

export interface LocalRelay {
  url: string;
  stats: RelayStats;
  close(): Promise<void>;
}

const KINDS = [RFQ_DIRECTED_KIND, RFQ_AD_KIND];

/** A local NIP-01 relay for the two RFQ kinds: verified events, addressed delivery, latest advertisement kept (provider cards and hive listings alike). */
export async function startLocalRelay(port = 0): Promise<LocalRelay> {
  const server = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 131_072 });
  await new Promise<void>((ready, reject) => {
    server.once("listening", ready);
    server.once("error", reject);
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "LISTEN_FAILED");
  const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
  const advertisements = new Map<string, Event>();
  const stats: RelayStats = { accepted: 0, rejected: 0, delivered: 0, ephemeral: 0, advertisements: 0 };
  const send = (socket: WebSocket, frame: unknown[]) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  server.on("connection", (socket) => {
    subscriptions.set(socket, new Map());
    socket.on("close", () => subscriptions.delete(socket));
    socket.on("message", (bytes) => {
      let eventId = "";
      try {
        const frame: unknown = JSON.parse(bytes.toString());
        ensure(Array.isArray(frame) && typeof frame[0] === "string", "INVALID_FRAME");
        if (frame[0] === "EVENT") {
          ensure(frame.length === 2, "INVALID_FRAME");
          const event = frame[1] as Event;
          eventId = typeof event?.id === "string" ? event.id : "";
          ensure(verifyEvent(event) && KINDS.includes(event.kind), "INVALID_EVENT");
          ensure(Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= 300, "STALE_EVENT");
          if (event.kind === RFQ_AD_KIND) {
            const d = event.tags.find((tag) => tag[0] === "d")?.[1];
            ensure(d, "INVALID_EVENT");
            const key = `${event.pubkey}:${d}`;
            const previous = advertisements.get(key);
            if (
              !previous ||
              event.created_at > previous.created_at ||
              (event.created_at === previous.created_at && event.id < previous.id)
            ) {
              advertisements.set(key, event);
            }
            stats.advertisements = advertisements.size;
          } else stats.ephemeral++;
          stats.accepted++;
          send(socket, ["OK", event.id, true, ""]);
          for (const [target, entries] of subscriptions) {
            for (const [id, filters] of entries) {
              if (matchFilters(filters, event)) {
                send(target, ["EVENT", id, event]);
                stats.delivered++;
              }
            }
          }
        } else if (frame[0] === "REQ") {
          ensure(
            typeof frame[1] === "string" && frame[1].length <= 128 && frame.length >= 3 && frame.length <= 6,
            "INVALID_FRAME",
          );
          const filters = frame.slice(2) as Filter[];
          for (const filter of filters) validateFilter(filter);
          const entries = subscriptions.get(socket)!;
          ensure(entries.size < 64 || entries.has(frame[1]), "TOO_MANY_SUBSCRIPTIONS");
          entries.set(frame[1], filters);
          for (const event of advertisements.values()) {
            if (matchFilters(filters, event)) send(socket, ["EVENT", frame[1], event]);
          }
          send(socket, ["EOSE", frame[1]]);
        } else if (frame[0] === "CLOSE") {
          ensure(frame.length === 2 && typeof frame[1] === "string", "INVALID_FRAME");
          subscriptions.get(socket)!.delete(frame[1]);
        } else ensure(false, "INVALID_FRAME");
      } catch {
        stats.rejected++;
        if (eventId) send(socket, ["OK", eventId, false, "invalid: event rejected"]);
        else send(socket, ["NOTICE", "invalid: frame rejected"]);
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    stats,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    },
  };
}

function validateFilter(filter: Filter): void {
  ensure(filter && typeof filter === "object" && !Array.isArray(filter), "INVALID_FILTER");
  ensure(
    Object.keys(filter).every((key) =>
      ["kinds", "authors", "#p", "#d", "#t", "since", "until", "limit"].includes(key),
    ),
    "INVALID_FILTER",
  );
  ensure(
    Array.isArray(filter.kinds) &&
      filter.kinds.length > 0 &&
      filter.kinds.every((kind) => KINDS.includes(kind)),
    "INVALID_FILTER",
  );
  for (const key of ["authors", "#p", "#d", "#t"] as const) {
    const values = filter[key];
    if (values === undefined) continue;
    ensure(
      Array.isArray(values) &&
        values.length <= 16 &&
        values.every((v) => typeof v === "string" && v.length <= 512),
      "INVALID_FILTER",
    );
  }
  for (const key of ["since", "until", "limit"] as const) {
    const value = filter[key];
    if (value !== undefined) ensure(Number.isSafeInteger(value) && value >= 0, "INVALID_FILTER");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = await startLocalRelay(Number(process.env.BUZZ_RELAY_PORT ?? "7777"));
  process.stdout.write(`${JSON.stringify({ url: relay.url })}\n`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void relay.close().then(() => process.exit(0)));
  }
}
