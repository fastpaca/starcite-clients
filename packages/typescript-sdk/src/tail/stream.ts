import { tokenFromAuthorizationHeader } from "../auth";
import { StarciteTailError } from "../errors";
import type {
  SessionTailOptions,
  StarciteWebSocket,
  StarciteWebSocketAuthTransport,
  StarciteWebSocketCloseEvent,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketMessageEvent,
  TailEvent,
  TailLifecycleEvent,
} from "../types";
import { parseTailFrame } from "./frame";

/**
 * Idle window used for replay-only tails (`follow=false`) before auto-close.
 */
const CATCH_UP_IDLE_MS = 1000;
const NORMAL_WEBSOCKET_CLOSE_CODE = 1000;
const DEFAULT_RECONNECT_MODE: TailReconnectMode = "exponential";
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 15_000;
const DEFAULT_RECONNECT_MULTIPLIER = 2;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_BUFFERED_BATCHES = 1024;

type TailReconnectMode = "fixed" | "exponential";
type TailReconnectTrigger = "connect_failed" | "dropped";
type TailErrorStage =
  | "connect"
  | "stream"
  | "retry_limit"
  | "consumer_backpressure";

/**
 * Construction input for a durable tail stream runner.
 */
interface TailStreamInput {
  sessionId: string;
  options: SessionTailOptions;
  websocketBaseUrl: string;
  websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;
  authorization?: string | null;
  websocketAuthTransport: Exclude<StarciteWebSocketAuthTransport, "auto">;
}

interface TailReconnectPolicy {
  mode: TailReconnectMode;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxAttempts: number;
}

/**
 * Resolved runtime options with defaults applied.
 */
interface TailRuntimeOptions {
  cursor: number;
  batchSize: number | undefined;
  agent: string | undefined;
  follow: boolean;
  reconnect: boolean;
  reconnectPolicy: TailReconnectPolicy;
  maxBufferedBatches: number;
  signal: AbortSignal | undefined;
  onLifecycleEvent: ((event: TailLifecycleEvent) => void) | undefined;
}

/**
 * Terminal state returned by one websocket connection attempt.
 */
type TailConnectionEnd =
  | { reason: "aborted" }
  | { reason: "caught_up" }
  | { reason: "graceful" }
  | {
    reason: "dropped";
    closeCode?: number;
    closeReason?: string;
    emittedBatches: number;
  };

/**
 * Stable error text extraction for tail transport failures.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

/**
 * Converts `actor` values to agent names for filter matching.
 */
function agentFromActor(actor: string): string | undefined {
  if (actor.startsWith("agent:")) {
    return actor.slice("agent:".length);
  }

  return undefined;
}

/**
 * Stateful tail runner that reconnects and resumes from the latest cursor.
 */
class TailStream {
  private readonly sessionId: string;
  private readonly websocketBaseUrl: string;
  private readonly websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;
  private readonly websocketConnectOptions:
    | StarciteWebSocketConnectOptions
    | undefined;
  private readonly websocketAuthTransport: Exclude<
    StarciteWebSocketAuthTransport,
    "auto"
  >;
  private readonly accessToken: string | undefined;
  private readonly options: TailRuntimeOptions;
  private cursor: number;
  private reconnectAttempts = 0;

  constructor(input: TailStreamInput) {
    this.sessionId = input.sessionId;
    this.websocketBaseUrl = input.websocketBaseUrl;
    this.websocketFactory = input.websocketFactory;
    this.websocketAuthTransport = input.websocketAuthTransport;
    this.accessToken = input.authorization
      ? tokenFromAuthorizationHeader(input.authorization)
      : undefined;
    this.websocketConnectOptions = this.toWebSocketConnectOptions(
      input.authorization,
      input.websocketAuthTransport
    );
    this.options = this.withDefaults(input.options);
    this.cursor = this.options.cursor;
  }

