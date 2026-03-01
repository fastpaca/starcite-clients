import EventEmitter from "eventemitter3";
import type {
  StarciteWebSocket,
  StarciteWebSocketCloseEvent,
  StarciteWebSocketConnectOptions,
  StarciteWebSocketEventMap,
  StarciteWebSocketFactory,
  StarciteWebSocketMessageEvent,
} from "../types";

const NORMAL_CLOSE_CODE = 1000;
const INACTIVITY_CLOSE_CODE = 4000;
const CONNECTION_TIMEOUT_CLOSE_CODE = 4100;

type ConnectTrigger = "connect_failed" | "dropped";

interface ReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxAttempts: number;
}

export interface ManagedWebSocketEvents {
  connect_attempt: (event: { attempt: number }) => void;
  connect_failed: (event: { attempt: number; rootCause: string }) => void;
  reconnect_scheduled: (event: {
    attempt: number;
    delayMs: number;
    trigger: ConnectTrigger;
    closeCode?: number;
    closeReason?: string;
    rootCause?: string;
  }) => void;
  dropped: (event: {
    attempt: number;
    closeCode?: number;
    closeReason?: string;
  }) => void;
  retry_limit: (event: {
    attempt: number;
    trigger: ConnectTrigger;
    closeCode?: number;
    closeReason?: string;
    rootCause?: string;
  }) => void;
  open: () => void;
  message: (data: unknown) => void;
  fatal: (error: unknown) => void;
  closed: (event: {
    closeCode?: number;
    closeReason?: string;
    aborted: boolean;
    graceful: boolean;
  }) => void;
}

export interface ManagedWebSocketOptions {
  // Re-evaluated for each connect attempt so reconnects use the latest cursor
  // held by `TailStream`, without `TailStream` managing reconnect internals.
  url: () => string;
  websocketFactory: StarciteWebSocketFactory;
  connectOptions?: StarciteWebSocketConnectOptions;
  signal?: AbortSignal;
  shouldReconnect: boolean;
  reconnectPolicy: ReconnectPolicy;
  connectionTimeoutMs: number;
  inactivityTimeoutMs?: number;
}

interface SocketRunResult {
  closeCode?: number;
  closeReason?: string;
  sawTransportError: boolean;
  aborted: boolean;
  listenerError?: unknown;
}

interface FinalState {
  closeCode?: number;
  closeReason?: string;
  aborted: boolean;
  graceful: boolean;
}

/**
 * Managed websocket loop with reconnect + timeout controls.
 *
 * `waitForClose()` returns one shared completion promise for all callers.
 * Connect/drop/retry decisions are emitted as lifecycle events.
 * Listener exceptions are treated as fatal (fail-fast over silent corruption).
 *
 * This powers `TailStream` so transport behavior is centralized in one place.
 */
export class ManagedWebSocket extends EventEmitter<ManagedWebSocketEvents> {
  private readonly options: ManagedWebSocketOptions;
  private socket: StarciteWebSocket | undefined;
  private cancelReconnectWait: (() => void) | undefined;
  // Set while a socket run is active so `close()` can synchronously settle it.
  private forceCloseSocket:
    | ((code: number, reason: string, aborted?: boolean) => void)
    | undefined;
  private started = false;
  private closed = false;
  // Tracks reconnect attempts for backoff and retry-limit accounting.
  private reconnectAttempts = 0;
  // Shared deferred completion for all callers of waitForClose(), even late ones.
  private readonly donePromise: Promise<void>;
  // Set to `undefined` after resolution so finish() remains idempotent.
  private resolveDone: (() => void) | undefined;

  constructor(options: ManagedWebSocketOptions) {
    super();
    this.options = options;
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  close(code = NORMAL_CLOSE_CODE, reason = "closed"): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.cancelReconnectWait?.();
    this.cancelReconnectWait = undefined;

    if (!this.started) {
      this.finish({
        closeCode: code,
        closeReason: reason,
        aborted: this.options.signal?.aborted ?? false,
        graceful: code === NORMAL_CLOSE_CODE,
      });
      return;
    }

    if (this.forceCloseSocket) {
      this.forceCloseSocket(code, reason);
      return;
    }
    this.socket?.close(code, reason);
  }

