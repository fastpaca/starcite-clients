import { StarciteConnectionError, StarciteError } from "../errors";
import { AsyncQueue } from "../internal/async-queue";
import type {
  SessionTailOptions,
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
  TailEvent,
} from "../types";
import {
  MAX_TAIL_BATCH_SIZE,
  MIN_TAIL_BATCH_SIZE,
  parseTailFrame,
} from "./frame";
import { agentFromActor } from "./transform";

const DEFAULT_TAIL_RECONNECT_DELAY_MS = 3000;
const CATCH_UP_IDLE_MS = 1000;
const NORMAL_WEBSOCKET_CLOSE_CODE = 1000;

interface TailStreamInput {
  sessionId: string;
  options: SessionTailOptions;
  websocketBaseUrl: string;
  websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;
  authorization?: string | null;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function describeClose(
  code: number | undefined,
  reason: string | undefined
): string {
  const codeText = `code ${typeof code === "number" ? code : "unknown"}`;
  return reason ? `${codeText}, reason '${reason}'` : codeText;
}

async function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single-loop reconnect state machine is intentionally explicit for stream correctness.
export async function* streamTailRawEventBatches({
  sessionId,
  options,
  websocketBaseUrl,
  websocketFactory,
  authorization,
}: TailStreamInput): AsyncGenerator<TailEvent[]> {
  const initialCursor = options.cursor ?? 0;
  const batchSize = options.batchSize;
  const follow = options.follow ?? true;
  const reconnectEnabled = follow ? (options.reconnect ?? true) : false;
  const reconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_TAIL_RECONNECT_DELAY_MS;

  if (!Number.isInteger(initialCursor) || initialCursor < 0) {
    throw new StarciteError("tail() cursor must be a non-negative integer");
  }

  if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
    throw new StarciteError(
      "tail() reconnectDelayMs must be a non-negative number"
    );
  }

  if (
    batchSize !== undefined &&
    (!Number.isInteger(batchSize) ||
      batchSize < MIN_TAIL_BATCH_SIZE ||
      batchSize > MAX_TAIL_BATCH_SIZE)
  ) {
    throw new StarciteError(
      `tail() batchSize must be an integer between ${MIN_TAIL_BATCH_SIZE} and ${MAX_TAIL_BATCH_SIZE}`
    );
  }

  let cursor = initialCursor;

  while (true) {
    if (options.signal?.aborted) {
      return;
    }

    const tailQuery = new URLSearchParams({
      cursor: `${cursor}`,
    });

    if (batchSize !== undefined) {
      tailQuery.set("batch_size", `${batchSize}`);
    }

    const wsUrl = `${websocketBaseUrl}/sessions/${encodeURIComponent(
      sessionId
    )}/tail?${tailQuery.toString()}`;

    const websocketHeaders = new Headers();

    if (authorization) {
      websocketHeaders.set("authorization", authorization);
    }

    let hasWebsocketHeaders = false;
    for (const _ of websocketHeaders.keys()) {
      hasWebsocketHeaders = true;
      break;
    }

    let socket: StarciteWebSocket;

    try {
      socket = websocketFactory(
        wsUrl,
        hasWebsocketHeaders
          ? {
              headers: websocketHeaders,
            }
          : undefined
      );
    } catch (error) {
      const rootCause = toError(error).message;

      if (!reconnectEnabled || options.signal?.aborted) {
        throw new StarciteConnectionError(
          `Tail connection failed for session '${sessionId}': ${rootCause}`
        );
      }

      await waitForDelay(reconnectDelayMs, options.signal);
      continue;
    }

    const queue = new AsyncQueue<TailEvent[]>();
    let sawTransportError = false;
    let closeCode: number | undefined;
    let closeReason: string | undefined;
    let abortRequested = false;

    let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

    const resetCatchUpTimer = (): void => {
      if (!follow) {
        if (catchUpTimer) {
          clearTimeout(catchUpTimer);
        }
        catchUpTimer = setTimeout(() => {
          queue.close();
        }, CATCH_UP_IDLE_MS);
      }
    };

    const onMessage = (event: unknown): void => {
      try {
        const messageData =
          event && typeof event === "object" && "data" in event
            ? (event as { data?: unknown }).data
            : undefined;
        const parsedEvents = parseTailFrame(messageData);
        const matchingEvents: TailEvent[] = [];

        for (const parsedEvent of parsedEvents) {
          cursor = Math.max(cursor, parsedEvent.seq);

          if (
            options.agent &&
            agentFromActor(parsedEvent.actor) !== options.agent
          ) {
            continue;
          }

          matchingEvents.push(parsedEvent);
        }

        if (matchingEvents.length > 0) {
          queue.push(matchingEvents);
        }

        resetCatchUpTimer();
      } catch (error) {
        queue.fail(error);
      }
    };

    const onError = (): void => {
      sawTransportError = true;
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }
      queue.close();
    };

    const onClose = (event: unknown): void => {
      closeCode =
        event && typeof event === "object" && "code" in event
          ? ((event as { code?: unknown }).code as number)
          : undefined;
      closeReason =
        event && typeof event === "object" && "reason" in event
          ? ((event as { reason?: unknown }).reason as string)
          : undefined;
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }
      queue.close();
    };

    const onAbort = (): void => {
      abortRequested = true;
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }
      queue.close();
      socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "aborted");
    };

    const onOpen = (): void => {
      resetCatchUpTimer();
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let iterationError: Error | null = null;

    try {
      while (true) {
        const next = await queue.next();

        if (next.done) {
          break;
        }

        yield next.value;
      }
    } catch (error) {
      iterationError = toError(error);
    } finally {
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);

      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }

      socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "finished");
    }

    if (iterationError) {
      throw iterationError;
    }

    if (abortRequested || options.signal?.aborted || !follow) {
      return;
    }

    const gracefullyClosed =
      !sawTransportError && closeCode === NORMAL_WEBSOCKET_CLOSE_CODE;

    if (gracefullyClosed) {
      return;
    }

    if (!reconnectEnabled) {
      throw new StarciteConnectionError(
        `Tail connection dropped for session '${sessionId}' (${describeClose(
          closeCode,
          closeReason
        )})`
      );
    }

    await waitForDelay(reconnectDelayMs, options.signal);
  }
}
