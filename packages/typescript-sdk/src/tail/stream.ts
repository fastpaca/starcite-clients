import {
  StarciteBackpressureError,
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "../errors";
import { agentFromActor } from "../identity";
import type {
  SessionTailOptions,
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
  TailEvent,
  TailLifecycleEvent,
} from "../types";
import { parseTailFrame } from "./frame";
import { ManagedWebSocket } from "./managed-websocket";

const NORMAL_CLOSE_CODE = 1000;

interface ResolvedReconnectPolicy {
  mode: "fixed" | "exponential";
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxAttempts: number;
}

class AsyncBatchQueue<T> {
  private readonly values: T[] = [];
  private error: unknown;
  private ended = false;
  private waiting:
    | {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  push(value: T): void {
    if (this.ended || this.error !== undefined) {
      return;
    }

    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  fail(error: unknown): void {
    if (this.ended || this.error !== undefined) {
      return;
    }

    this.error = error;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.reject(error);
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ done: true, value: undefined });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return { done: false, value };
    }

    if (this.error !== undefined) {
      throw this.error;
    }

    if (this.ended) {
      return { done: true, value: undefined };
    }

    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
}

/**
 * Stateful tail runner powered by a managed websocket loop.
 */
export class TailStream {
  private readonly sessionId: string;
  private readonly token: string | undefined;
  private readonly websocketBaseUrl: string;
  private readonly websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;
  private readonly websocketAuthTransport: "header" | "access_token";

  private readonly batchSize: number | undefined;
  private readonly agent: string | undefined;
  private readonly follow: boolean;
  private readonly shouldReconnect: boolean;
  private readonly reconnectPolicy: ResolvedReconnectPolicy;
  private readonly catchUpIdleMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly maxBufferedBatches: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onLifecycleEvent:
    | ((event: TailLifecycleEvent) => void)
    | undefined;

  private cursor: number;

  constructor(input: {
    sessionId: string;
    token: string | undefined;
    websocketBaseUrl: string;
    websocketFactory: (
      url: string,
      options?: StarciteWebSocketConnectOptions
    ) => StarciteWebSocket;
    websocketAuthTransport: "header" | "access_token";
    options: SessionTailOptions;
  }) {
    const opts = input.options;
    const follow = opts.follow ?? true;
    const policy = opts.reconnectPolicy;
    const mode: "fixed" | "exponential" =
      policy?.mode === "fixed" ? "fixed" : "exponential";
    const initialDelayMs = policy?.initialDelayMs ?? 500;

    this.sessionId = input.sessionId;
    this.token = input.token;
    this.websocketBaseUrl = input.websocketBaseUrl;
    this.websocketFactory = input.websocketFactory;
    this.websocketAuthTransport = input.websocketAuthTransport;

    this.cursor = opts.cursor ?? 0;
    this.batchSize = opts.batchSize;
    this.agent = opts.agent?.trim();
    this.follow = follow;
    this.shouldReconnect = follow ? (opts.reconnect ?? true) : false;
    this.catchUpIdleMs = opts.catchUpIdleMs ?? 1000;
    this.connectionTimeoutMs = opts.connectionTimeoutMs ?? 4000;
    this.inactivityTimeoutMs = opts.inactivityTimeoutMs;
    this.maxBufferedBatches = opts.maxBufferedBatches ?? 1024;
    this.signal = opts.signal;
    this.onLifecycleEvent = opts.onLifecycleEvent;

    this.reconnectPolicy = {
      mode,
      initialDelayMs,
      maxDelayMs:
        policy?.maxDelayMs ??
        (mode === "fixed" ? initialDelayMs : Math.max(initialDelayMs, 15_000)),
      multiplier: mode === "fixed" ? 1 : (policy?.multiplier ?? 2),
      jitterRatio: policy?.jitterRatio ?? 0.2,
      maxAttempts: policy?.maxAttempts ?? Number.POSITIVE_INFINITY,
    };
  }

  async *run(): AsyncGenerator<TailEvent[]> {
    const queue = new AsyncBatchQueue<TailEvent[]>();
    const controller = new AbortController();
    const signal = combineAbortSignals(this.signal, controller.signal);

    const task = this.subscribeWithSignal((batch) => {
      queue.push(batch);
    }, signal)
      .then(() => {
        queue.end();
      })
      .catch((error) => {
        queue.fail(error);
      });

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    } finally {
      controller.abort();
      await task;
    }
  }

  /**
   * Pushes batches to a callback, enabling emitter-style consumers.
   */
  async subscribe(
    onBatch: (batch: TailEvent[]) => void | Promise<void>
  ): Promise<void> {
    await this.subscribeWithSignal(onBatch, this.signal);
  }

  private async subscribeWithSignal(
    onBatch: (batch: TailEvent[]) => void | Promise<void>,
    signal: AbortSignal | undefined
  ): Promise<void> {
    let streamError: unknown;
    let streamReason: "aborted" | "caught_up" | "graceful" = this.follow
      ? "graceful"
      : "caught_up";
    let queuedBatches = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    let dispatchChain: Promise<void> = Promise.resolve();

    const stream = new ManagedWebSocket({
      url: () => this.buildTailUrl(),
      websocketFactory: this.websocketFactory,
      connectOptions: this.buildConnectOptions(),
      signal,
      shouldReconnect: this.shouldReconnect,
      reconnectPolicy: {
        initialDelayMs: this.reconnectPolicy.initialDelayMs,
        maxDelayMs: this.reconnectPolicy.maxDelayMs,
        multiplier: this.reconnectPolicy.multiplier,
        jitterRatio: this.reconnectPolicy.jitterRatio,
        maxAttempts: this.reconnectPolicy.maxAttempts,
      },
      connectionTimeoutMs: this.connectionTimeoutMs,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
    });

    const fail = (error: unknown): void => {
      if (streamError !== undefined) {
        return;
      }
      streamError = error;
      stream.close(NORMAL_CLOSE_CODE, "stream failed");
    };

    const emitLifecycle = (event: TailLifecycleEvent): void => {
      if (!this.onLifecycleEvent) {
        return;
      }

      try {
        this.onLifecycleEvent(event);
      } catch (error) {
        fail(error);
      }
    };

    const clearCatchUpTimer = (): void => {
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
        catchUpTimer = undefined;
      }
    };

    const scheduleCatchUpClose = (): void => {
      if (this.follow) {
        return;
      }

      clearCatchUpTimer();
      catchUpTimer = setTimeout(() => {
        streamReason = "caught_up";
        stream.close(NORMAL_CLOSE_CODE, "caught up");
      }, this.catchUpIdleMs);
    };

    const dispatchBatch = (batch: TailEvent[]): void => {
      if (streamError !== undefined) {
        return;
      }

      if (
        this.maxBufferedBatches > 0 &&
        queuedBatches > this.maxBufferedBatches
      ) {
        fail(
          new StarciteBackpressureError(
            `Tail consumer for session '${this.sessionId}' fell behind after buffering ${this.maxBufferedBatches} batch(es)`,
            { sessionId: this.sessionId, attempts: 0 }
          )
        );
        return;
      }

      queuedBatches += 1;
      dispatchChain = dispatchChain
        .then(async () => {
          try {
            await onBatch(batch);
          } finally {
            queuedBatches -= 1;
          }
        })
        .catch((error) => {
          fail(error);
        });
    };

    const unsubscribers = [
      stream.onConnectAttempt((event) => {
        emitLifecycle({
          type: "connect_attempt",
          sessionId: this.sessionId,
          attempt: event.attempt,
          cursor: this.cursor,
        });
      }),
      stream.onConnectFailed((event) => {
        if (!this.shouldReconnect) {
          fail(
            new StarciteTailError(
              `Tail connection failed for session '${this.sessionId}': ${event.rootCause}`,
              {
                sessionId: this.sessionId,
                stage: "connect",
                attempts: event.attempt - 1,
              }
            )
          );
        }
      }),
      stream.onReconnectScheduled((event) => {
        emitLifecycle({
          type: "reconnect_scheduled",
          sessionId: this.sessionId,
          attempt: event.attempt,
          delayMs: event.delayMs,
          trigger: event.trigger,
          closeCode: event.closeCode,
          closeReason: event.closeReason,
        });
      }),
      stream.onDropped((event) => {
        if (event.closeCode === 4001 || event.closeReason === "token_expired") {
          fail(
            new StarciteTokenExpiredError(
              `Tail token expired for session '${this.sessionId}'. Re-issue a session token and reconnect from the last processed cursor.`,
              {
                sessionId: this.sessionId,
                attempts: event.attempt,
                closeCode: event.closeCode,
                closeReason: event.closeReason,
              }
            )
          );
          return;
        }

        emitLifecycle({
          type: "stream_dropped",
          sessionId: this.sessionId,
          attempt: event.attempt,
          closeCode: event.closeCode,
          closeReason: event.closeReason,
        });

        if (!this.shouldReconnect) {
          fail(
            new StarciteTailError(
              `Tail connection dropped for session '${this.sessionId}' (${describeClose(event.closeCode, event.closeReason)})`,
              {
                sessionId: this.sessionId,
                stage: "stream",
                attempts: event.attempt - 1,
                closeCode: event.closeCode,
                closeReason: event.closeReason,
              }
            )
          );
        }
      }),
      stream.onRetryLimit((event) => {
        const message =
          event.trigger === "connect_failed"
            ? `Tail connection failed for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s): ${event.rootCause ?? "Unknown error"}`
            : `Tail connection dropped for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s) (${describeClose(event.closeCode, event.closeReason)})`;

        fail(
          new StarciteRetryLimitError(message, {
            sessionId: this.sessionId,
            attempts: event.attempt,
            closeCode: event.closeCode,
            closeReason: event.closeReason,
          })
        );
      }),
      stream.onOpen(() => {
        scheduleCatchUpClose();
      }),
      stream.onMessage((data) => {
        try {
          const parsedEvents = parseTailFrame(data);
          const matchingEvents: TailEvent[] = [];

          for (const parsedEvent of parsedEvents) {
            this.cursor = Math.max(this.cursor, parsedEvent.seq);

            if (
              this.agent &&
              agentFromActor(parsedEvent.actor) !== this.agent
            ) {
              continue;
            }

            matchingEvents.push(parsedEvent);
          }

          if (matchingEvents.length > 0) {
            stream.resetReconnectAttempts();
            dispatchBatch(matchingEvents);
          }

          scheduleCatchUpClose();
        } catch (error) {
          fail(error);
        }
      }),
      stream.onFatal((error) => {
        fail(error);
      }),
      stream.onClosed((event) => {
        clearCatchUpTimer();
        if (event.aborted) {
          streamReason = "aborted";
          return;
        }

        if (!this.follow) {
          streamReason = "caught_up";
          return;
        }

        if (event.graceful) {
          streamReason = "graceful";
        }
      }),
    ];

    try {
      await stream.waitForClose();
      clearCatchUpTimer();
      await dispatchChain;

      if (streamError !== undefined) {
        throw streamError;
      }

      emitLifecycle({
        type: "stream_ended",
        sessionId: this.sessionId,
        reason: streamReason,
      });

      if (streamError !== undefined) {
        throw streamError;
      }
    } finally {
      clearCatchUpTimer();
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      stream.close(NORMAL_CLOSE_CODE, "finished");
    }
  }

  private buildTailUrl(): string {
    const query = new URLSearchParams({ cursor: `${this.cursor}` });

    if (this.batchSize !== undefined) {
      query.set("batch_size", `${this.batchSize}`);
    }

    if (this.websocketAuthTransport === "access_token" && this.token) {
      query.set("access_token", this.token);
    }

    return `${this.websocketBaseUrl}/sessions/${encodeURIComponent(
      this.sessionId
    )}/tail?${query.toString()}`;
  }

  private buildConnectOptions(): StarciteWebSocketConnectOptions | undefined {
    if (this.websocketAuthTransport !== "header" || !this.token) {
      return undefined;
    }

    return {
      headers: {
        authorization: `Bearer ${this.token}`,
      },
    };
  }
}

function describeClose(
  code: number | undefined,
  reason: string | undefined
): string {
  const codeText = `code ${code ?? "unknown"}`;
  return reason ? `${codeText}, reason '${reason}'` : codeText;
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined
): AbortSignal | undefined {
  if (!(first || second)) {
    return undefined;
  }

  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
    first.removeEventListener("abort", abort);
    second.removeEventListener("abort", abort);
  };

  if (first.aborted || second.aborted) {
    controller.abort();
    return controller.signal;
  }

  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