  resetReconnectAttempts(): void {
    // Called by `TailStream` once useful data has been consumed.
    this.reconnectAttempts = 0;
  }

  waitForClose(): Promise<void> {
    // Construction is side-effect free; transport starts when someone awaits closure.
    this.start();
    return this.donePromise;
  }

  private start(): void {
    if (this.started || this.resolveDone === undefined) {
      return;
    }

    this.started = true;
    this.run().catch((error) => {
      this.emitSafe("fatal", error);
      this.finish({
        closeCode: undefined,
        closeReason: "run failed",
        aborted: this.options.signal?.aborted ?? false,
        graceful: false,
      });
    });
  }

  private async run(): Promise<void> {
    const finalState: FinalState = {
      closeCode: undefined,
      closeReason: undefined,
      aborted: this.options.signal?.aborted ?? false,
      graceful: false,
    };

    // Keep running attempts until a terminal condition wins:
    // graceful close, abort/explicit close, retry limit, or fatal listener error.
    while (!this.closed) {
      if (this.options.signal?.aborted) {
        this.closed = true;
        finalState.aborted = true;
        break;
      }

      const attempt = this.reconnectAttempts + 1;
      // Lifecycle listeners can intentionally stop the run by throwing.
      if (!this.emitSafe("connect_attempt", { attempt })) {
        this.closed = true;
        break;
      }
      if (this.closed) {
        break;
      }

      let socket: StarciteWebSocket;
      try {
        // Resolve URL per attempt so reconnect uses latest producer cursor state.
        const url = this.options.url();
        socket = this.options.websocketFactory(
          url,
          this.options.connectOptions
        );
      } catch (error) {
        // Connect failures use the same retry policy path as dropped sockets.
        const shouldContinue = await this.handleConnectFailure(attempt, error);
        if (shouldContinue) {
          continue;
        }
        break;
      }

      if (this.closed) {
        // Close was requested between socket creation and run loop registration.
        closeQuietly(socket, NORMAL_CLOSE_CODE, "closed");
        break;
      }

      const result = await this.runSocket(socket);
      const shouldContinue = await this.handleSocketResult(
        attempt,
        result,
        finalState
      );
      if (shouldContinue) {
        continue;
      }

      break;
    }

    this.finish(finalState);
  }

  private async handleConnectFailure(
    attempt: number,
    error: unknown
  ): Promise<boolean> {
    const rootCause = toErrorMessage(error);
    if (!this.emitSafe("connect_failed", { attempt, rootCause })) {
      this.closed = true;
      return false;
    }

    return await this.scheduleReconnect({
      attempt,
      trigger: "connect_failed",
      rootCause,
    });
  }

  private async handleSocketResult(
    attempt: number,
    result: SocketRunResult,
    finalState: FinalState
  ): Promise<boolean> {
    // Preserve terminal metadata so `TailStream` can classify why the stream ended.
    finalState.closeCode = result.closeCode;
    finalState.closeReason = result.closeReason;
    finalState.aborted =
      result.aborted || (this.options.signal?.aborted ?? false);
    finalState.graceful =
      !result.sawTransportError && result.closeCode === NORMAL_CLOSE_CODE;

    if (result.listenerError !== undefined) {
      // Listener failures are fatal to avoid continuing with inconsistent consumer state.
      this.emitSafe("fatal", result.listenerError);
      this.closed = true;
      return false;
    }

    if (this.closed || finalState.aborted || finalState.graceful) {
      return false;
    }

    if (
      !this.emitSafe("dropped", {
        attempt,
        closeCode: result.closeCode,
        closeReason: result.closeReason,
      })
    ) {
      this.closed = true;
      return false;
    }

    return await this.scheduleReconnect({
      attempt,
      trigger: "dropped",
      closeCode: result.closeCode,
      closeReason: result.closeReason,
    });
  }

