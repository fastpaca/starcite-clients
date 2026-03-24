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
  TailReconnectPolicy,
  TailTokenExpiredPayload,
} from "../types";
import type {
  TailSocketAuthContext,
  TailSocketLifecycleEvent,
  TailSocketManagerRegistry,
} from "./socket-manager";

interface ResolvedReconnectPolicy {
  initialDelayMs: number;
  jitterRatio: number;
  maxAttempts: number;
  maxDelayMs: number;
  mode: "fixed" | "exponential";
  multiplier: number;
}

interface LifecycleCallbacks {
  emitLifecycle: (event: TailLifecycleEvent) => void;
  fail: (error: unknown) => void;
  resetInactivityTimer: () => void;
  scheduleCatchUpClose: () => void;
}

function resolveReconnectPolicy(
  policy: TailReconnectPolicy | undefined
): ResolvedReconnectPolicy {
  const mode = policy?.mode === "fixed" ? "fixed" : "exponential";
  const initialDelayMs = policy?.initialDelayMs ?? 500;

  return {
    initialDelayMs,
    jitterRatio: policy?.jitterRatio ?? 0.2,
    maxAttempts: policy?.maxAttempts ?? Number.POSITIVE_INFINITY,
    maxDelayMs:
      policy?.maxDelayMs ??
      (mode === "fixed" ? initialDelayMs : Math.max(initialDelayMs, 15_000)),
    mode,
    multiplier: mode === "fixed" ? 1 : (policy?.multiplier ?? 2),
  };
}

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
  private readonly socketManagerRegistry: TailSocketManagerRegistry;
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
  private readonly reconnectPolicy: ResolvedReconnectPolicy;
  private readonly shouldReconnect: boolean;
  private readonly signal: AbortSignal | undefined;

  private cursor: TailCursor;

  constructor(input: {
    customWebSocketFactoryProvided: boolean;
    options: SessionTailOptions;
    sessionId: string;
    socketAuth: TailSocketAuthContext;
    socketManagerRegistry: TailSocketManagerRegistry;
    socketUrl: string;
  }) {
    const opts = input.options;

    this.customWebSocketFactoryProvided = input.customWebSocketFactoryProvided;
    this.sessionId = input.sessionId;
    this.socketAuth = input.socketAuth;
    this.socketManagerRegistry = input.socketManagerRegistry;
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
    this.reconnectPolicy = resolveReconnectPolicy(opts.reconnectPolicy);
    this.shouldReconnect = this.follow ? (opts.reconnect ?? true) : false;
    this.signal = opts.signal;
  }

  private handleConnectAttempt(
    event: Extract<TailSocketLifecycleEvent, { type: "connect_attempt" }>,
    callbacks: LifecycleCallbacks
  ): void {
    callbacks.emitLifecycle({
      attempt: event.attempt,
      cursor: this.cursor,
      sessionId: this.sessionId,
      type: "connect_attempt",
    });
    callbacks.resetInactivityTimer();
    callbacks.scheduleCatchUpClose();
  }

  private handleConnectFailed(
    event: Extract<TailSocketLifecycleEvent, { type: "connect_failed" }>,
    fail: (error: unknown) => void
  ): string {
    if (!this.shouldReconnect) {
      fail(
        new StarciteTailError(
          `Tail connection failed for session '${this.sessionId}': ${event.rootCause}`,
          {
            attempts: Math.max(0, event.attempt - 1),
            sessionId: this.sessionId,
            stage: "connect",
          }
        )
      );
    }

    return event.rootCause;
  }

  private handleReconnectScheduled(
    event: Extract<TailSocketLifecycleEvent, { type: "reconnect_scheduled" }>,
    callbacks: LifecycleCallbacks,
    lastConnectFailureReason: string | undefined
  ): void {
    if (event.attempt > this.reconnectPolicy.maxAttempts) {
      const message =
        event.trigger === "connect_failed"
          ? `Tail connection failed for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s): ${lastConnectFailureReason ?? "Unknown error"}`
          : `Tail connection dropped for session '${this.sessionId}' after ${this.reconnectPolicy.maxAttempts} reconnect attempt(s) (${describeClose(event.closeCode, event.closeReason)})`;
      callbacks.fail(
        new StarciteRetryLimitError(message, {
          attempts: event.attempt,
          closeCode: event.closeCode,
          closeReason: event.closeReason,
          sessionId: this.sessionId,
        })
      );
      return;
    }

    callbacks.emitLifecycle({
      attempt: event.attempt,
      closeCode: event.closeCode,
      closeReason: event.closeReason,
      delayMs: event.delayMs,
      sessionId: this.sessionId,
      trigger: event.trigger,
      type: "reconnect_scheduled",
    });
  }

  private handleDropped(
    event: Extract<TailSocketLifecycleEvent, { type: "dropped" }>,
    callbacks: LifecycleCallbacks
  ): void {
    callbacks.emitLifecycle({
      attempt: event.attempt,
      closeCode: event.closeCode,
      closeReason: event.closeReason,
      sessionId: this.sessionId,
      type: "stream_dropped",
    });

    if (!this.shouldReconnect) {
      callbacks.fail(
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
    }
  }

  private handleSocketLifecycleEvent(
    event: TailSocketLifecycleEvent,
    callbacks: LifecycleCallbacks,
    lastConnectFailureReason: string | undefined
  ): string | undefined {
    switch (event.type) {
      case "connect_attempt":
        this.handleConnectAttempt(event, callbacks);
        return lastConnectFailureReason;
      case "connect_failed":
        return this.handleConnectFailed(event, callbacks.fail);
      case "reconnect_scheduled":
        this.handleReconnectScheduled(
          event,
          callbacks,
          lastConnectFailureReason
        );
        return lastConnectFailureReason;
      case "dropped":
        this.handleDropped(event, callbacks);
        return lastConnectFailureReason;
      case "open":
        callbacks.scheduleCatchUpClose();
        callbacks.resetInactivityTimer();
        return lastConnectFailureReason;
      default:
        return lastConnectFailureReason;
    }
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

    const manager = this.socketManagerRegistry.getManager({
      auth: this.socketAuth,
      socketUrl: this.socketUrl,
    });

    if (this.signal?.aborted) {
      streamReason = "aborted";
      finish();
    } else {
      this.signal?.addEventListener("abort", abortListener, { once: true });

      unsubscribe = manager.subscribe({
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
          lastConnectFailureReason = this.handleSocketLifecycleEvent(
            event,
            {
              emitLifecycle,
              fail,
              resetInactivityTimer,
              scheduleCatchUpClose,
            },
            lastConnectFailureReason
          );
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
        reconnectPolicy: this.shouldReconnect
          ? {
              initialDelayMs: this.reconnectPolicy.initialDelayMs,
              jitterRatio: this.reconnectPolicy.jitterRatio,
              maxAttempts: this.reconnectPolicy.maxAttempts,
              maxDelayMs: this.reconnectPolicy.maxDelayMs,
              mode: this.reconnectPolicy.mode,
              multiplier: this.reconnectPolicy.multiplier,
            }
          : undefined,
        sessionId: this.sessionId,
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
