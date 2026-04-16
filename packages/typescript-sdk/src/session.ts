import EventEmitter from "eventemitter3";
import { z } from "zod";
import { AppendQueue } from "./append-queue";
import { decodeSessionToken } from "./auth";
import {
  StarciteError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
import type { StarciteIdentity } from "./identity";
import {
  SessionHistory,
  type SessionHistoryEventContext,
} from "./session-history";
import {
  decodeSessionStoreValue,
  encodeSessionStoreValue,
} from "./session-store";
import {
  type RejoinableChannel,
  readJoinFailureReason,
  SocketManager,
} from "./socket-manager";
import { type TransportConfig, toWebSocketBaseUrl } from "./transport";
import {
  type AppendResult,
  type RequestOptions,
  type SessionAppendInput,
  type SessionAppendLifecycleEvent,
  type SessionAppendListener,
  type SessionAppendOptions,
  type SessionAppendQueueState,
  type SessionAttachMode,
  type SessionEventContext,
  type SessionEventListener,
  type SessionGapListener,
  type SessionHandle,
  type SessionOnEventOptions,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStateListener,
  type SessionStore,
  type SessionTokenRefreshHandler,
  type SessionTokenRefreshReason,
  type TailCursor,
  type TailEvent,
  TailEventSchema,
  type TailGap,
  TailGapSchema,
  TailTokenExpiredPayloadSchema,
} from "./types";

const TailEventsPayloadSchema = z.object({
  events: z.array(TailEventSchema),
});

/**
 * Construction options for a `StarciteSession`.
 */
export interface StarciteSessionOptions {
  id: string;
  token: string;
  identity: StarciteIdentity;
  transport: TransportConfig;
  sessionStore?: SessionStore;
  record?: SessionRecord;
  initialTailCursor?: TailCursor;
  appendOptions?: SessionAppendOptions;
  refreshToken?: SessionTokenRefreshHandler;
  attachMode?: SessionAttachMode;
}

interface SessionLifecycleEvents {
  error: (error: Error) => void;
  append: (event: SessionAppendLifecycleEvent) => void;
  gap: (gap: TailGap) => void;
  state: SessionStateListener;
}

type SessionLifecycleListenerName = keyof SessionLifecycleEvents;
type SessionLifecycleListener =
  SessionLifecycleEvents[SessionLifecycleListenerName];

interface SessionRangeBackfillJob {
  fromSeq: number;
  toSeq: number;
  promise: Promise<void>;
}

interface TailChannelBindings {
  onEvents?: (events: readonly TailEvent[]) => void;
  onGap?: (gap: TailGap) => void;
  onTokenExpired?: () => void;
}

/**
 * Session-scoped client bound to a specific identity and session token.
 *
 * All operations use the session token for auth, not the parent client's API key.
 */
export class StarciteSession implements SessionHandle {
  /** Session identifier. */
  readonly id: string;
  /** Optional session record captured at creation time. */
  readonly record?: SessionRecord;

  private readonly transport: TransportConfig;
  private readonly outbox: AppendQueue;
  private readonly refreshTokenHandler: SessionTokenRefreshHandler | undefined;
  private readonly initialTailCursor: TailCursor | undefined;
  private currentToken: string;
  private currentIdentity: StarciteIdentity;
  private authRefreshTask: Promise<void> | undefined;

  private readonly history: SessionHistory;
  private readonly sessionStore: SessionStore | undefined;
  private readonly lifecycle = new EventEmitter<SessionLifecycleEvents>();
  private readonly eventDispatchers = new Map<
    SessionEventListener,
    (event: TailEvent, context: SessionHistoryEventContext) => void
  >();
  private readonly backfillJobs: SessionRangeBackfillJob[] = [];
  private keepTailAttached = false;
  private closeTailChannel: (() => void) | undefined;
  private nextTailBatchCursor: TailCursor | undefined;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.currentToken = options.token;
    this.currentIdentity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
    this.sessionStore = options.sessionStore;
    this.initialTailCursor = options.initialTailCursor;
    this.refreshTokenHandler = options.refreshToken;
    this.keepTailAttached = (options.attachMode ?? "on-demand") === "eager";
    this.history = new SessionHistory();

    this.outbox = new AppendQueue({
      sessionId: options.id,
      transport: options.transport,
      appendOptions: options.appendOptions,
      persist: this.sessionStore !== undefined,
      onUnauthorized: async (error) => {
        await this.refreshAuthInternal("unauthorized", error, {
          emitFailure: true,
        });
      },
      onStateChange: () => {
        this.reconcileChannelAttachment();
        this.persistStoredState();
        this.emitStateChange();
      },
      onError: (error) => this.emitStreamError(error),
      onLifecycle: (event) => {
        for (const listener of this.lifecycle.listeners(
          "append"
        ) as SessionAppendListener[]) {
          try {
            this.observeListenerResult(listener(event));
          } catch (err) {
            this.emitStreamError(err);
          }
        }
      },
    });

    const storedState = this.readStoredState();
    if (this.restoreStoredState(storedState)) {
      if (storedState?.outbox) {
        this.outbox.restoreState(storedState.outbox);
      }
      const pendingBefore = this.outbox.pendingCount;
      this.outbox.reconcileWithCommittedEvents(
        this.history.events,
        this.history.lastSeq
      );
      if (this.outbox.pendingCount !== pendingBefore) {
        this.persistStoredState();
      }
    }

    this.reconcileChannelAttachment();
    this.outbox.ensureProcessing();
  }

  /** The session JWT used for auth. Extract this for frontend handoff. */
  get token(): string {
    return this.currentToken;
  }

  /** Identity bound to this session. */
  get identity(): StarciteIdentity {
    return this.currentIdentity;
  }

  /**
   * Appends an event to this session.
   *
   * The SDK manages `producer_id` and `producer_seq` automatically.
   */
  append(
    input: SessionAppendInput,
    options?: RequestOptions
  ): Promise<AppendResult> {
    return this.outbox.append(input, options?.signal);
  }

  range(
    fromSeq: number,
    toSeq: number,
    requestOptions?: RequestOptions
  ): Promise<readonly TailEvent[]> {
    return this.readRange(fromSeq, toSeq, requestOptions);
  }

  /**
   * Subscribes to canonical session events and lifecycle errors.
   */
  on(eventName: "event", listener: SessionEventListener): () => void;
  on<TEvent extends TailEvent>(
    eventName: "event",
    listener: SessionEventListener<TEvent>,
    options: SessionOnEventOptions<TEvent>
  ): () => void;
  on(eventName: "append", listener: SessionAppendListener): () => void;
  on(eventName: "gap", listener: SessionGapListener): () => void;
  on(eventName: "state", listener: SessionStateListener): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "append" | "gap" | "state" | "error",
    listener:
      | SessionEventListener
      | SessionAppendListener
      | SessionGapListener
      | SessionStateListener
      | ((error: Error) => void),
    options?: SessionOnEventOptions
  ): () => void {
    switch (eventName) {
      case "event": {
        return this.onEvent(
          listener as SessionEventListener,
          options as SessionOnEventOptions | undefined
        );
      }

      case "gap":
        return this.addLifecycleListener("gap", listener as SessionGapListener);

      case "append":
        return this.addLifecycleListener(
          "append",
          listener as SessionAppendListener
        );

      case "state":
        return this.addLifecycleListener(
          "state",
          listener as SessionStateListener
        );

      case "error":
        return this.addLifecycleListener(
          "error",
          listener as (error: Error) => void
        );

      default:
        throw new StarciteError(`Unsupported event name '${eventName}'`);
    }
  }

  /**
   * Removes a previously registered listener.
   */
  off(eventName: "event", listener: SessionEventListener): void;
  off(eventName: "append", listener: SessionAppendListener): void;
  off(eventName: "gap", listener: SessionGapListener): void;
  off(eventName: "state", listener: SessionStateListener): void;
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "event" | "append" | "gap" | "state" | "error",
    listener:
      | SessionEventListener
      | SessionAppendListener
      | SessionGapListener
      | SessionStateListener
      | ((error: Error) => void)
  ): void {
    switch (eventName) {
      case "event": {
        this.offEvent(listener as SessionEventListener);
        return;
      }

      case "gap":
        this.removeLifecycleListener("gap", listener as SessionGapListener);
        return;

      case "append":
        this.removeLifecycleListener(
          "append",
          listener as SessionAppendListener
        );
        return;

      case "state":
        this.removeLifecycleListener("state", listener as SessionStateListener);
        return;

      case "error":
        this.removeLifecycleListener(
          "error",
          listener as (error: Error) => void
        );
        return;

      default:
        throw new StarciteError(`Unsupported event name '${eventName}'`);
    }
  }

  private onEvent(
    listener: SessionEventListener,
    options: SessionOnEventOptions | undefined
  ): () => void {
    if (!this.eventDispatchers.has(listener)) {
      const replay = options?.replay ?? false;

      const dispatch = (
        event: TailEvent,
        historyContext: SessionHistoryEventContext
      ): void => {
        const parsedEvent = this.parseOnEvent(event, options);
        if (!parsedEvent) {
          return;
        }

        const context: SessionEventContext = {
          phase: historyContext.replayed ? "replay" : "live",
        };

        try {
          this.observeListenerResult(listener(parsedEvent, context));
        } catch (error) {
          this.emitStreamError(error);
        }
      };

      this.eventDispatchers.set(listener, dispatch);
      this.history.observe(dispatch, { replay });
    }

    this.ensureChannelAttached();
    return () => {
      this.offEvent(listener);
    };
  }

  private addLifecycleListener(
    eventName: SessionLifecycleListenerName,
    listener: SessionLifecycleListener
  ): () => void {
    this.lifecycle.on(eventName, listener as never);
    if (eventName === "gap" || eventName === "state") {
      this.ensureChannelAttached();
    }

    return () => {
      this.removeLifecycleListener(eventName, listener);
    };
  }

  private removeLifecycleListener(
    eventName: SessionLifecycleListenerName,
    listener: SessionLifecycleListener
  ): void {
    this.lifecycle.off(eventName, listener as never);
    if (eventName === "gap" || eventName === "state") {
      this.detachTailChannelIfIdle();
    }
  }

  private offEvent(listener: SessionEventListener): void {
    const dispatch = this.eventDispatchers.get(listener);
    if (!dispatch) {
      return;
    }

    this.eventDispatchers.delete(listener);
    this.history.unobserve(dispatch);
    this.detachTailChannelIfIdle();
  }

  /**
   * Stops tailing and removes listeners registered via `on()`.
   */
  disconnect(): void {
    this.keepTailAttached = false;
    this.outbox.stop();
    for (const dispatch of this.eventDispatchers.values()) {
      this.history.unobserve(dispatch);
    }
    this.eventDispatchers.clear();
    this.detachTailChannel();
    this.lifecycle.removeAllListeners();
  }

  /**
   * Returns the current append queue state.
   */
  appendState(): SessionAppendQueueState {
    return this.outbox.state();
  }

  /**
   * Resumes a paused queue or starts a restored queue that was loaded with `autoFlush=false`.
   */
  resumeAppendQueue(): void {
    this.outbox.resume();
  }

  /**
   * Clears the append queue and rotates the managed producer identity.
   */
  resetAppendQueue(): void {
    this.outbox.reset();
  }

  /**
   * Requests a fresh session token through the configured refresh handler.
   */
  refreshAuth(): Promise<void> {
    return this.refreshAuthInternal("manual", undefined, {
      emitFailure: false,
    });
  }

  /**
   * Returns a stable view of the current canonical in-memory event state.
   */
  state(): SessionSnapshot {
    return {
      ...this.history.state(this.closeTailChannel !== undefined),
      append: this.outbox.state(),
    };
  }

  private async readRange(
    fromSeq: number,
    toSeq: number,
    requestOptions?: RequestOptions
  ): Promise<readonly TailEvent[]> {
    while (true) {
      const missingRange = this.history.firstMissingRange(fromSeq, toSeq);
      if (!missingRange) {
        return this.history.readRange(fromSeq, toSeq);
      }

      const existingJob = this.backfillJobs.find((job) => {
        return (
          job.fromSeq <= missingRange.toSeq &&
          job.toSeq + 1 >= missingRange.fromSeq
        );
      });
      if (existingJob) {
        await this.awaitJob(existingJob.promise, requestOptions?.signal);
        continue;
      }

      const job = this.startRangeBackfill(
        missingRange.fromSeq,
        missingRange.toSeq
      );
      this.backfillJobs.push(job);

      try {
        await this.awaitJob(job.promise, requestOptions?.signal);
      } finally {
        const jobIndex = this.backfillJobs.indexOf(job);
        if (jobIndex >= 0) {
          this.backfillJobs.splice(jobIndex, 1);
        }
      }
    }
  }

  private parseOnEvent<TEvent extends TailEvent>(
    event: TailEvent,
    options: SessionOnEventOptions<TEvent> | undefined
  ): TEvent | undefined {
    if (options?.agent && event.actor !== `agent:${options.agent}`) {
      return undefined;
    }

    if (!options?.schema) {
      return event as TEvent;
    }

    try {
      return options.schema.parse(event);
    } catch (error) {
      this.emitStreamError(
        new StarciteError(
          `session.on("event") schema validation failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return undefined;
    }
  }

  private observeListenerResult(result: void | Promise<void>): void {
    Promise.resolve(result).catch((error) => {
      this.emitStreamError(error);
    });
  }

  private emitStreamError(error: unknown): void {
    const streamError =
      error instanceof Error
        ? error
        : new StarciteError(`Session stream failed: ${String(error)}`);

    if (this.lifecycle.listenerCount("error") > 0) {
      this.lifecycle.emit("error", streamError);
      return;
    }

    queueMicrotask(() => {
      throw streamError;
    });
  }

  private emitStateChange(): void {
    const listeners = this.lifecycle.listeners(
      "state"
    ) as SessionStateListener[];
    if (listeners.length === 0) {
      return;
    }

    const snapshot = this.state();
    for (const listener of listeners) {
      try {
        this.observeListenerResult(listener(snapshot));
      } catch (error) {
        this.emitStreamError(error);
      }
    }
  }

  private shouldKeepChannelAttached(): boolean {
    return (
      this.keepTailAttached ||
      this.outbox.pendingCount > 0 ||
      this.eventDispatchers.size > 0 ||
      this.lifecycle.listenerCount("gap") > 0 ||
      this.lifecycle.listenerCount("state") > 0
    );
  }

  private reconcileChannelAttachment(): void {
    if (this.shouldKeepChannelAttached()) {
      this.ensureChannelAttached();
      return;
    }

    this.detachTailChannel();
  }

  private ensureChannelAttached(): void {
    if (
      this.closeTailChannel ||
      !this.shouldKeepChannelAttached() ||
      this.authRefreshTask
    ) {
      return;
    }

    const managedChannel =
      this.transport.socketManager.openChannel<RejoinableChannel>({
        topic: `tail:${this.id}`,
        params: () => this.tailChannelParams(),
      });
    const channel = managedChannel.channel;
    const unbind = this.bindTailChannel(channel, {
      onEvents: (events) => {
        try {
          const appliedEvents = this.history.applyLiveBatch(
            events,
            this.nextTailBatchCursor
          );
          this.nextTailBatchCursor = events.at(-1)?.cursor;
          if (appliedEvents.length > 0) {
            this.outbox.reconcileWithCommittedEvents(
              appliedEvents,
              this.history.lastSeq
            );
            this.persistStoredState();
            this.emitStateChange();
          }
        } catch (error) {
          this.emitStreamError(error);
        }
      },
      onGap: (gap) => {
        if (this.history.markObservedCursor(gap.next_cursor)) {
          this.persistStoredState();
          this.emitStateChange();
        }

        if (this.lifecycle.listenerCount("gap") > 0) {
          this.lifecycle.emit("gap", gap);
        }

        this.nextTailBatchCursor = gap.next_cursor;
        channel.rejoin();
      },
      onTokenExpired: () => {
        const error = new StarciteTokenExpiredError(
          `Tail token expired for session '${this.id}'. Re-issue a session token and reconnect from the last processed cursor.`,
          {
            closeReason: "token_expired",
            sessionId: this.id,
          }
        );
        this.detachTailChannel();
        this.refreshAuthInternal("token_expired", error, {
          emitFailure: true,
        }).catch(() => undefined);
      },
    });
    this.closeTailChannel = () => {
      unbind();
      managedChannel.close();
    };

    channel.join().receive("error", (payload) => {
      const error = new StarciteTailError(
        `Tail connection failed for session '${this.id}': ${readJoinFailureReason(payload)}`,
        {
          sessionId: this.id,
          stage: "connect",
        }
      );
      this.emitStreamError(error);
    });
  }

  private detachTailChannelIfIdle(): void {
    if (this.shouldKeepChannelAttached()) {
      return;
    }

    this.detachTailChannel();
  }

  private detachTailChannel(): void {
    const closeTailChannel = this.closeTailChannel;
    this.closeTailChannel = undefined;
    closeTailChannel?.();
  }

  private tailChannelParams(): Record<string, unknown> {
    if (this.history.cursor !== undefined) {
      this.nextTailBatchCursor = this.history.cursor;
      return { cursor: this.history.cursor };
    }

    if (this.initialTailCursor !== undefined) {
      this.nextTailBatchCursor = this.initialTailCursor;
      return { cursor: this.initialTailCursor };
    }

    if (this.keepTailAttached) {
      this.nextTailBatchCursor = 0;
      return { cursor: 0 };
    }

    this.nextTailBatchCursor = undefined;
    return { live_only: true };
  }

  private startRangeBackfill(
    fromSeq: number,
    toSeq: number
  ): SessionRangeBackfillJob {
    const anchor = this.history.anchorBeforeSeq(fromSeq);
    let currentCursor = anchor.cursor;
    const socketManager = new SocketManager({
      socketUrl: `${toWebSocketBaseUrl(this.transport.baseUrl)}/socket`,
      token: this.currentToken,
    });
    const managedChannel = socketManager.openChannel<RejoinableChannel>({
      topic: `tail:${this.id}`,
      params: () => ({ cursor: currentCursor }),
    });
    const channel = managedChannel.channel;

    let observedSeq = anchor.seq;
    let pendingGapAfterSeq: number | undefined;
    let finished = false;
    let unbind: (() => void) | undefined;

    const finish = (callback: () => void): void => {
      if (finished) {
        return;
      }

      finished = true;
      unbind?.();
      managedChannel.close();
      callback();
    };

    const promise = new Promise<void>((resolve, reject) => {
      const resolveBackfill = (): void => {
        finish(resolve);
      };
      const failBackfill = (error: Error): void => {
        finish(() => {
          reject(error);
        });
      };

      unbind = this.bindTailChannel(channel, {
        onEvents: (batch) => {
          if (batch.length === 0) {
            return;
          }

          const mergedBatch = this.mergeRangeBackfillBatch(
            batch,
            currentCursor,
            observedSeq
          );
          if (mergedBatch instanceof Error) {
            failBackfill(mergedBatch);
            return;
          }

          currentCursor = mergedBatch.currentCursor;
          observedSeq = mergedBatch.observedSeq;

          if (
            this.rangeBackfillHasUnrecoverableGap(
              pendingGapAfterSeq,
              batch,
              fromSeq,
              toSeq
            )
          ) {
            failBackfill(this.rangeBackfillGapError(fromSeq, toSeq));
            return;
          }

          pendingGapAfterSeq = undefined;
          if (this.history.isRangeCovered(fromSeq, toSeq)) {
            resolveBackfill();
          }
        },
        onGap: (gap) => {
          if (this.history.markObservedCursor(gap.next_cursor)) {
            this.persistStoredState();
            this.emitStateChange();
          }
          pendingGapAfterSeq = observedSeq;
          currentCursor = gap.next_cursor;
          channel.rejoin();
        },
        onTokenExpired: () => {
          failBackfill(
            new StarciteTokenExpiredError(
              `Tail replay token expired for session '${this.id}'.`,
              {
                closeReason: "token_expired",
                sessionId: this.id,
              }
            )
          );
        },
      });

      channel.join().receive("error", (payload) => {
        failBackfill(
          new StarciteTailError(
            `Tail replay failed for session '${this.id}': ${readJoinFailureReason(payload)}`,
            {
              sessionId: this.id,
              stage: "connect",
            }
          )
        );
      });
    });

    return {
      fromSeq,
      toSeq,
      promise,
    };
  }

  private bindTailChannel(
    channel: RejoinableChannel,
    bindings: TailChannelBindings
  ): () => void {
    const eventsBindingRef = bindings.onEvents
      ? channel.on("events", (payload) => {
          const result = TailEventsPayloadSchema.safeParse(payload);
          if (result.success) {
            bindings.onEvents?.(result.data.events);
          }
        })
      : 0;
    const gapBindingRef = bindings.onGap
      ? channel.on("gap", (payload) => {
          const result = TailGapSchema.safeParse(payload);
          if (result.success) {
            bindings.onGap?.(result.data);
          }
        })
      : 0;
    const tokenExpiredBindingRef = bindings.onTokenExpired
      ? channel.on("token_expired", (payload) => {
          const result = TailTokenExpiredPayloadSchema.safeParse(payload);
          if (result.success) {
            bindings.onTokenExpired?.();
          }
        })
      : 0;

    return () => {
      if (eventsBindingRef > 0) {
        channel.off("events", eventsBindingRef);
      }
      if (gapBindingRef > 0) {
        channel.off("gap", gapBindingRef);
      }
      if (tokenExpiredBindingRef > 0) {
        channel.off("token_expired", tokenExpiredBindingRef);
      }
    };
  }

  private refreshAuthInternal(
    reason: SessionTokenRefreshReason,
    error: Error | undefined,
    options: { emitFailure: boolean }
  ): Promise<void> {
    const refreshHandler = this.refreshTokenHandler;
    if (!refreshHandler) {
      const missingHandlerError =
        error ??
        new StarciteError(
          `Session '${this.id}' does not have a refreshToken callback. Provide one to session({ token, refreshToken }) or reconnect with a fresh session token.`
        );
      if (options.emitFailure) {
        this.emitStreamError(missingHandlerError);
      }
      return Promise.reject(missingHandlerError);
    }

    if (this.authRefreshTask) {
      return this.authRefreshTask;
    }

    this.detachTailChannel();
    let refreshed = false;

    const task = Promise.resolve()
      .then(() =>
        refreshHandler({
          sessionId: this.id,
          token: this.currentToken,
          reason,
          error,
        })
      )
      .then((nextToken) => {
        this.applyTokenBinding(nextToken);
        this.outbox.ensureProcessing();
        refreshed = true;
      })
      .catch((refreshError) => {
        const authError = this.toError(refreshError);
        if (options.emitFailure) {
          this.emitStreamError(authError);
        }
        throw authError;
      })
      .finally(() => {
        if (this.authRefreshTask === task) {
          this.authRefreshTask = undefined;
        }
        if (refreshed) {
          this.ensureChannelAttached();
        }
      });

    this.authRefreshTask = task;
    return task;
  }

  private applyTokenBinding(token: string): void {
    const decoded = decodeSessionToken(token);
    if (!decoded.sessionId) {
      throw new StarciteError(
        "refreshToken callback must return a token with a session_id claim."
      );
    }

    if (decoded.sessionId !== this.id) {
      throw new StarciteError(
        `refreshToken callback returned a token for session '${decoded.sessionId}', expected '${this.id}'.`
      );
    }

    this.currentToken = token;
    this.currentIdentity = decoded.identity;
    this.transport.bearerToken = token;
    this.transport.socketManager.setToken(token);
    this.detachTailChannel();
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new StarciteError(String(error));
  }

  private readStoredState(): ReturnType<typeof decodeSessionStoreValue> {
    if (!this.sessionStore) {
      return undefined;
    }

    try {
      const storedValue = this.sessionStore.read(this.id);
      if (storedValue === undefined) {
        return undefined;
      }

      const storedState = decodeSessionStoreValue(storedValue);
      if (storedState) {
        return storedState;
      }

      this.clearStoredState();
      return undefined;
    } catch {
      return undefined;
    }
  }

  private restoreStoredState(
    storedState: ReturnType<typeof decodeSessionStoreValue>
  ): boolean {
    if (storedState === undefined) {
      return true;
    }

    try {
      this.history.restore(storedState);
      return true;
    } catch {
      this.clearStoredState();
      return false;
    }
  }

  private persistStoredState(): void {
    if (!this.sessionStore) {
      return;
    }

    try {
      this.sessionStore.write(
        this.id,
        encodeSessionStoreValue({
          timeline: this.history.snapshot(),
          outbox: this.outbox.serializeState(),
        })
      );
    } catch (error) {
      const storeError = new StarciteError(
        `Session store write failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
      );

      if (this.lifecycle.listenerCount("error") > 0) {
        this.lifecycle.emit("error", storeError);
      }
    }
  }

  private clearStoredState(): void {
    try {
      this.sessionStore?.clear?.(this.id);
    } catch {
      // Ignore store-clear failures; the live stream can still recover state.
    }
  }

  private mergeRangeBackfillBatch(
    batch: readonly TailEvent[],
    currentCursor: TailCursor,
    observedSeq: number
  ): { currentCursor: TailCursor; observedSeq: number } | Error {
    try {
      this.history.applyBackfillBatch(batch, currentCursor);
      const nextCursor = batch.at(-1)?.cursor ?? currentCursor;
      const nextObservedSeq = batch.at(-1)?.seq ?? observedSeq;
      this.history.markObservedCursor(nextCursor);
      this.persistStoredState();
      this.emitStateChange();
      return {
        currentCursor: nextCursor,
        observedSeq: nextObservedSeq,
      };
    } catch (error) {
      return this.toError(error);
    }
  }

  private rangeBackfillHasUnrecoverableGap(
    pendingGapAfterSeq: number | undefined,
    batch: readonly TailEvent[],
    fromSeq: number,
    toSeq: number
  ): boolean {
    if (pendingGapAfterSeq === undefined) {
      return false;
    }

    const firstSeq = batch[0]?.seq;
    if (firstSeq === undefined || firstSeq <= pendingGapAfterSeq + 1) {
      return false;
    }

    return fromSeq <= firstSeq - 1 && toSeq > pendingGapAfterSeq;
  }

  private rangeBackfillGapError(
    fromSeq: number,
    toSeq: number
  ): StarciteTailError {
    return new StarciteTailError(
      `Tail replay could not cover requested seq range ${fromSeq}-${toSeq} for session '${this.id}'.`,
      {
        sessionId: this.id,
        stage: "gap",
      }
    );
  }

  private awaitJob(
    promise: Promise<void>,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (!signal) {
      return promise;
    }

    if (signal.aborted) {
      return Promise.reject(new StarciteError("Session range read aborted."));
    }

    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener("abort", abort);
        reject(new StarciteError("Session range read aborted."));
      };

      signal.addEventListener("abort", abort, { once: true });

      promise.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  }
}
