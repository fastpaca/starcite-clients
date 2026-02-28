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
  StarciteWebSocketCloseEvent,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketMessageEvent,
  TailEvent,
  TailLifecycleEvent,
} from "../types";
import { parseTailFrame } from "./frame";

const NORMAL_CLOSE_CODE = 1000;

/**
 * Terminal state returned by one websocket connection attempt.
 */
type ConnectionEnd =
  | { reason: "aborted" }
  | { reason: "caught_up" }
  | { reason: "graceful" }
  | {
      reason: "dropped";
      closeCode?: number;
      closeReason?: string;
      emittedBatches: number;
    };

interface ResolvedReconnectPolicy {
  mode: "fixed" | "exponential";
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxAttempts: number;
}

/**
 * Stateful tail runner that reconnects and resumes from the latest cursor.
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
  private readonly maxBufferedBatches: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onLifecycleEvent:
    | ((event: TailLifecycleEvent) => void)
    | undefined;

  private cursor: number;
  private reconnectAttempts = 0;

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
    this.maxBufferedBatches = opts.maxBufferedBatches ?? 1024;
    this.signal = opts.signal;
    this.onLifecycleEvent = opts.onLifecycleEvent;

    this.reconnectPolicy = {
      mode,
      initialDelayMs,
      maxDelayMs:
        policy?.maxDelayMs ??
        (mode === "fixed"
          ? initialDelayMs
          : Math.max(initialDelayMs, 15_000)),
      multiplier: policy?.multiplier ?? 2,
      jitterRatio: policy?.jitterRatio ?? 0.2,
      maxAttempts: policy?.maxAttempts ?? Number.POSITIVE_INFINITY,
    };
  }

  async *run(): AsyncGenerator<TailEvent[]> {
    while (true) {
      if (this.signal?.aborted) {
        this.onLifecycleEvent?.({
          type: "stream_ended",
          sessionId: this.sessionId,
          reason: "aborted",
        });
        return;
      }

      this.onLifecycleEvent?.({
        type: "connect_attempt",
        sessionId: this.sessionId,
        attempt: this.reconnectAttempts + 1,
        cursor: this.cursor,
      });

      let socket: StarciteWebSocket;

      try {
        socket = this.websocketFactory(
          this.buildTailUrl(),
          this.buildConnectOptions()
        );
      } catch (error) {
        const reconnect = this.handleConnectFailure(
          error instanceof Error ? error.message : String(error)
        );
        this.reconnectAttempts = reconnect.attempt;
        await this.waitForDelay(reconnect.delayMs);
        continue;
      }

      const end = yield* this.streamSingleConnection(socket);

      if (
        end.reason === "aborted" ||
        end.reason === "caught_up" ||
        end.reason === "graceful"
      ) {
        this.onLifecycleEvent?.({
          type: "stream_ended",
          sessionId: this.sessionId,
          reason: end.reason,
        });
        return;
      }

      const reconnect = this.handleDroppedConnection(end);
      this.reconnectAttempts = reconnect.attempt;
      await this.waitForDelay(reconnect.delayMs);
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

  private buildConnectOptions():
    | StarciteWebSocketConnectOptions
    | undefined {
    if (this.websocketAuthTransport !== "header" || !this.token) {
      return undefined;
    }

    return { headers: { authorization: `Bearer ${this.token}` } };
  }

  private describeClose(
    code: number | undefined,
    reason: string | undefined
  ): string {
    const codeText = `code ${code ?? "unknown"}`;
    return reason ? `${codeText}, reason '${reason}'` : codeText;
  }

  /**
   * Computes reconnect delay with optional exponential backoff + jitter.
   */
  private reconnectDelayForAttempt(attempt: number): number {
    const { mode, initialDelayMs, maxDelayMs, multiplier, jitterRatio } =
      this.reconnectPolicy;
    const exponent = Math.max(0, attempt - 1);
    const baseDelayMs =
      mode === "fixed"
        ? initialDelayMs
        : Math.min(maxDelayMs, initialDelayMs * multiplier ** exponent);

    if (jitterRatio === 0) {
      return baseDelayMs;
    }

    const spread = baseDelayMs * jitterRatio;
    const min = Math.max(0, baseDelayMs - spread);
    const max = baseDelayMs + spread;
    return min + Math.random() * (max - min);
  }

  /**
   * Returns the next reconnect attempt or throws retry-limit failure.
   */
  private nextReconnectOrThrow(options: {
    trigger: "connect_failed" | "dropped";
    rootCause?: string;
    closeCode?: number;
    closeReason?: string;
    reconnectAttempts?: number;
  }): { attempt: number; delayMs: number } {
    const attempts = options.reconnectAttempts ?? this.reconnectAttempts;
    const attempt = attempts + 1;

    if (attempt > this.reconnectPolicy.maxAttempts) {
      const message =
        options.trigger === "connect_failed"
          ? `Tail connection failed for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s): ${options.rootCause ?? "Unknown error"}`
          : `Tail connection dropped for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s) (${this.describeClose(options.closeCode, options.closeReason)})`;

      throw new StarciteRetryLimitError(message, {
        sessionId: this.sessionId,
        attempts: attempt,
        closeCode: options.closeCode,
        closeReason: options.closeReason,
      });
    }

    const delayMs = this.reconnectDelayForAttempt(attempt);
    this.onLifecycleEvent?.({
      type: "reconnect_scheduled",
      sessionId: this.sessionId,
      attempt,
      delayMs,
      trigger: options.trigger,
      closeCode: options.closeCode,
      closeReason: options.closeReason,
    });

    return { attempt, delayMs };
  }

  private handleConnectFailure(rootCause: string): {
    attempt: number;
    delayMs: number;
  } {
    if (!this.shouldReconnect || this.signal?.aborted) {
      throw new StarciteTailError(
        `Tail connection failed for session '${this.sessionId}': ${rootCause}`,
        {
          sessionId: this.sessionId,
          stage: "connect",
          attempts: this.reconnectAttempts,
        }
      );
    }

    return this.nextReconnectOrThrow({
      trigger: "connect_failed",
      rootCause,
    });
  }

  private handleDroppedConnection(
    end: Extract<ConnectionEnd, { reason: "dropped" }>
  ): {
    attempt: number;
    delayMs: number;
  } {
    if (end.closeCode === 4001 || end.closeReason === "token_expired") {
      throw new StarciteTokenExpiredError(
        `Tail token expired for session '${this.sessionId}'. Re-issue a session token and reconnect from the last processed cursor.`,
        {
          sessionId: this.sessionId,
          attempts: this.reconnectAttempts,
          closeCode: end.closeCode,
          closeReason: end.closeReason,
        }
      );
    }

    this.onLifecycleEvent?.({
      type: "stream_dropped",
      sessionId: this.sessionId,
      attempt: this.reconnectAttempts + 1,
      closeCode: end.closeCode,
      closeReason: end.closeReason,
    });

    if (!this.shouldReconnect) {
      throw new StarciteTailError(
        `Tail connection dropped for session '${this.sessionId}' (${this.describeClose(end.closeCode, end.closeReason)})`,
        {
          sessionId: this.sessionId,
          stage: "stream",
          attempts: this.reconnectAttempts,
          closeCode: end.closeCode,
          closeReason: end.closeReason,
        }
      );
    }

    const reconnectAttempts =
      end.emittedBatches > 0 ? 0 : this.reconnectAttempts;
    return this.nextReconnectOrThrow({
      trigger: "dropped",
      closeCode: end.closeCode,
      closeReason: end.closeReason,
      reconnectAttempts,
    });
  }

  /**
   * Waits for reconnect delay while allowing abort to cut waits short.
   */
  private waitForDelay(ms: number): Promise<void> {
    if (ms <= 0 || this.signal?.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const cleanup = new AbortController();
      const timer = setTimeout(() => {
        cleanup.abort();
        resolve();
      }, ms);
      this.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          cleanup.abort();
          resolve();
        },
        { signal: cleanup.signal }
      );
    });
  }

  /**
   * Streams batches from a single websocket connection lifecycle.
   */
  private async *streamSingleConnection(
    socket: StarciteWebSocket
  ): AsyncGenerator<TailEvent[], ConnectionEnd> {
    const bufferedBatches: TailEvent[][] = [];
    let pendingResolve:
      | ((result: IteratorResult<TailEvent[]>) => void)
      | undefined;
    let pendingReject: ((error: unknown) => void) | undefined;
    let streamError: unknown;
    let streamClosed = false;
    let sawTransportError = false;
    let closeCode: number | undefined;
    let closeReason: string | undefined;
    let emittedBatches = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;

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
        closeBatches();
      }, this.catchUpIdleMs);
    };

    const emitBatch = (batch: TailEvent[]): void => {
      if (streamClosed || streamError !== undefined) {
        return;
      }

      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        pendingReject = undefined;
        resolve({ done: false, value: batch });
        return;
      }

      if (bufferedBatches.length >= this.maxBufferedBatches) {
        failBatches(
          new StarciteBackpressureError(
            `Tail consumer for session '${this.sessionId}' fell behind after buffering ${this.maxBufferedBatches} batch(es)`,
            {
              sessionId: this.sessionId,
              attempts: this.reconnectAttempts,
            }
          )
        );
        return;
      }

      bufferedBatches.push(batch);
    };

    const closeBatches = (): void => {
      if (streamClosed || streamError !== undefined) {
        return;
      }

      streamClosed = true;

      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        pendingReject = undefined;
        resolve({ done: true, value: undefined });
      }
    };

    const failBatches = (error: unknown): void => {
      if (streamClosed || streamError !== undefined) {
        return;
      }

      streamError = error;

      if (pendingReject) {
        const reject = pendingReject;
        pendingResolve = undefined;
        pendingReject = undefined;
        reject(error);
      }
    };

    const readNextBatch = async (): Promise<IteratorResult<TailEvent[]>> => {
      if (bufferedBatches.length > 0) {
        const value = bufferedBatches.shift() as TailEvent[];
        return { done: false, value };
      }

      if (streamError !== undefined) {
        throw streamError;
      }

      if (streamClosed) {
        return { done: true, value: undefined };
      }

      return await new Promise<IteratorResult<TailEvent[]>>(
        (resolve, reject) => {
          pendingResolve = resolve;
          pendingReject = reject;
        }
      );
    };

    const onMessage = (event: StarciteWebSocketMessageEvent): void => {
      try {
        const parsedEvents = parseTailFrame(event.data);
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
          emitBatch(matchingEvents);
        }

        scheduleCatchUpClose();
      } catch (error) {
        failBatches(error);
      }
    };

    const onError = (): void => {
      sawTransportError = true;
      clearCatchUpTimer();
      closeBatches();
    };

    const onClose = (event: StarciteWebSocketCloseEvent): void => {
      closeCode = event.code;
      closeReason = event.reason;
      clearCatchUpTimer();
      closeBatches();
    };

    const onAbort = (): void => {
      clearCatchUpTimer();
      closeBatches();
      socket.close(NORMAL_CLOSE_CODE, "aborted");
    };

    const onOpen = (): void => {
      scheduleCatchUpClose();
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    if (this.signal) {
      if (this.signal.aborted) {
        onAbort();
      } else {
        this.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      while (true) {
        const next = await readNextBatch();

        if (next.done) {
          break;
        }

        emittedBatches += 1;
        yield next.value;
      }
    } finally {
      clearCatchUpTimer();
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);

      if (this.signal) {
        this.signal.removeEventListener("abort", onAbort);
      }

      socket.close(NORMAL_CLOSE_CODE, "finished");
    }

    if (this.signal?.aborted) {
      return { reason: "aborted" };
    }

    if (!this.follow) {
      return { reason: "caught_up" };
    }

    const gracefullyClosed =
      !sawTransportError && closeCode === NORMAL_CLOSE_CODE;

    if (gracefullyClosed) {
      return { reason: "graceful" };
    }

    return {
      reason: "dropped",
      closeCode,
      closeReason,
      emittedBatches,
    };
  }
}