  private async scheduleReconnect(input: {
    attempt: number;
    trigger: ConnectTrigger;
    closeCode?: number;
    closeReason?: string;
    rootCause?: string;
  }): Promise<boolean> {
    // Single policy gate for retries so connect and dropped failures behave identically.
    if (
      !this.options.shouldReconnect ||
      this.closed ||
      this.options.signal?.aborted
    ) {
      this.closed = true;
      return false;
    }

    if (input.attempt > this.options.reconnectPolicy.maxAttempts) {
      this.emitSafe("retry_limit", {
        attempt: input.attempt,
        trigger: input.trigger,
        closeCode: input.closeCode,
        closeReason: input.closeReason,
        rootCause: input.rootCause,
      });
      this.closed = true;
      return false;
    }

    const delayMs = reconnectDelayForAttempt(
      input.attempt,
      this.options.reconnectPolicy
    );
    if (
      !this.emitSafe("reconnect_scheduled", {
        attempt: input.attempt,
        delayMs,
        trigger: input.trigger,
        closeCode: input.closeCode,
        closeReason: input.closeReason,
        rootCause: input.rootCause,
      })
    ) {
      this.closed = true;
      return false;
    }

    this.reconnectAttempts = input.attempt;
    const reconnectWait = waitForDelay(delayMs, this.options.signal);
    this.cancelReconnectWait = reconnectWait.cancel;
    await reconnectWait.promise;
    if (this.cancelReconnectWait === reconnectWait.cancel) {
      this.cancelReconnectWait = undefined;
    }

    return !(this.closed || (this.options.signal?.aborted ?? false));
  }

  private runSocket(socket: StarciteWebSocket): Promise<SocketRunResult> {
    // Owns one socket lifetime and resolves to a classified outcome.
    return new Promise((resolve) => {
      this.socket = socket;
      let settled = false;
      let socketOpen = false;
      let sawTransportError = false;
      let aborted = false;
      let listenerError: unknown;
      let closeCode: number | undefined;
      let closeReason: string | undefined;

      let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = undefined;
        }
        if (inactivityTimeout) {
          clearTimeout(inactivityTimeout);
          inactivityTimeout = undefined;
        }
      };

      const armConnectionTimeout = (): void => {
        clearTimeout(connectionTimeout);
        if (this.options.connectionTimeoutMs <= 0) {
          return;
        }
        connectionTimeout = setTimeout(() => {
          if (settled || socketOpen || this.closed) {
            return;
          }
          closeAndSettle(CONNECTION_TIMEOUT_CLOSE_CODE, "connection timeout");
        }, this.options.connectionTimeoutMs);
      };

      const armInactivityTimeout = (): void => {
        clearTimeout(inactivityTimeout);
        const timeoutMs = this.options.inactivityTimeoutMs;
        if (!timeoutMs || timeoutMs <= 0 || this.closed) {
          return;
        }
        inactivityTimeout = setTimeout(() => {
          if (settled || this.closed) {
            return;
          }
          closeAndSettle(INACTIVITY_CLOSE_CODE, "inactivity timeout");
        }, timeoutMs);
      };

      const closeAndSettle = (
        code: number,
        reason: string,
        markAborted = false
      ): void => {
        if (settled) {
          return;
        }

        aborted = aborted || markAborted;
        closeCode = code;
        closeReason = reason;
        try {
          socket.close(code, reason);
        } catch {
          // Ignore close transport errors and settle locally.
        }
        settle();
      };

      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        this.options.signal?.removeEventListener("abort", onAbort);

        if (this.socket === socket) {
          this.socket = undefined;
        }
        this.forceCloseSocket = undefined;

        resolve({
          closeCode,
          closeReason,
          sawTransportError,
          aborted,
          listenerError,
        });
      };

