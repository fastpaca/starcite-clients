import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Starcite } from "../src/client";
import type { StarciteWebSocket } from "../src/types";

/**
 * Creates a minimal JWT with the given claims for test session construction.
 */
function tokenFromClaims(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.N6fK2qA`;
}

function makeTailSessionToken(
  sessionId: string,
  principalId = "agent:drafter"
): string {
  return tokenFromClaims({
    session_id: sessionId,
    tenant_id: "test-tenant",
    principal_id: principalId,
    principal_type: principalId.startsWith("agent:") ? "agent" : "user",
  });
}

function encodeTailFrame(seq: number, text: string): string {
  return JSON.stringify({
    seq,
    type: "content",
    payload: { text },
    actor: "agent:drafter",
    producer_id: "producer:drafter",
    producer_seq: seq,
  });
}

function range(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}

function createDeterministicRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) {
    state += 2_147_483_646;
  }

  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

function randomIntegerInRange(
  random: () => number,
  minInclusive: number,
  maxInclusive: number
): number {
  const span = maxInclusive - minInclusive + 1;
  return minInclusive + Math.floor(random() * span);
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

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
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

const require = createRequire(import.meta.url);
let NodeWebSocket: any;
let WebSocketServer: any;
let websocketDepsAvailable = false;

try {
  const ws = require("ws");
  NodeWebSocket = ws.WebSocket;
  WebSocketServer = ws.WebSocketServer;
  websocketDepsAvailable = true;
} catch {
  websocketDepsAvailable = false;
}

const describeWebSocketIntegration = websocketDepsAvailable
  ? describe
  : describe.skip;

describeWebSocketIntegration("Starcite tail reconnect integration", () => {
  it("reconnects after a yanked transport and catches up from the last seq", async () => {
    const httpServer = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    const cursorsSeenByServer: number[] = [];
    let connections = 0;

    httpServer.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });

    websocketServer.on("connection", (websocket, request) => {
      connections += 1;

      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const cursor = Number.parseInt(
        requestUrl.searchParams.get("cursor") ?? "0",
        10
      );
      cursorsSeenByServer.push(Number.isNaN(cursor) ? -1 : cursor);

      if (connections === 1) {
        websocket.send(encodeTailFrame(1, "first frame"), () => {
          // Simulate abrupt network loss/deployment yank (non-graceful close).
          websocket.terminate();
        });
        return;
      }

      websocket.send(encodeTailFrame(2, "second frame"), () => {
        websocket.send(encodeTailFrame(3, "third frame"), () => {
          websocket.close(1000, "finished");
        });
      });
    });

    await listenOnRandomPort(httpServer);

    try {
      const address = httpServer.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve local test server address");
      }

      const starcite = new Starcite({
        baseUrl: `http://127.0.0.1:${address.port}`,
        websocketFactory: (url) =>
          new NodeWebSocket(url) as unknown as StarciteWebSocket,
      });

      const sessionToken = makeTailSessionToken("ses_integration");
      const session = await starcite.session({ token: sessionToken });
      const observedSeqs: number[] = [];

      for await (const event of session.tail({
        cursor: 0,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 10,
        },
      })) {
        observedSeqs.push(event.seq);
      }

      expect(observedSeqs).toEqual([1, 2, 3]);
      expect(cursorsSeenByServer).toEqual([0, 1]);
      expect(connections).toBe(2);
    } finally {
      for (const clientSocket of websocketServer.clients) {
        clientSocket.terminate();
      }
      await closeWebSocketServer(websocketServer);
      await closeServer(httpServer);
    }
  });

  it("keeps up with 200ms producers across repeated yanked connections", async () => {
    const httpServer = createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    const replayLog = new Map<number, string>();
    const activeSockets = new Set<NodeWebSocket>();
    const cursorsSeenByServer: number[] = [];
    const TARGET_SEQ = 12;
    const PRODUCER_INTERVAL_MS = 200;
    const YANK_AFTER_MS = 450;

    let connections = 0;
    let lastProducedSeq = 0;
    let producerTimer: ReturnType<typeof setInterval> | undefined;

    httpServer.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });

    websocketServer.on("connection", (websocket, request) => {
      connections += 1;
      const ws = websocket as unknown as NodeWebSocket;
      activeSockets.add(ws);

      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const cursor = Number.parseInt(
        requestUrl.searchParams.get("cursor") ?? "0",
        10
      );
      const safeCursor = Number.isNaN(cursor) ? 0 : cursor;
      cursorsSeenByServer.push(safeCursor);

      for (let seq = safeCursor + 1; seq <= lastProducedSeq; seq += 1) {
        const frame = replayLog.get(seq);
        if (frame) {
          ws.send(frame);
        }
      }

      const yankTimer = setTimeout(() => {
        if (lastProducedSeq < TARGET_SEQ && ws.readyState === ws.OPEN) {
          ws.terminate();
        }
      }, YANK_AFTER_MS);

      ws.on("close", () => {
        clearTimeout(yankTimer);
        activeSockets.delete(ws);
      });
    });

    await listenOnRandomPort(httpServer);

    try {
      const address = httpServer.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve local test server address");
      }

      producerTimer = setInterval(() => {
        lastProducedSeq += 1;
        const frame = encodeTailFrame(
          lastProducedSeq,
          `frame ${lastProducedSeq}`
        );
        replayLog.set(lastProducedSeq, frame);

        for (const ws of activeSockets) {
          if (ws.readyState === ws.OPEN) {
            ws.send(frame);
          }
        }

        if (lastProducedSeq >= TARGET_SEQ) {
          clearInterval(producerTimer);
          for (const ws of activeSockets) {
            if (ws.readyState === ws.OPEN) {
              ws.close(1000, "producer-finished");
            }
          }
        }
      }, PRODUCER_INTERVAL_MS);

      const starcite = new Starcite({
        baseUrl: `http://127.0.0.1:${address.port}`,
        websocketFactory: (url) =>
          new NodeWebSocket(url) as unknown as StarciteWebSocket,
      });

      const sessionToken = makeTailSessionToken("ses_stream_stress");
      const session = await starcite.session({ token: sessionToken });
      const observedSeqs: number[] = [];

      for await (const event of session.tail({
        cursor: 0,
        reconnectPolicy: {
          mode: "fixed",
          initialDelayMs: 25,
        },
      })) {
        observedSeqs.push(event.seq);
      }

      expect(observedSeqs).toEqual(range(1, TARGET_SEQ));
      expect(connections).toBeGreaterThanOrEqual(3);
      expect(cursorsSeenByServer[0]).toBe(0);

      for (let index = 1; index < cursorsSeenByServer.length; index += 1) {
        const previous = cursorsSeenByServer[index - 1] ?? 0;
        const current = cursorsSeenByServer[index] ?? 0;
        expect(current).toBeGreaterThanOrEqual(previous);
      }
    } finally {
      if (producerTimer) {
        clearInterval(producerTimer);
      }

      for (const clientSocket of websocketServer.clients) {
        clientSocket.terminate();
      }
      await closeWebSocketServer(websocketServer);
      await closeServer(httpServer);
    }
  }, 15_000);

  it.runIf(process.env.STARCITE_SDK_RUN_SOAK === "1")(
    "soak: keeps up with 200ms producers during prolonged random yanks",
    async () => {
      const httpServer = createServer();
      const websocketServer = new WebSocketServer({ noServer: true });
      const replayLog = new Map<number, string>();
      const activeSockets = new Set<NodeWebSocket>();
      const cursorsSeenByServer: number[] = [];
      const deterministicRandom = createDeterministicRandom(42);

      const TARGET_SEQ = 180;
      const PRODUCER_INTERVAL_MS = 200;
      const MIN_YANK_AFTER_MS = 220;
      const MAX_YANK_AFTER_MS = 1100;

      let connections = 0;
      let lastProducedSeq = 0;
      let producerTimer: ReturnType<typeof setInterval> | undefined;

      httpServer.on("upgrade", (request, socket, head) => {
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          websocketServer.emit("connection", websocket, request);
        });
      });

      websocketServer.on("connection", (websocket, request) => {
        connections += 1;
        const ws = websocket as unknown as NodeWebSocket;
        activeSockets.add(ws);

        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const cursor = Number.parseInt(
          requestUrl.searchParams.get("cursor") ?? "0",
          10
        );
        const safeCursor = Number.isNaN(cursor) ? 0 : cursor;
        cursorsSeenByServer.push(safeCursor);

        for (let seq = safeCursor + 1; seq <= lastProducedSeq; seq += 1) {
          const frame = replayLog.get(seq);
          if (frame) {
            ws.send(frame);
          }
        }

        if (lastProducedSeq >= TARGET_SEQ) {
          setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
              ws.close(1000, "producer-finished");
            }
          }, 25);
        }

        const yankAfterMs = randomIntegerInRange(
          deterministicRandom,
          MIN_YANK_AFTER_MS,
          MAX_YANK_AFTER_MS
        );

        const yankTimer = setTimeout(() => {
          if (lastProducedSeq < TARGET_SEQ && ws.readyState === ws.OPEN) {
            ws.terminate();
          }
        }, yankAfterMs);

        ws.on("close", () => {
          clearTimeout(yankTimer);
          activeSockets.delete(ws);
        });
      });

      await listenOnRandomPort(httpServer);

      try {
        const address = httpServer.address() as AddressInfo | null;
        if (!address || typeof address === "string") {
          throw new Error("Failed to resolve local test server address");
        }

        producerTimer = setInterval(() => {
          lastProducedSeq += 1;
          const frame = encodeTailFrame(
            lastProducedSeq,
            `soak frame ${lastProducedSeq}`
          );
          replayLog.set(lastProducedSeq, frame);

          for (const ws of activeSockets) {
            if (ws.readyState === ws.OPEN) {
              ws.send(frame);
            }
          }

          if (lastProducedSeq >= TARGET_SEQ) {
            clearInterval(producerTimer);
            for (const ws of activeSockets) {
              if (ws.readyState === ws.OPEN) {
                ws.close(1000, "producer-finished");
              }
            }
          }
        }, PRODUCER_INTERVAL_MS);

        const starcite = new Starcite({
          baseUrl: `http://127.0.0.1:${address.port}`,
          websocketFactory: (url) =>
            new NodeWebSocket(url) as unknown as StarciteWebSocket,
        });

        const sessionToken = makeTailSessionToken("ses_soak");
        const session = await starcite.session({ token: sessionToken });
        const observedSeqs: number[] = [];

        for await (const event of session.tail({
          cursor: 0,
          reconnectPolicy: {
            mode: "fixed",
            initialDelayMs: 25,
          },
        })) {
          observedSeqs.push(event.seq);
        }

        expect(observedSeqs).toEqual(range(1, TARGET_SEQ));
        expect(connections).toBeGreaterThanOrEqual(10);
        expect(cursorsSeenByServer[0]).toBe(0);

        for (let index = 1; index < cursorsSeenByServer.length; index += 1) {
          const previous = cursorsSeenByServer[index - 1] ?? 0;
          const current = cursorsSeenByServer[index] ?? 0;
          expect(current).toBeGreaterThanOrEqual(previous);
        }
      } finally {
        if (producerTimer) {
          clearInterval(producerTimer);
        }

        for (const clientSocket of websocketServer.clients) {
          clientSocket.terminate();
        }
        await closeWebSocketServer(websocketServer);
        await closeServer(httpServer);
      }
    },
    70_000
  );
});
