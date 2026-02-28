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

interface ManagedWebSocketEvents {
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
  url: () => string | Promise<string>;
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

type AttemptPreparationResult =
  | { kind: "ready"; attempt: number; socket: StarciteWebSocket }
  | { kind: "continue" }
  | { kind: "break" };

/**
 * Managed websocket loop with reconnect + timeout controls.
 *
 * This powers `TailStream` so transport behavior is centralized in one place.
 */
export class ManagedWebSocket {
  private readonly options: ManagedWebSocketOptions;
  private readonly events = new EventEmitter<ManagedWebSocketEvents>();
  private socket: StarciteWebSocket | undefined;
  private forceCloseSocket:
    | ((code: number, reason: string, aborted?: boolean) => void)
    | undefined;
  private started = false;
  private closed = false;
  private reconnectAttempts = 0;
  private readonly donePromise: Promise<void>;
  private resolveDone: (() => void) | undefined;

  constructor(options: ManagedWebSocketOptions) {
    this.options = options;
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  onConnectAttempt(listener: (event: { attempt: number }) => void): () => void {
    this.events.on("connect_attempt", listener);
    return () => {
      this.events.off("connect_attempt", listener);
    };
  }

  onConnectFailed(
    listener: (event: { attempt: number; rootCause: string }) => void
  ): () => void {
    this.events.on("connect_failed", listener);
    return () => {
      this.events.off("connect_failed", listener);
    };
  }

  onReconnectScheduled(
    listener: (event: {
      attempt: number;
      delayMs: number;
      trigger: ConnectTrigger;
      closeCode?: number;
      closeReason?: string;
      rootCause?: string;
    }) => void
  ): () => void {
    this.events.on("reconnect_scheduled", listener);
    return () => {
      this.events.off("reconnect_scheduled", listener);
    };
  }

  onDropped(
    listener: (event: {
      attempt: number;
      closeCode?: number;
      closeReason?: string;
    }) => void
  ): () => void {
    this.events.on("dropped", listener);
    return () => {
      this.events.off("dropped", listener);
    };
  }

  onRetryLimit(
    listener: (event: {
      attempt: number;
      trigger: ConnectTrigger;
      closeCode?: number;
      closeReason?: string;
      rootCause?: string;
    }) => void
  ): () => void {
    this.events.on("retry_limit", listener);
    return () => {
      this.events.off("retry_limit", listener);
    };
  }

  onOpen(listener: () => void): () => void {
    this.events.on("open", listener);
    return () => {
      this.events.off("open", listener);
    };
  }

  onMessage(listener: (data: unknown) => void): () => void {
    this.events.on("message", listener);
    return () => {
      this.events.off("message", listener);
    };
  }

  onFatal(listener: (error: unknown) => void): () => void {
    this.events.on("fatal", listener);
    return () => {
      this.events.off("fatal", listener);
    };
  }

  onClosed(
    listener: (event: {
      closeCode?: number;
      closeReason?: string;
      aborted: boolean;
      graceful: boolean;
    }) => void
  ): () => void {
    this.events.on("closed", listener);
    return () => {
      this.events.off("closed", listener);
    };
  }

  close(code = NORMAL_CLOSE_CODE, reason = "closed"): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
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
    this.reconnectAttempts = 0;
  }

  waitForClose(): Promise<void> {
    this.start();
    return this.donePromise;
  }