  async *run(): AsyncGenerator<TailEvent[]> {
    while (true) {
      if (this.options.signal?.aborted) {
        this.emitLifecycleEvent({
          type: "stream_ended",
          sessionId: this.sessionId,
          reason: "aborted",
        });
        return;
      }

      this.emitLifecycleEvent({
        type: "connect_attempt",
        sessionId: this.sessionId,
        attempt: this.reconnectAttempts + 1,
        cursor: this.cursor,
      });

      let socket: StarciteWebSocket;

      try {
        socket = this.websocketFactory(
          this.buildTailUrl(this.cursor, this.options.batchSize),
          this.websocketConnectOptions
        );
      } catch (error) {
        const reconnect = this.handleConnectFailure(errorMessage(error));
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
        this.emitLifecycleEvent({
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

  /**
   * Applies runtime defaults and normalizes reconnect policy settings.
   */
  private withDefaults(options: SessionTailOptions): TailRuntimeOptions {
    const follow = options.follow ?? true;
    const reconnectPolicy = options.reconnectPolicy;
    const mode: TailReconnectMode =
      reconnectPolicy?.mode === "fixed" ? "fixed" : DEFAULT_RECONNECT_MODE;
    const initialDelayMs =
      reconnectPolicy?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;

    return {
      cursor: options.cursor ?? 0,
      batchSize: options.batchSize,
      agent: options.agent?.trim(),
      follow,
      reconnect: follow ? (options.reconnect ?? true) : false,
      reconnectPolicy: {
        mode,
        initialDelayMs,
        maxDelayMs:
          reconnectPolicy?.maxDelayMs ??
          (mode === "fixed"
            ? initialDelayMs
            : Math.max(initialDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS)),
        multiplier: reconnectPolicy?.multiplier ?? DEFAULT_RECONNECT_MULTIPLIER,
        jitterRatio:
          reconnectPolicy?.jitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO,
        maxAttempts:
          reconnectPolicy?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS,
      },
      maxBufferedBatches:
        options.maxBufferedBatches ?? DEFAULT_MAX_BUFFERED_BATCHES,
      signal: options.signal,
      onLifecycleEvent: options.onLifecycleEvent,
    };
  }

  /**
   * Builds websocket upgrade headers for header-based auth transport.
   */
  private toWebSocketConnectOptions(
    authorization: string | null | undefined,
    transport: Exclude<StarciteWebSocketAuthTransport, "auto">
  ): StarciteWebSocketConnectOptions | undefined {
    if (!authorization || transport !== "header") {
      return undefined;
    }

    return {
      headers: {
        authorization,
      },
    };
  }

  /**
   * Builds the session tail endpoint with cursor, batching and auth query state.
   */
  private buildTailUrl(cursor: number, batchSize: number | undefined): string {
    const query = new URLSearchParams({
      cursor: `${cursor}`,
    });

    if (batchSize !== undefined) {
      query.set("batch_size", `${batchSize}`);
    }

    if (this.websocketAuthTransport === "access_token" && this.accessToken) {
      query.set("access_token", this.accessToken);
    }

    return `${this.websocketBaseUrl}/sessions/${encodeURIComponent(
      this.sessionId
    )}/tail?${query.toString()}`;
  }

  /**
   * Emits lifecycle callbacks and shields the stream from user callback errors.
   */
  private emitLifecycleEvent(event: TailLifecycleEvent): void {
    if (!this.options.onLifecycleEvent) {
      return;
    }

    try {
      this.options.onLifecycleEvent(event);
    } catch {
      return;
    }
  }

  private describeClose(
    code: number | undefined,
    reason: string | undefined
  ): string {
    const codeText = `code ${typeof code === "number" ? code : "unknown"}`;
    return reason ? `${codeText}, reason '${reason}'` : codeText;
  }

  private createTailError(options: {
    stage: TailErrorStage;
    attempts: number;
    message: string;
    closeCode?: number;
    closeReason?: string;
  }): StarciteTailError {
    return new StarciteTailError(options.message, {
      sessionId: this.sessionId,
      stage: options.stage,
      attempts: options.attempts,
      closeCode: options.closeCode,
      closeReason: options.closeReason,
    });
  }

  /**
   * Computes reconnect delay with optional exponential backoff + jitter.
   */
  private reconnectDelayForAttempt(attempt: number): number {
    const policy = this.options.reconnectPolicy;
    const exponent = Math.max(0, attempt - 1);
    const baseDelayMs =
      policy.mode === "fixed"
        ? policy.initialDelayMs
        : Math.min(
          policy.maxDelayMs,
          policy.initialDelayMs * policy.multiplier ** exponent
        );

    if (policy.jitterRatio === 0) {
      return baseDelayMs;
    }

    const spread = baseDelayMs * policy.jitterRatio;
    const min = Math.max(0, baseDelayMs - spread);
    const max = baseDelayMs + spread;
    return min + Math.random() * (max - min);
  }

  /**
   * Returns the next reconnect attempt or throws retry-limit failure.
   */
  private nextReconnectAttemptOrThrow(options: {
    trigger: TailReconnectTrigger;
    rootCause?: string;
    closeCode?: number;
    closeReason?: string;
    reconnectAttempts?: number;
  }): { attempt: number; delayMs: number } {
    const reconnectAttempts =
      options.reconnectAttempts ?? this.reconnectAttempts;
    const attempt = reconnectAttempts + 1;

    if (attempt > this.options.reconnectPolicy.maxAttempts) {
      if (options.trigger === "connect_failed") {
        throw this.createTailError({
          stage: "retry_limit",
          attempts: attempt,
          message: `Tail connection failed for session '${this.sessionId}' after ${this.options.reconnectPolicy.maxAttempts} reconnect attempt(s): ${options.rootCause ?? "Unknown error"}`,
        });
      }

      throw this.createTailError({
        stage: "retry_limit",
        attempts: attempt,
        closeCode: options.closeCode,
        closeReason: options.closeReason,
        message: `Tail connection dropped for session '${this.sessionId}' after ${this.options.reconnectPolicy.maxAttempts} reconnect attempt(s) (${this.describeClose(
          options.closeCode,
          options.closeReason
        )})`,
      });
    }

    const delayMs = this.reconnectDelayForAttempt(attempt);
    this.emitLifecycleEvent({
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

  /**
   * Handles failures before a websocket connection is established.
   */
  private handleConnectFailure(rootCause: string): {
    attempt: number;
    delayMs: number;
  } {
    if (!this.options.reconnect || this.options.signal?.aborted) {
      throw this.createTailError({
        stage: "connect",
        attempts: this.reconnectAttempts,
        message: `Tail connection failed for session '${this.sessionId}': ${rootCause}`,
      });
    }

    return this.nextReconnectAttemptOrThrow({
      trigger: "connect_failed",
      rootCause,
    });
  }

  /**
   * Handles abnormal stream closure and decides whether to reconnect.
   */
  private handleDroppedConnection(
    end: Extract<TailConnectionEnd, { reason: "dropped" }>
  ): {
    attempt: number;
    delayMs: number;
  } {
    if (end.closeCode === 4001 || end.closeReason === "token_expired") {
      throw this.createTailError({
        stage: "stream",
        attempts: this.reconnectAttempts,
        closeCode: end.closeCode,
        closeReason: end.closeReason,
        message: `Tail token expired for session '${this.sessionId}'. Re-issue a session token and reconnect from the last processed cursor.`,
      });
    }

    this.emitLifecycleEvent({
      type: "stream_dropped",
      sessionId: this.sessionId,
      attempt: this.reconnectAttempts + 1,
      closeCode: end.closeCode,
      closeReason: end.closeReason,
    });

    if (!this.options.reconnect) {
      throw this.createTailError({
        stage: "stream",
        attempts: this.reconnectAttempts,
        closeCode: end.closeCode,
        closeReason: end.closeReason,
        message: `Tail connection dropped for session '${this.sessionId}' (${this.describeClose(
          end.closeCode,
          end.closeReason
        )})`,
      });
    }

    const reconnectAttempts =
      end.emittedBatches > 0 ? 0 : this.reconnectAttempts;
    return this.nextReconnectAttemptOrThrow({
      trigger: "dropped",
      closeCode: end.closeCode,
      closeReason: end.closeReason,
      reconnectAttempts,
    });
  }

  /**
   * Waits for reconnect delay while allowing abort to cut waits short.
   */
  private async waitForDelay(ms: number): Promise<void> {
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
        this.options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };

      if (this.options.signal) {
        if (this.options.signal.aborted) {
          onAbort();
          return;
        }

        this.options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private closeSocket(
    socket: StarciteWebSocket,
    code: number,
    reason: string
  ): void {
    try {
      socket.close(code, reason);
    } catch {
      return;
    }
  }

  /**
   * Streams batches from a single websocket connection lifecycle.
   */
  private async *streamSingleConnection(
    socket: StarciteWebSocket
  ): AsyncGenerator<TailEvent[], TailConnectionEnd> {
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
    let abortRequested = false;
    let emittedBatches = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCatchUpTimer = (): void => {
      if (!catchUpTimer) {
        return;
      }

      clearTimeout(catchUpTimer);
      catchUpTimer = undefined;
    };

    const scheduleCatchUpClose = (): void => {
      if (this.options.follow) {
        return;
      }

      // In replay-only mode, close once no new frames arrive for a short idle window.
      clearCatchUpTimer();
      catchUpTimer = setTimeout(() => {
        closeBatches();
      }, CATCH_UP_IDLE_MS);
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

      if (bufferedBatches.length >= this.options.maxBufferedBatches) {
        failBatches(
          this.createTailError({
            stage: "consumer_backpressure",
            attempts: this.reconnectAttempts,
            message: `Tail consumer for session '${this.sessionId}' fell behind after buffering ${this.options.maxBufferedBatches} batch(es)`,
          })
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

      if (!pendingResolve) {
        return;
      }

      const resolve = pendingResolve;
      pendingResolve = undefined;
      pendingReject = undefined;
      resolve({ done: true, value: undefined });
    };

    const failBatches = (error: unknown): void => {
      if (streamClosed || streamError !== undefined) {
        return;
      }

      streamError = error;

      if (!pendingReject) {
        return;
      }

      const reject = pendingReject;
      pendingResolve = undefined;
      pendingReject = undefined;
      reject(error);
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
            this.options.agent &&
            agentFromActor(parsedEvent.actor) !== this.options.agent
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
      abortRequested = true;
      clearCatchUpTimer();
      closeBatches();
      this.closeSocket(socket, NORMAL_WEBSOCKET_CLOSE_CODE, "aborted");
    };

    const onOpen = (): void => {
      scheduleCatchUpClose();
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    if (this.options.signal) {
      if (this.options.signal.aborted) {
        onAbort();
      } else {
        this.options.signal.addEventListener("abort", onAbort, { once: true });
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

      if (this.options.signal) {
        this.options.signal.removeEventListener("abort", onAbort);
      }

      this.closeSocket(socket, NORMAL_WEBSOCKET_CLOSE_CODE, "finished");
    }

    if (abortRequested || this.options.signal?.aborted) {
      return { reason: "aborted" };
    }

    if (!this.options.follow) {
      return { reason: "caught_up" };
    }

    const gracefullyClosed =
      !sawTransportError && closeCode === NORMAL_WEBSOCKET_CLOSE_CODE;

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

/**
 * Opens a durable websocket tail stream and yields raw frame-sized batches.
 */
export async function* streamTailRawEventBatches(
  input: TailStreamInput
): AsyncGenerator<TailEvent[]> {
  yield* new TailStream(input).run();
}
