import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { bench, describe } from "vitest";
import { Starcite } from "../src/client";
import type { StarciteWebSocket, TailEvent } from "../src/types";

interface BenchWebSocket {
  close(code?: number, reason?: string): void;
  on(eventName: "close", listener: () => void): void;
  readyState: number;
  send(data: string): void;
  terminate(): void;
}

interface BenchWebSocketServer {
  clients: Set<BenchWebSocket>;
  close(callback: (error?: Error) => void): void;
  emit(
    eventName: "connection",
    websocket: BenchWebSocket,
    request: IncomingMessage
  ): void;
  handleUpgrade(
    request: IncomingMessage,
    socket: unknown,
    head: Buffer,
    callback: (websocket: BenchWebSocket) => void
  ): void;
  on(
    eventName: "connection",
    listener: (websocket: BenchWebSocket, request: IncomingMessage) => void
  ): void;
}

type BenchWebSocketCtor = new (url: string) => BenchWebSocket;
type BenchWebSocketServerCtor = new (options: {
  noServer: true;
}) => BenchWebSocketServer;

interface RttHarness {
  clearSession(sessionId: string): void;
  client: Starcite;
  close(): Promise<void>;
  seedSessionEvent(sessionId: string, text: string): void;
}

function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

function makeTailSessionToken(sessionId: string): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "bench-tenant",
    principal_id: "agent:bench",
    principal_type: "agent",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  value: unknown,
  fallback: string,
  allowEmpty = false
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  if (!allowEmpty && value.length === 0) {
    return fallback;
  }

  return value;
}

function toSessionId(pathname: string): string | undefined {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 4) {
    return undefined;
  }

  if (segments[0] !== "v1" || segments[1] !== "sessions") {
    return undefined;
  }

  const encoded = segments[2];
  if (!encoded) {
    return undefined;
  }

  return decodeURIComponent(encoded);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeWebSocketServer(server: BenchWebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function listenOnRandomPort(
  server: ReturnType<typeof createServer>
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }

      chunks.push(Buffer.from(String(chunk), "utf8"));
    });
    request.on("error", reject);
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(bodyText) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const require = createRequire(import.meta.url);
let NodeWebSocket: BenchWebSocketCtor | undefined;
let WebSocketServer: BenchWebSocketServerCtor | undefined;
let websocketDepsAvailable = false;

try {
  const ws = require("ws") as {
    WebSocket: BenchWebSocketCtor;
    WebSocketServer: BenchWebSocketServerCtor;
  };
  NodeWebSocket = ws.WebSocket;
  WebSocketServer = ws.WebSocketServer;
  websocketDepsAvailable = true;
} catch {
  websocketDepsAvailable = false;
}

