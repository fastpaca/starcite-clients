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
  concatSessionEvents,
  type SessionEventsRead,
  sessionEventsResponseSchema,
  toSessionEventSlice,
  toSessionEventsQuerySuffix,
} from "./session-events";
import { SessionLog, type SessionLogSubscriptionContext } from "./session-log";
import {
  type RejoinableChannel,
  readJoinFailureReason,
} from "./socket-manager";
import { request, type TransportConfig } from "./transport";
import {
  type AppendResult,
  type RequestOptions,
  type SessionAppendInput,
  type SessionAppendLifecycleEvent,
  type SessionAppendListener,
  type SessionAppendOptions,
  type SessionAppendQueueState,
  type SessionAttachMode,
  type SessionCache,
  type SessionCacheEntry,
  type SessionEventContext,
  type SessionEventListener,
  type SessionEventSlice,
  type SessionGapListener,
  type SessionHandle,
  type SessionOnEventOptions,
  type SessionRecord,
  type SessionSnapshot,
  type SessionTokenRefreshHandler,
  type SessionTokenRefreshReason,
  type TailEvent,
  TailEventSchema,
  type TailGap,
  TailGapSchema,
  TailTokenExpiredPayloadSchema,
} from "./types";

const TailEventsPayloadSchema = z.object({
  events: z.array(TailEventSchema),
});

const READ_ALL_PAGE_LIMIT = 1000;

/**
 * Construction options for a `StarciteSession`.
 */
export interface StarciteSessionOptions {
  id: string;
  token: string;
  identity: StarciteIdentity;
  transport: TransportConfig;
  cache?: SessionCache;
  record?: SessionRecord;
  appendOptions?: SessionAppendOptions;
  refreshToken?: SessionTokenRefreshHandler;
  attachMode?: SessionAttachMode;
}

interface SessionLifecycleEvents {
  error: (error: Error) => void;
  append: (event: SessionAppendLifecycleEvent) => void;
  gap: (gap: TailGap) => void;
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
  private currentToken: string;
  private currentIdentity: StarciteIdentity;
  private authRefreshTask: Promise<void> | undefined;

  readonly log: SessionLog;
  private readonly cache: SessionCache | undefined;
  private readonly lifecycle = new EventEmitter<SessionLifecycleEvents>();
  private readonly eventSubscriptions = new Map<
    SessionEventListener,
    () => void
  >();
  private keepTailAttached = false;
  private tailChannel: RejoinableChannel | undefined;
  private tailEventBindingRef = 0;
  private tailGapBindingRef = 0;
  private tailTokenExpiredBindingRef = 0;
  private closeTailChannel: (() => void) | undefined;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.currentToken = options.token;
    this.currentIdentity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
    this.cache = options.cache;
    this.refreshTokenHandler = options.refreshToken;
    this.keepTailAttached = (options.attachMode ?? "on-demand") === "eager";
    this.log = new SessionLog();

