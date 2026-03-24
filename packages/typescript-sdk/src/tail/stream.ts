import {
  StarciteBackpressureError,
  StarciteError,
  StarciteRetryLimitError,
  StarciteTailError,
  StarciteTailGapError,
  StarciteTokenExpiredError,
} from "../errors";
import { agentFromActor } from "../identity";
import type {
  SessionTailOptions,
  TailCursor,
  TailEvent,
  TailGap,
  TailLifecycleEvent,
  TailTokenExpiredPayload,
} from "../types";
import type {
  TailSocketAuthContext,
  TailSocketManager,
  TailSocketReconnectPolicy,
} from "./socket-manager";

function describeClose(closeCode?: number, closeReason?: string): string {
  if (closeCode === undefined && !closeReason) {
    return "unknown close";
  }

  if (closeCode === undefined) {
    return closeReason ?? "unknown close";
  }

  return closeReason
    ? `code ${closeCode}: ${closeReason}`
    : `code ${closeCode}`;
}

/**
 * Phoenix-backed tail runner that preserves the existing callback/iterator API.
 */
export class TailStream {
  private readonly customWebSocketFactoryProvided: boolean;
  private readonly sessionId: string;
  private readonly socketAuth: TailSocketAuthContext;
  private readonly socketManager: TailSocketManager;
  private readonly socketUrl: string;

  private readonly agent: string | undefined;
  private readonly batchSize: number | undefined;
  private readonly catchUpIdleMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly follow: boolean;
  private readonly inactivityTimeoutMs: number | undefined;
  private readonly maxBufferedBatches: number;
  private readonly onGap: ((gap: TailGap) => void) | undefined;
  private readonly onLifecycleEvent:
    | ((event: TailLifecycleEvent) => void)
    | undefined;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectPolicy: TailSocketReconnectPolicy;
  private readonly shouldReconnect: boolean;
  private readonly signal: AbortSignal | undefined;

  private cursor: TailCursor;

  constructor(input: {
    customWebSocketFactoryProvided: boolean;
    options: SessionTailOptions;
    sessionId: string;
    socketAuth: TailSocketAuthContext;
    socketManager: TailSocketManager;
    socketUrl: string;
  }) {
    const opts = input.options;
    const reconnectPolicy = opts.reconnectPolicy;
    const reconnectMode =
      reconnectPolicy?.mode === "fixed" ? "fixed" : "exponential";
    const initialReconnectDelayMs = reconnectPolicy?.initialDelayMs ?? 500;

    this.customWebSocketFactoryProvided = input.customWebSocketFactoryProvided;
    this.sessionId = input.sessionId;
    this.socketAuth = input.socketAuth;
    this.socketManager = input.socketManager;
    this.socketUrl = input.socketUrl;

    this.agent = opts.agent;
    this.batchSize = opts.batchSize;
    this.catchUpIdleMs = opts.catchUpIdleMs ?? 1000;
    this.connectionTimeoutMs = opts.connectionTimeoutMs ?? 12_000;
    this.cursor = opts.cursor ?? 0;
    this.follow = opts.follow ?? true;
    this.inactivityTimeoutMs = opts.inactivityTimeoutMs;
    this.maxBufferedBatches = opts.maxBufferedBatches ?? 1024;
    this.onGap = opts.onGap;
    this.onLifecycleEvent = opts.onLifecycleEvent;
    this.maxReconnectAttempts =
      reconnectPolicy?.maxAttempts ?? Number.POSITIVE_INFINITY;
    this.reconnectPolicy = {
      initialDelayMs: initialReconnectDelayMs,
      jitterRatio: reconnectPolicy?.jitterRatio ?? 0.2,
      maxDelayMs:
        reconnectPolicy?.maxDelayMs ??
        (reconnectMode === "fixed"
          ? initialReconnectDelayMs
          : Math.max(initialReconnectDelayMs, 15_000)),
      mode: reconnectMode,
      multiplier:
        reconnectMode === "fixed" ? 1 : (reconnectPolicy?.multiplier ?? 2),
    };
    this.shouldReconnect = this.follow ? (opts.reconnect ?? true) : false;
    this.signal = opts.signal;
  }