async function createHarness(): Promise<RttHarness> {
  if (!(NodeWebSocket && WebSocketServer)) {
    throw new Error("ws dependency is required for RTT benchmarks");
  }

  const sessionEvents = new Map<string, TailEvent[]>();
  const sessionSockets = new Map<string, Set<BenchWebSocket>>();

  const appendToSessionLog = (sessionId: string, event: TailEvent): void => {
    const events = sessionEvents.get(sessionId) ?? [];
    events.push(event);
    sessionEvents.set(sessionId, events);
  };

  const broadcastToSession = (sessionId: string, event: TailEvent): void => {
    const frame = JSON.stringify(event);
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      try {
        if (socket.readyState === 1) {
          socket.send(frame);
        }
      } catch {
        // Best effort broadcast for benchmark transport simulation.
      }
    }
  };

  const writeJson = (
    response: ServerResponse,
    statusCode: number,
    body: unknown
  ): void => {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  };

  const handleAppendRequest = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const sessionId = toSessionId(requestUrl.pathname);
    if (!(sessionId && requestUrl.pathname.endsWith("/append"))) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    const rawBody = await readJsonBody(request);
    if (!isRecord(rawBody)) {
      writeJson(response, 400, { error: "invalid_body" });
      return;
    }

    const currentEvents = sessionEvents.get(sessionId) ?? [];
    const seq = (currentEvents.at(-1)?.seq ?? 0) + 1;
    const payload = isRecord(rawBody.payload)
      ? rawBody.payload
      : {
          text: readString(rawBody.text, `event-${seq}`, true),
        };

    const event: TailEvent = {
      seq,
      type: readString(rawBody.type, "content"),
      payload,
      actor: readString(rawBody.actor, "agent:bench"),
      producer_id: readString(rawBody.producer_id, "producer:bench"),
      producer_seq:
        typeof rawBody.producer_seq === "number" && rawBody.producer_seq > 0
          ? rawBody.producer_seq
          : seq,
    };

    appendToSessionLog(sessionId, event);
    broadcastToSession(sessionId, event);

    writeJson(response, 201, {
      seq,
      last_seq: seq,
      deduped: false,
    });
  };

  const httpServer = createServer(async (request, response) => {
    if (request.method === "POST") {
      try {
        await handleAppendRequest(request, response);
      } catch {
        writeJson(response, 400, { error: "invalid_body" });
      }
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  const websocketServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    websocketServer.handleUpgrade(
      request,
      socket,
      head,
      (websocket: BenchWebSocket) => {
        websocketServer.emit("connection", websocket, request);
      }
    );
  });

  websocketServer.on(
    "connection",
    (websocket: BenchWebSocket, request: IncomingMessage) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const sessionId = toSessionId(requestUrl.pathname);
      if (!(sessionId && requestUrl.pathname.endsWith("/tail"))) {
        websocket.close(1008, "invalid path");
        return;
      }

      const cursor = Number.parseInt(
        requestUrl.searchParams.get("cursor") ?? "0",
        10
      );
      const safeCursor = Number.isNaN(cursor) ? 0 : cursor;

      const sockets = sessionSockets.get(sessionId) ?? new Set();
      sockets.add(websocket);
      sessionSockets.set(sessionId, sockets);

      websocket.on("close", () => {
        const current = sessionSockets.get(sessionId);
        if (!current) {
          return;
        }

        current.delete(websocket);
        if (current.size === 0) {
          sessionSockets.delete(sessionId);
        }
      });

      const replayEvents = (sessionEvents.get(sessionId) ?? []).filter(
        (event) => event.seq > safeCursor
      );

      for (const event of replayEvents) {
        websocket.send(JSON.stringify(event));
      }

      // History sessions model catch-up + close semantics for RTT replay measurement.
      if (sessionId.startsWith("history_")) {
        websocket.close(1000, "replay complete");
      }
    }
  );

  await listenOnRandomPort(httpServer);
  const address = httpServer.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve bench server address");
  }

  const client = new Starcite({
    baseUrl: `http://127.0.0.1:${address.port}`,
    websocketFactory: (url) =>
      new NodeWebSocket(url) as unknown as StarciteWebSocket,
  });

  return {
    clearSession: (sessionId: string) => {
      sessionEvents.delete(sessionId);
      sessionSockets.delete(sessionId);
    },
    client,
    close: async () => {
      for (const socket of websocketServer.clients) {
        socket.terminate();
      }

      await closeWebSocketServer(websocketServer);
      await closeServer(httpServer);
    },
    seedSessionEvent: (sessionId: string, text: string) => {
      const event: TailEvent = {
        seq: 1,
        type: "content",
        payload: { text },
        actor: "agent:bench",
        producer_id: "producer:bench",
        producer_seq: 1,
      };
      sessionEvents.set(sessionId, [event]);
    },
  };
}

let harnessPromise: Promise<RttHarness> | undefined;

function ensureHarness(): Promise<RttHarness> {
  if (!harnessPromise) {
    harnessPromise = createHarness();
  }

  return harnessPromise;
}

const describeRttBench = websocketDepsAvailable ? describe : describe.skip;

describeRttBench("Network RTT overhead (loopback integration)", () => {
  let appendIteration = 0;
  bench(
    "append HTTP roundtrip RTT (loopback)",
    async () => {
      const harness = await ensureHarness();
      appendIteration += 1;
      const sessionId = `append_${appendIteration}`;
      const session = harness.client.session({
        token: makeTailSessionToken(sessionId),
      });

      try {
        await session.append({
          text: "benchmark append",
        });
      } finally {
        session.disconnect();
        harness.clearSession(sessionId);
      }
    },
    { iterations: 80 }
  );

  let replayIteration = 0;
  bench(
    "tail replay catch-up RTT from cursor (loopback websocket)",
    async () => {
      const harness = await ensureHarness();
      replayIteration += 1;
      const sessionId = `history_${replayIteration}`;
      harness.seedSessionEvent(sessionId, "seeded for replay");
      const session = harness.client.session({
        token: makeTailSessionToken(sessionId),
      });

      try {
        for await (const _item of session.tail({
          cursor: 0,
          follow: false,
          reconnect: false,
          catchUpIdleMs: 5,
        })) {
          // Drain catch-up stream to completion.
        }
      } finally {
        session.disconnect();
        harness.clearSession(sessionId);
      }
    },
    { iterations: 50 }
  );

  let liveIteration = 0;
  bench(
    "append -> live on('event') delivery RTT (HTTP + websocket loopback)",
    async () => {
      const harness = await ensureHarness();
      liveIteration += 1;
      const sessionId = `live_${liveIteration}`;
      const session = harness.client.session({
        token: makeTailSessionToken(sessionId),
      });

      const received = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for live event delivery"));
        }, 1500);

        const off = session.on(
          "event",
          (_event) => {
            clearTimeout(timeout);
            off();
            resolve();
          },
          { replay: false }
        );
      });

      try {
        await session.append({ text: "live delivery event" });
        await received;
      } finally {
        session.disconnect();
        harness.clearSession(sessionId);
      }
    },
    { iterations: 50 }
  );
});