      const onOpen = (): void => {
        socketOpen = true;
        clearTimeout(connectionTimeout);
        armInactivityTimeout();
        if (!this.emitSafe("open")) {
          listenerError = new Error("Managed websocket open listener failed");
          closeAndSettle(NORMAL_CLOSE_CODE, "listener failed");
        }
      };

      const onMessage = (event: StarciteWebSocketMessageEvent): void => {
        armInactivityTimeout();
        if (!this.emitSafe("message", event.data)) {
          listenerError = new Error(
            "Managed websocket message listener failed"
          );
          closeAndSettle(NORMAL_CLOSE_CODE, "listener failed");
        }
      };

      const onError = (_event: StarciteWebSocketEventMap["error"]): void => {
        // Browsers may dispatch `error` before `close`; mark transport as non-graceful.
        sawTransportError = true;
      };

      const onClose = (event: StarciteWebSocketCloseEvent): void => {
        closeCode = event.code;
        closeReason = event.reason;
        settle();
      };

      const onAbort = (): void => {
        // Abort is treated as local shutdown and ends reconnect attempts immediately.
        this.closed = true;
        closeAndSettle(NORMAL_CLOSE_CODE, "aborted", true);
      };

      this.forceCloseSocket = (code, reason, markAborted) => {
        closeAndSettle(code, reason, markAborted ?? false);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      armConnectionTimeout();
    });
  }

  private emitSafe(
    eventName: keyof ManagedWebSocketEvents,
    payload?: unknown
  ): boolean {
    // Keep this cast local: EventEmitter3's generic typing does not model
    // dynamic keyed payload tuples well for this usage.
    const emitter = this as unknown as EventEmitter<
      Record<string, (...args: unknown[]) => void>
    >;

    try {
      if (payload === undefined) {
        emitter.emit(eventName);
      } else {
        emitter.emit(eventName, payload);
      }
      return true;
    } catch (error) {
      if (eventName !== "fatal") {
        emitter.emit("fatal", error);
      }
      return false;
    }
  }

  private finish(event: {
    closeCode?: number;
    closeReason?: string;
    aborted: boolean;
    graceful: boolean;
  }): void {
    if (this.resolveDone === undefined) {
      return;
    }

    // Emit final state before cleanup so `TailStream` can observe close reason.
    this.emit("closed", event);
    this.removeAllListeners();
    const resolve = this.resolveDone;
    this.resolveDone = undefined;
    resolve();
  }
}

function reconnectDelayForAttempt(
  attempt: number,
  policy: ReconnectPolicy
): number {
  const exponent = Math.max(0, attempt - 1);
  const baseDelay = policy.initialDelayMs * policy.multiplier ** exponent;
  const clamped = Math.min(policy.maxDelayMs, baseDelay);

  if (policy.jitterRatio <= 0) {
    return clamped;
  }

  const spread = clamped * policy.jitterRatio;
  const min = Math.max(0, clamped - spread);
  const max = clamped + spread;
  return min + Math.random() * (max - min);
}

function waitForDelay(
  ms: number,
  signal: AbortSignal | undefined
): { promise: Promise<void>; cancel: () => void } {
  if (ms <= 0 || signal?.aborted) {
    return {
      promise: Promise.resolve(),
      cancel: () => undefined,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolvePromise: (() => void) | undefined;

  const onAbort = (): void => {
    finish();
  };

  const finish = (): void => {
    if (settled) {
      return;
    }

    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    signal?.removeEventListener("abort", onAbort);
    resolvePromise?.();
    resolvePromise = undefined;
  };

  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;

    // Reconnect backoff is abortable so shutdown does not wait out timers.
    timer = setTimeout(() => {
      finish();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    promise,
    cancel: finish,
  };
}

function closeQuietly(
  socket: StarciteWebSocket,
  code: number,
  reason: string
): void {
  try {
    socket.close(code, reason);
  } catch {
    // Ignore close transport errors during shutdown.
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