  async subscribe(
    onBatch: (batch: TailEvent[]) => void | Promise<void>
  ): Promise<void> {
    if (this.customWebSocketFactoryProvided) {
      throw new StarciteError(
        "StarciteOptions.websocketFactory is not supported by the Phoenix Channels tail transport."
      );
    }

    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    let dispatchChain = Promise.resolve();
    let doneResolve: (() => void) | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let lastConnectFailureReason: string | undefined;
    let queuedBatches = 0;
    let streamError: unknown;
    let streamReason: "aborted" | "caught_up" | "graceful" = this.follow
      ? "graceful"
      : "caught_up";
    let unsubscribe: (() => void) | undefined;
    let finished = false;
    const abortListener = () => {
      streamReason = "aborted";
      finish();
    };

    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const finish = (): void => {
      if (finished) {
        return;
      }

      finished = true;
      unsubscribe?.();
      unsubscribe = undefined;

      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }

      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }

      doneResolve?.();
    };

    const fail = (error: unknown): void => {
      if (streamError !== undefined) {
        return;
      }

      streamError = error;
      finish();
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

    const scheduleCatchUpClose = (): void => {
      if (this.follow) {
        return;
      }

      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }

      catchUpTimer = setTimeout(() => {
        streamReason = "caught_up";
        finish();
      }, this.catchUpIdleMs);
    };

    const resetInactivityTimer = (): void => {
      if (!(this.inactivityTimeoutMs && this.inactivityTimeoutMs > 0)) {
        return;
      }

      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }

      inactivityTimer = setTimeout(() => {
        fail(
          new StarciteTailError(
            `Tail connection dropped for session '${this.sessionId}' (${describeClose(4000, "inactivity timeout")})`,
            {
              closeCode: 4000,
              closeReason: "inactivity timeout",
              sessionId: this.sessionId,
              stage: "stream",
            }
          )
        );
      }, this.inactivityTimeoutMs);
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
            { sessionId: this.sessionId }
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

    const handleGap = (gap: TailGap): void => {
      if (!this.onGap) {
        fail(
          new StarciteTailGapError(
            `Tail gap reported for session '${this.sessionId}'`,
            {
              sessionId: this.sessionId,
            }
          )
        );
        return;
      }

      try {
        this.onGap(gap);
      } catch (error) {
        fail(error);
      }
    };

    const handleConnectFailure = (rootCause: string, attempt: number): void => {
      lastConnectFailureReason = rootCause;
      if (this.shouldReconnect) {
        return;
      }

      fail(
        new StarciteTailError(
          `Tail connection failed for session '${this.sessionId}': ${rootCause}`,
          {
            attempts: Math.max(0, attempt - 1),
            sessionId: this.sessionId,
            stage: "connect",
          }
        )
      );
    };

    const handleReconnectScheduled = (event: {
      attempt: number;
      closeCode?: number;
      closeReason?: string;
      delayMs: number;
      trigger: "connect_failed" | "dropped";
    }): void => {
      if (event.attempt > this.maxReconnectAttempts) {
        const message =
          event.trigger === "connect_failed"
            ? `Tail connection failed for session '${this.sessionId}' after ${this.maxReconnectAttempts} reconnect attempt(s): ${lastConnectFailureReason ?? "Unknown error"}`
            : `Tail connection dropped for session '${this.sessionId}' after ${this.maxReconnectAttempts} reconnect attempt(s) (${describeClose(event.closeCode, event.closeReason)})`;
        fail(
          new StarciteRetryLimitError(message, {
            attempts: event.attempt,
            closeCode: event.closeCode,
            closeReason: event.closeReason,
            sessionId: this.sessionId,
          })
        );
        return;
      }

      emitLifecycle({
        attempt: event.attempt,
        closeCode: event.closeCode,
        closeReason: event.closeReason,
        delayMs: event.delayMs,
        sessionId: this.sessionId,
        trigger: event.trigger,
        type: "reconnect_scheduled",
      });
    };

    const handleDropped = (event: {
      attempt: number;
      closeCode?: number;
      closeReason?: string;
    }): void => {
      emitLifecycle({
        attempt: event.attempt,
        closeCode: event.closeCode,
        closeReason: event.closeReason,
        sessionId: this.sessionId,
        type: "stream_dropped",
      });

      if (this.shouldReconnect) {
        return;
      }

      fail(
        new StarciteTailError(
          `Tail connection dropped for session '${this.sessionId}' (${describeClose(event.closeCode, event.closeReason)})`,
          {
            attempts: Math.max(0, event.attempt - 1),
            closeCode: event.closeCode,
            closeReason: event.closeReason,
            sessionId: this.sessionId,
            stage: "stream",
          }
        )
      );
    };

    if (this.signal?.aborted) {
      streamReason = "aborted";
      finish();
    } else {
      this.signal?.addEventListener("abort", abortListener, { once: true });

      unsubscribe = this.socketManager.subscribe({
        batchSize: this.batchSize,
        connectionTimeoutMs: this.connectionTimeoutMs,
        cursor: this.cursor,
        onConnectionTimeout: ({ closeCode, closeReason }) => {
          fail(
            new StarciteTailError(
              `Tail connection dropped for session '${this.sessionId}' (${describeClose(closeCode, closeReason)})`,
              {
                closeCode,
                closeReason,
                sessionId: this.sessionId,
                stage: "stream",
              }
            )
          );
        },
        onEvents: (events) => {
          lastConnectFailureReason = undefined;
          resetInactivityTimer();
          scheduleCatchUpClose();

          const matchingEvents: TailEvent[] = [];
          for (const event of events) {
            this.cursor = event.cursor ?? event.seq;
            if (this.agent && agentFromActor(event.actor) !== this.agent) {
              continue;
            }
            matchingEvents.push(event);
          }

          if (matchingEvents.length > 0) {
            dispatchBatch(matchingEvents);
          }
        },
        onGap: handleGap,
        onLifecycle: (event) => {
          switch (event.type) {
            case "connect_attempt":
              emitLifecycle({
                attempt: event.attempt,
                cursor: this.cursor,
                sessionId: this.sessionId,
                type: "connect_attempt",
              });
              resetInactivityTimer();
              scheduleCatchUpClose();
              return;
            case "connect_failed":
              handleConnectFailure(event.rootCause, event.attempt);
              return;
            case "reconnect_scheduled":
              handleReconnectScheduled(event);
              return;
            case "dropped":
              handleDropped(event);
              return;
            case "open":
              scheduleCatchUpClose();
              resetInactivityTimer();
              return;
            default:
              return;
          }
        },
        onTokenExpired: (payload: TailTokenExpiredPayload) => {
          fail(
            new StarciteTokenExpiredError(
              `Tail token expired for session '${this.sessionId}'. Re-issue a session token and reconnect from the last processed cursor.`,
              {
                closeReason: payload.reason,
                sessionId: this.sessionId,
              }
            )
          );
        },
        reconnectPolicy: this.reconnectPolicy,
        sessionId: this.sessionId,
        socketAuth: this.socketAuth,
        socketUrl: this.socketUrl,
      });
    }

    try {
      await done;
      await dispatchChain;

      if (streamError !== undefined) {
        throw streamError;
      }

      emitLifecycle({
        reason: streamReason,
        sessionId: this.sessionId,
        type: "stream_ended",
      });
    } finally {
      if (catchUpTimer) {
        clearTimeout(catchUpTimer);
      }

      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }

      this.signal?.removeEventListener("abort", abortListener);
    }
  }
}
