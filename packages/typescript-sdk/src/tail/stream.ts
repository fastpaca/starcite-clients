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

/**
 * Stateful tail runner powered by a managed websocket loop.
 *
 * `cursor` is the reconnect checkpoint and advances with every parsed event.
 * Agent filtering affects emitted batches, not cursor advancement.
 * In non-follow mode, stream auto-closes after `catchUpIdleMs` of inactivity.
 */
export class TailStream {
  private readonly sessionId: string;
  private readonly token: string | undefined;
  private readonly websocketBaseUrl: string;
  private readonly websocketFactory: (url: string) => StarciteWebSocket;

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
    websocketFactory: (url: string) => StarciteWebSocket;
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

    this.cursor = opts.cursor ?? 0;
    this.batchSize = opts.batchSize;
    this.agent = opts.agent?.trim();
    this.follow = follow;
    // Catch-up mode (`follow: false`) is single-pass and never reconnects.
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
    // Shared run state: one terminal error + one terminal reason for the whole subscription.
    let streamError: unknown;
    let streamReason: "aborted" | "caught_up" | "graceful" = this.follow
      ? "graceful"
      : "caught_up";
    let queuedBatches = 0;
    let catchUpTimer: ReturnType<typeof setTimeout> | undefined;
    let dispatchChain: Promise<void> = Promise.resolve();

    const stream = new ManagedWebSocket({
      // URL is re-read per attempt by `ManagedWebSocket` and reflects current cursor.
      url: () => this.buildTailUrl(),
      websocketFactory: this.websocketFactory,
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
      // First terminal error wins; subsequent errors are ignored.
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
        // Lifecycle callbacks are part of control flow; failures are terminal.
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

      // Non-follow mode closes once no frames arrive for `catchUpIdleMs`.
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

      // Backpressure is measured as unresolved consumer callbacks.
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
      // Serialize consumer callbacks: preserves order and keeps backpressure measurable.
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

    // Translate low-level transport lifecycle into SDK lifecycle + domain errors.
    const onConnectAttempt = (event: { attempt: number }): void => {
      emitLifecycle({
        type: "connect_attempt",
        sessionId: this.sessionId,
        attempt: event.attempt,
        cursor: this.cursor,
      });
    };

    const onConnectFailed = (event: {
      attempt: number;
      rootCause: string;
    }): void => {
      // Without reconnect, first dial failure is terminal for the subscription.
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
    };

    const onReconnectScheduled = (event: {
      attempt: number;
      delayMs: number;
      trigger: "connect_failed" | "dropped";
      closeCode?: number;
      closeReason?: string;
    }): void => {
      emitLifecycle({
        type: "reconnect_scheduled",
        sessionId: this.sessionId,
        attempt: event.attempt,
        delayMs: event.delayMs,
        trigger: event.trigger,
        closeCode: event.closeCode,
        closeReason: event.closeReason,
      });
    };

    const onDropped = (event: {
      attempt: number;
      closeCode?: number;
      closeReason?: string;
    }): void => {
      // Auth expiry is non-recoverable with current token; surface explicit domain error.
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
        // In no-reconnect mode, any drop is terminal and includes close metadata.
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
    };

    const onRetryLimit = (event: {
      attempt: number;
      trigger: "connect_failed" | "dropped";
      closeCode?: number;
      closeReason?: string;
      rootCause?: string;
    }): void => {
      // Retry limit unifies terminal error reporting for both connect and drop failures.
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
    };

    const onOpen = (): void => {
      // Re-arm catch-up detection after each successful (re)connect.
      scheduleCatchUpClose();
    };

    const onMessage = (data: unknown): void => {
      try {
        const parsedEvents = parseTailFrame(data);
        const matchingEvents: TailEvent[] = [];

        for (const parsedEvent of parsedEvents) {
          // Cursor advances for every parsed event, even if filtered out by agent.
          this.cursor = Math.max(this.cursor, parsedEvent.seq);

          if (this.agent && agentFromActor(parsedEvent.actor) !== this.agent) {
            continue;
          }

          matchingEvents.push(parsedEvent);
        }

        if (matchingEvents.length > 0) {
          // A successfully delivered batch proves the stream is healthy again.
          stream.resetReconnectAttempts();
          dispatchBatch(matchingEvents);
        }

        scheduleCatchUpClose();
      } catch (error) {
        fail(error);
      }
    };

    const onFatal = (error: unknown): void => {
      fail(error);
    };

    const onClosed = (event: { aborted: boolean; graceful: boolean }): void => {
      clearCatchUpTimer();
      // Map transport terminal state into SDK-level stream reason.
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
    };

    stream.on("connect_attempt", onConnectAttempt);
    stream.on("connect_failed", onConnectFailed);
    stream.on("reconnect_scheduled", onReconnectScheduled);
    stream.on("dropped", onDropped);
    stream.on("retry_limit", onRetryLimit);
    stream.on("open", onOpen);
    stream.on("message", onMessage);
    stream.on("fatal", onFatal);
    stream.on("closed", onClosed);

    try {
      await stream.waitForClose();
      clearCatchUpTimer();
      // Drain in-flight consumer callbacks before returning/throwing.
      await dispatchChain;

      // Transport finished, but callback processing may already have failed.
      if (streamError !== undefined) {
        throw streamError;
      }

      emitLifecycle({
        type: "stream_ended",
        sessionId: this.sessionId,
        reason: streamReason,
      });

      // Lifecycle callbacks can fail and convert clean transport completion into failure.
      if (streamError !== undefined) {
        throw streamError;
      }
    } finally {
      clearCatchUpTimer();
      stream.off("connect_attempt", onConnectAttempt);
      stream.off("connect_failed", onConnectFailed);
      stream.off("reconnect_scheduled", onReconnectScheduled);
      stream.off("dropped", onDropped);
      stream.off("retry_limit", onRetryLimit);
      stream.off("open", onOpen);
      stream.off("message", onMessage);
      stream.off("fatal", onFatal);
      stream.off("closed", onClosed);
      stream.close(NORMAL_CLOSE_CODE, "finished");
    }
  }

  private buildTailUrl(): string {
    // Cursor is always included so reconnect resumes from last observed sequence.
    const query = new URLSearchParams({ cursor: `${this.cursor}` });

    if (this.batchSize !== undefined) {
      query.set("batch_size", `${this.batchSize}`);
    }

    if (this.token) {
      query.set("access_token", this.token);
    }

    return `${this.websocketBaseUrl}/sessions/${encodeURIComponent(
      this.sessionId
    )}/tail?${query.toString()}`;
  }
}

function describeClose(
  code: number | undefined,
  reason: string | undefined
): string {
  const codeText = `code ${code ?? "unknown"}`;
  return reason ? `${codeText}, reason '${reason}'` : codeText;
}