    this.outbox = new AppendQueue({
      sessionId: options.id,
      transport: options.transport,
      appendOptions: options.appendOptions,
      persist: this.cache !== undefined,
      onUnauthorized: async (error) => {
        await this.refreshAuthInternal("unauthorized", error, {
          emitFailure: true,
        });
      },
      onStateChange: () => {
        this.persistCacheEntry();
        this.reconcileChannelAttachment();
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

    const cachedEntry = this.readCachedEntry();
    if (this.restoreCachedState(cachedEntry)) {
      if (cachedEntry?.outbox) {
        this.outbox.restoreState(cachedEntry.outbox);
      }
      const pendingBefore = this.outbox.pendingCount;
      this.outbox.reconcileWithCommittedEvents(
        this.log.events,
        this.log.lastSeq
      );
      if (this.outbox.pendingCount !== pendingBefore) {
        this.persistCacheEntry();
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

  async all(requestOptions?: RequestOptions): Promise<SessionEventSlice> {
    let afterSeq = 0;
    let events: TailEvent[] = [];

    while (true) {
      const response = await this.readEvents(
        { kind: "after", limit: READ_ALL_PAGE_LIMIT, seq: afterSeq },
        requestOptions
      );
      events = concatSessionEvents(events, response.events);

      if (
        !toSessionEventSlice(
          { kind: "after", limit: READ_ALL_PAGE_LIMIT, seq: afterSeq },
          response
        ).hasMore
      ) {
        return {
          events,
          hasMore: false,
        };
      }

      const nextAfterSeq = response.events.at(-1)?.seq;
      if (nextAfterSeq === undefined) {
        return {
          events,
          hasMore: false,
        };
      }
      afterSeq = nextAfterSeq;
    }
  }

  latest(
    limit: number,
    requestOptions?: RequestOptions
  ): Promise<SessionEventSlice> {
    return this.readSlice({ kind: "latest", limit }, requestOptions);
  }

  before(
    seq: number,
    limit: number,
    requestOptions?: RequestOptions
  ): Promise<SessionEventSlice> {
    return this.readSlice({ kind: "before", limit, seq }, requestOptions);
  }

  after(
    seq: number,
    limit: number,
    requestOptions?: RequestOptions
  ): Promise<SessionEventSlice> {
    return this.readSlice({ kind: "after", limit, seq }, requestOptions);
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
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "append" | "gap" | "error",
    listener:
      | SessionEventListener
      | SessionAppendListener
      | SessionGapListener
      | ((error: Error) => void),
    options?: SessionOnEventOptions
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      if (!this.eventSubscriptions.has(eventListener)) {
        const eventOptions = options as SessionOnEventOptions | undefined;
        const replay = eventOptions?.replay ?? false;

        const dispatch = (
          event: TailEvent,
          logContext: SessionLogSubscriptionContext
        ): void => {
          const parsedEvent = this.parseOnEvent(event, eventOptions);
          if (!parsedEvent) {
            return;
          }

          const classifiedContext: SessionEventContext = {
            phase: logContext.replayed ? "replay" : "live",
          };

          try {
            this.observeListenerResult(
              eventListener(parsedEvent, classifiedContext)
            );
          } catch (error) {
            this.emitStreamError(error);
          }
        };

        const unsubscribe = this.log.subscribe(dispatch, { replay });
        this.eventSubscriptions.set(eventListener, unsubscribe);
      }

      this.ensureChannelAttached();

      return () => {
        this.off("event", eventListener);
      };
    }

    if (eventName === "append") {
      const appendListener = listener as SessionAppendListener;
      this.lifecycle.on("append", appendListener);
      return () => {
        this.off("append", appendListener);
      };
    }

    if (eventName === "gap") {
      const gapListener = listener as SessionGapListener;
      this.lifecycle.on("gap", gapListener);
      this.ensureChannelAttached();
      return () => {
        this.off("gap", gapListener);
      };
    }

    if (eventName === "error") {
      const errorListener = listener as (error: Error) => void;
      this.lifecycle.on("error", errorListener);
      return () => {
        this.off("error", errorListener);
      };
    }

    throw new StarciteError(`Unsupported event name '${eventName}'`);
  }

  /**
   * Removes a previously registered listener.
   */
  off(eventName: "event", listener: SessionEventListener): void;
  off(eventName: "append", listener: SessionAppendListener): void;
  off(eventName: "gap", listener: SessionGapListener): void;
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "event" | "append" | "gap" | "error",
    listener:
      | SessionEventListener
      | SessionAppendListener
      | SessionGapListener
      | ((error: Error) => void)
  ): void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      const unsubscribe = this.eventSubscriptions.get(eventListener);
      if (!unsubscribe) {
        return;
      }

      this.eventSubscriptions.delete(eventListener);
      unsubscribe();

      this.detachTailChannelIfIdle();
      return;
    }

    if (eventName === "append") {
      this.lifecycle.off("append", listener as SessionAppendListener);
      return;
    }

    if (eventName === "gap") {
      this.lifecycle.off("gap", listener as SessionGapListener);
      this.detachTailChannelIfIdle();
      return;
    }

    if (eventName === "error") {
      this.lifecycle.off("error", listener as (error: Error) => void);
      return;
    }

    throw new StarciteError(`Unsupported event name '${eventName}'`);
  }

  /**
   * Stops tailing and removes listeners registered via `on()`.
   */
  disconnect(): void {
    this.keepTailAttached = false;
    this.outbox.stop();
    for (const unsubscribe of this.eventSubscriptions.values()) {
      unsubscribe();
    }
    this.eventSubscriptions.clear();
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
   * Returns a stable view of the current canonical in-memory log state.
   */
  state(): SessionSnapshot {
    return {
      ...this.log.state(this.tailChannel !== undefined),
      append: this.outbox.state(),
    };
  }

  /**
   * Fetches the complete durable session history.
   *
   * @deprecated Use `all()` instead.
   */
  events(requestOptions?: RequestOptions): Promise<SessionEventSlice> {
    return this.all(requestOptions);
  }

  private async readSlice(
    read: SessionEventsRead,
    requestOptions?: RequestOptions
  ): Promise<SessionEventSlice> {
    return toSessionEventSlice(
      read,
      await this.readEvents(read, requestOptions)
    );
  }

  private async readEvents(
    read: SessionEventsRead,
    requestOptions?: RequestOptions
  ) {
    const response = await request(
      this.transport,
      `/sessions/${this.id}/events${toSessionEventsQuerySuffix(read)}`,
      {
        method: "GET",
        signal: requestOptions?.signal,
      },
      sessionEventsResponseSchema()
    );

    this.log.observeRead(response);
    this.outbox.reconcileWithCommittedEvents(
      response.events,
      response.last_seq
    );
    this.persistCacheEntry();
    this.reconcileChannelAttachment();
    return response;
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

  private shouldKeepChannelAttached(): boolean {
    return (
      this.keepTailAttached ||
      this.outbox.pendingCount > 0 ||
      this.eventSubscriptions.size > 0 ||
      this.lifecycle.listenerCount("gap") > 0
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
      this.tailChannel ||
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
    this.closeTailChannel = managedChannel.close;
    this.tailChannel = channel;

    this.tailEventBindingRef = channel.on("events", (payload) => {
      const result = TailEventsPayloadSchema.safeParse(payload);
      if (!result.success) {
        return;
      }

      try {
        const appliedEvents = this.log.applyBatch(result.data.events);
        if (appliedEvents.length > 0) {
          this.outbox.reconcileWithCommittedEvents(
            appliedEvents,
            this.log.lastSeq
          );
          this.persistCacheEntry();
        }
      } catch (error) {
        this.emitStreamError(error);
      }
    });

    this.tailGapBindingRef = channel.on("gap", (payload) => {
      const result = TailGapSchema.safeParse(payload);
      if (!result.success) {
        return;
      }

      this.log.advanceCursor(result.data.next_cursor);
      this.persistCacheEntry();

      if (this.lifecycle.listenerCount("gap") > 0) {
        this.lifecycle.emit("gap", result.data);
      }

      channel.rejoin();
    });

    this.tailTokenExpiredBindingRef = channel.on("token_expired", (payload) => {
      const result = TailTokenExpiredPayloadSchema.safeParse(payload);
      if (!result.success) {
        return;
      }

      const error = new StarciteTokenExpiredError(
        `Tail token expired for session '${this.id}'. Re-issue a session token and reconnect from the last processed cursor.`,
        {
          closeReason: result.data.reason,
          sessionId: this.id,
        }
      );
      this.detachTailChannel();
      this.refreshAuthInternal("token_expired", error, {
        emitFailure: true,
      }).catch(() => undefined);
    });

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
    if (this.tailChannel) {
      this.tailChannel.off("events", this.tailEventBindingRef);
      this.tailChannel.off("gap", this.tailGapBindingRef);
      this.tailChannel.off("token_expired", this.tailTokenExpiredBindingRef);
      this.tailChannel = undefined;
    }

    this.tailEventBindingRef = 0;
    this.tailGapBindingRef = 0;
    this.tailTokenExpiredBindingRef = 0;
    this.closeTailChannel?.();
    this.closeTailChannel = undefined;
  }

  private tailChannelParams(): Record<string, unknown> {
    if (this.log.cursor !== undefined) {
      return { cursor: this.log.cursor };
    }

    if (this.keepTailAttached) {
      return { cursor: 0 };
    }

    return { live_only: true };
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
    if (error instanceof Error) {
      return error;
    }

    return new StarciteError(String(error));
  }

  private readCachedEntry(): SessionCacheEntry | undefined {
    if (!this.cache) {
      return undefined;
    }

    try {
      return this.cache.read(this.id);
    } catch {
      return undefined;
    }
  }

  private restoreCachedState(
    cachedEntry: SessionCacheEntry | undefined
  ): boolean {
    if (cachedEntry === undefined) {
      return true;
    }

    try {
      if (cachedEntry.log) {
        this.log.restore(cachedEntry.log);
      }
      return true;
    } catch {
      this.clearCachedState();
      return false;
    }
  }

  private persistCacheEntry(): void {
    if (!this.cache) {
      return;
    }

    try {
      this.cache.write(this.id, {
        log: this.log.checkpoint(),
        outbox: this.outbox.serializeState(),
        metadata: {
          schemaVersion: 6,
          cachedAtMs: Date.now(),
        },
      });
    } catch (error) {
      const cacheError = new StarciteError(
        `Session cache write failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
      );

      if (this.lifecycle.listenerCount("error") > 0) {
        this.lifecycle.emit("error", cacheError);
      }
    }
  }

  private clearCachedState(): void {
    try {
      this.cache?.clear?.(this.id);
    } catch {
      // Ignore cache-clear failures; the live stream can still recover state.
    }
  }
}