  private start(): void {
    if (this.started || this.resolveDone === undefined) {
      return;
    }

    this.started = true;
    this.run().catch((error) => {
      this.emitOrFatal("fatal", error);
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

    while (!this.closed) {
      const maybePrepared = this.prepareAttempt(finalState);
      const prepared =
        maybePrepared instanceof Promise ? await maybePrepared : maybePrepared;
      if (prepared.kind === "continue") {
        continue;
      }
      if (prepared.kind === "break") {
        break;
      }

      const result = await this.runSocket(prepared.socket);
      const shouldContinue = await this.handleSocketResult(
        prepared.attempt,
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

  private prepareAttempt(
    finalState: FinalState
  ): AttemptPreparationResult | Promise<AttemptPreparationResult> {
    if (this.options.signal?.aborted) {
      this.closed = true;
      finalState.aborted = true;
      return { kind: "break" };
    }

    const attempt = this.reconnectAttempts + 1;
    if (!this.beginAttempt(attempt)) {
      return { kind: "break" };
    }

    const maybeUrlResult = this.resolveUrlForAttempt(attempt);
    if (maybeUrlResult instanceof Promise) {
      return maybeUrlResult.then((urlResult) =>
        this.prepareSocketForAttempt(attempt, urlResult)
      );
    }

    return this.prepareSocketForAttempt(attempt, maybeUrlResult);
  }

  private prepareSocketForAttempt(
    attempt: number,
    urlResult: { kind: "ready"; url: string } | { kind: "continue" | "break" }
  ): AttemptPreparationResult | Promise<AttemptPreparationResult> {
    if (urlResult.kind !== "ready") {
      return urlResult;
    }

    if (this.closed) {
      return { kind: "break" };
    }

    const maybeSocketResult = this.createSocketForAttempt(
      attempt,
      urlResult.url
    );
    if (maybeSocketResult instanceof Promise) {
      return maybeSocketResult.then((socketResult) =>
        this.finalizeAttemptPreparation(socketResult)
      );
    }

    return this.finalizeAttemptPreparation(maybeSocketResult);
  }

  private finalizeAttemptPreparation(
    prepared: AttemptPreparationResult
  ): AttemptPreparationResult {
    if (prepared.kind !== "ready") {
      return prepared;
    }

    if (this.closed) {
      closeQuietly(prepared.socket, NORMAL_CLOSE_CODE, "closed");
      return { kind: "break" };
    }

    return prepared;
  }

  private beginAttempt(attempt: number): boolean {
    if (!this.emitOrFatal("connect_attempt", { attempt })) {
      this.closed = true;
      return false;
    }

    return !this.closed;
  }

  private resolveUrlForAttempt(
    attempt: number
  ):
    | { kind: "ready"; url: string }
    | Promise<{ kind: "ready"; url: string } | { kind: "continue" | "break" }> {
    try {
      const providedUrl = this.options.url();
      if (providedUrl instanceof Promise) {
        return providedUrl
          .then((url) => ({ kind: "ready", url }) as const)
          .catch((error) => this.handleConnectFailure(attempt, error));
      }

      return { kind: "ready", url: providedUrl };
    } catch (error) {
      return this.handleConnectFailure(attempt, error);
    }
  }

  private createSocketForAttempt(
    attempt: number,
    url: string
  ): AttemptPreparationResult | Promise<AttemptPreparationResult> {
    try {
      const socket = this.options.websocketFactory(
        url,
        this.options.connectOptions
      );
      return { kind: "ready", attempt, socket };
    } catch (error) {
      return this.handleConnectFailure(attempt, error);
    }
  }

  private async handleConnectFailure(
    attempt: number,
    error: unknown
  ): Promise<{ kind: "continue" | "break" }> {
    const rootCause = toErrorMessage(error);
    if (!this.emitOrFatal("connect_failed", { attempt, rootCause })) {
      this.closed = true;
      return { kind: "break" };
    }

    const shouldContinue = await this.scheduleReconnect({
      attempt,
      trigger: "connect_failed",
      rootCause,
    });
    return { kind: shouldContinue ? "continue" : "break" };
  }

  private async handleSocketResult(
    attempt: number,
    result: SocketRunResult,
    finalState: FinalState
  ): Promise<boolean> {
    finalState.closeCode = result.closeCode;
    finalState.closeReason = result.closeReason;
    finalState.aborted =
      result.aborted || (this.options.signal?.aborted ?? false);
    finalState.graceful =
      !result.sawTransportError && result.closeCode === NORMAL_CLOSE_CODE;

    if (result.listenerError !== undefined) {
      this.emitOrFatal("fatal", result.listenerError);
      this.closed = true;
      return false;
    }

    if (this.closed || finalState.aborted || finalState.graceful) {
      return false;
    }

    if (
      !this.emitOrFatal("dropped", {
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
    if (
      !this.options.shouldReconnect ||
      this.closed ||
      this.options.signal?.aborted
    ) {
      this.closed = true;
      return false;
    }

    if (input.attempt > this.options.reconnectPolicy.maxAttempts) {
      this.emitOrFatal("retry_limit", {
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
      !this.emitOrFatal("reconnect_scheduled", {
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
    await waitForDelay(delayMs, this.options.signal);
    return !(this.closed || (this.options.signal?.aborted ?? false));
  }

  private runSocket(socket: StarciteWebSocket): Promise<SocketRunResult> {
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
        if (!this.emitOrFatal("open", undefined)) {
          listenerError = new Error("Managed websocket open listener failed");
          closeAndSettle(NORMAL_CLOSE_CODE, "listener failed");
        }
      };

      const onMessage = (event: StarciteWebSocketMessageEvent): void => {
        armInactivityTimeout();
        if (!this.emitOrFatal("message", event.data)) {
          listenerError = new Error(
            "Managed websocket message listener failed"
          );
          closeAndSettle(NORMAL_CLOSE_CODE, "listener failed");
        }
      };

      const onError = (_event: StarciteWebSocketEventMap["error"]): void => {
        sawTransportError = true;
      };

      const onClose = (event: StarciteWebSocketCloseEvent): void => {
        closeCode = event.code;
        closeReason = event.reason;
        settle();
      };

      const onAbort = (): void => {
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

  private emitOrFatal(
    eventName: keyof ManagedWebSocketEvents,
    payload?: unknown
  ): boolean {
    const emitter = this.events as unknown as EventEmitter<
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

    this.events.emit("closed", event);
    this.events.removeAllListeners();
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
): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
