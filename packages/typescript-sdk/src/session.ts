import EventEmitter from "eventemitter3";
import type { Channel } from "phoenix";
import { z } from "zod";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
import type { StarciteIdentity } from "./identity";
import {
  SessionLog,
  type SessionLogSubscriptionContext,
} from "./session-log";
import type { TransportConfig } from "./transport";
import { request } from "./transport";
import type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  RequestOptions,
  SessionAppendFailureSnapshot,
  SessionAppendInput,
  SessionAppendLifecycleEvent,
  SessionAppendListener,
  SessionAppendOptions,
  SessionAppendQueueState,
  SessionAppendStoreState,
  SessionEvent,
  SessionEventContext,
  SessionEventListener,
  SessionGapListener,
  SessionLogOptions,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionStoreState,
  TailCursor,
  TailGap,
} from "./types";
import {
  AppendEventResponseSchema,
  SessionAppendInputSchema,
  TailEventSchema,
  TailGapSchema,
  TailTokenExpiredPayloadSchema,
} from "./types";

/**
 * Construction options for a `StarciteSession`.
 */
export interface StarciteSessionOptions {
  id: string;
  token: string;
  identity: StarciteIdentity;
  transport: TransportConfig;
  store?: SessionStore;
  record?: SessionRecord;
  logOptions?: SessionLogOptions;
  appendOptions?: SessionAppendOptions;
}

interface SessionLifecycleEvents {
  error: (error: Error) => void;
  append: (event: SessionAppendLifecycleEvent) => void;
  gap: (gap: TailGap) => void;
}

interface RejoinableChannel extends Channel {
  rejoin: (timeout?: number) => void;
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface RuntimeAppendQueueItem {
  id: string;
  request: AppendEventRequest;
  enqueuedAtMs: number;
  retryAttempt: number;
  signal?: AbortSignal;
  deferred?: Deferred<AppendEventResponse>;
}

interface ResolvedSessionAppendRetryPolicy {
  mode: "fixed" | "exponential";
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
  maxAttempts: number;
}

interface ResolvedSessionAppendOptions {
  retryPolicy: ResolvedSessionAppendRetryPolicy;
  persist: boolean;
  autoFlush: boolean;
  terminalFailureMode: "pause" | "clear";
}

const APPEND_RETRY_INITIAL_DELAY_MS = 250;
const APPEND_RETRY_MAX_DELAY_MS = 5000;
const APPEND_RETRY_MULTIPLIER = 2;
const APPEND_RETRY_JITTER_RATIO = 0;
const RETRYABLE_APPEND_STATUS_CODES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);
const TailEventsPayloadSchema = z.object({
  events: z.array(TailEventSchema),
});

function readJoinFailureReason(payload: unknown): string {
  if (payload instanceof Error) {
    return payload.message;
  }

  if (typeof payload === "string") {
    return payload;
  }

  if (typeof payload === "object" && payload !== null) {
    if ("reason" in payload && typeof payload.reason === "string") {
      return payload.reason;
    }

    if ("message" in payload && typeof payload.message === "string") {
      return payload.message;
    }
  }

  return "join failed";
}

function calculateAppendRetryDelay(
  retryAttempt: number,
  policy: ResolvedSessionAppendRetryPolicy
): number {
  const exponent = policy.mode === "fixed" ? 0 : Math.max(0, retryAttempt - 1);
  const baseDelayMs = Math.min(
    policy.initialDelayMs * policy.multiplier ** exponent,
    policy.maxDelayMs
  );

  if (policy.jitterRatio === 0) {
    return baseDelayMs;
  }

  const jitterWindowMs = Math.round(baseDelayMs * policy.jitterRatio);
  const minimumDelayMs = Math.max(0, baseDelayMs - jitterWindowMs);
  const maximumDelayMs = baseDelayMs + jitterWindowMs;
  return Math.round(
    minimumDelayMs + Math.random() * (maximumDelayMs - minimumDelayMs)
  );
}

function createLinkedAbortController(
  signals: readonly (AbortSignal | undefined)[]
): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  for (const signal of signals) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    const abort = () => {
      controller.abort(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => {
      signal.removeEventListener("abort", abort);
    });
  }

  return {
    controller,
    detach: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

function createAppendAbortError(sessionId: string): StarciteError {
  return new StarciteError(
    `append() aborted for session '${sessionId}' before the request could be sent`
  );
}

/**
 * Session-scoped client bound to a specific identity and session token.
 *
 * All operations use the session token for auth, not the parent client's API key.
 */
export class StarciteSession {
  /** Session identifier. */
  readonly id: string;
  /** The session JWT used for auth. Extract this for frontend handoff. */
  readonly token: string;
  /** Identity bound to this session. */
  readonly identity: StarciteIdentity;
  /** Optional session record captured at creation time. */
  readonly record?: SessionRecord;

  private readonly transport: TransportConfig;
  private readonly appendOptions: ResolvedSessionAppendOptions;
  private appendProducerId: string;
  private appendLastAcknowledgedProducerSeq = 0;
  private readonly appendQueue: RuntimeAppendQueueItem[] = [];
  private appendQueueTask: Promise<void> | undefined;
  private appendQueueRunController: AbortController | undefined;
  private appendQueueVersion = 0;
  private appendQueueStatus: SessionAppendQueueState["status"] = "idle";
  private appendInFlightItemId: string | undefined;
  private appendRetryAttempt = 0;
  private appendNextRetryAtMs: number | undefined;
  private appendLastFailure: SessionAppendFailureSnapshot | undefined;

  readonly log: SessionLog;
  private readonly store: SessionStore | undefined;
  private readonly lifecycle = new EventEmitter<SessionLifecycleEvents>();
  private readonly eventSubscriptions = new Map<
    SessionEventListener,
    () => void
  >();
  private keepTailAttached = true;
  private tailChannel: RejoinableChannel | undefined;
  private tailEventBindingRef = 0;
  private tailGapBindingRef = 0;
  private tailTokenExpiredBindingRef = 0;
  private closeTailChannel: (() => void) | undefined;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.token = options.token;
    this.identity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
    this.store = options.store;
    const retryPolicy = options.appendOptions?.retryPolicy;
    this.appendOptions = {
      retryPolicy: {
        mode: retryPolicy?.mode ?? "exponential",
        initialDelayMs:
          retryPolicy?.initialDelayMs ?? APPEND_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: retryPolicy?.maxDelayMs ?? APPEND_RETRY_MAX_DELAY_MS,
        multiplier: retryPolicy?.multiplier ?? APPEND_RETRY_MULTIPLIER,
        jitterRatio: retryPolicy?.jitterRatio ?? APPEND_RETRY_JITTER_RATIO,
        maxAttempts: retryPolicy?.maxAttempts ?? Number.POSITIVE_INFINITY,
      },
      persist:
        this.store !== undefined && (options.appendOptions?.persist ?? true),
      autoFlush: options.appendOptions?.autoFlush ?? true,
      terminalFailureMode:
        options.appendOptions?.terminalFailureMode ?? "pause",
    };
    this.appendProducerId = crypto.randomUUID();
    this.log = new SessionLog(options.logOptions);

    const storedState = this.loadPersistedState();
    if (this.restorePersistedLogState(storedState)) {
      this.restorePersistedAppendState(storedState);
    }

    if (
      this.appendOptions.autoFlush &&
      this.appendQueueStatus !== "paused" &&
      this.appendQueue.length > 0
    ) {
      this.ensureAppendQueueProcessing();
    }

    this.ensureChannelAttached();
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
    const parsed = SessionAppendInputSchema.parse(input);
    const itemId = crypto.randomUUID();

    return this.enqueueAppend({
      id: itemId,
      request: {
        type: parsed.type ?? "content",
        payload: parsed.payload ?? { text: parsed.text },
        actor: parsed.actor,
        producer_id: this.appendProducerId,
        producer_seq: this.nextManagedProducerSeq(),
        source: parsed.source ?? "agent",
        metadata: parsed.metadata,
        refs: parsed.refs,
        idempotency_key: parsed.idempotencyKey ?? itemId,
        expected_seq: parsed.expectedSeq,
      },
      enqueuedAtMs: Date.now(),
      retryAttempt: 0,
      signal: options?.signal,
    }).then((result) => {
      return {
        seq: result.seq,
        deduped: result.deduped,
      };
    });
  }

  /**
   * Subscribes to canonical session events and lifecycle errors.
   */
  on(eventName: "event", listener: SessionEventListener): () => void;
  on<TEvent extends SessionEvent>(
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
        const replay = eventOptions?.replay ?? true;

        const dispatch = (
          event: SessionEvent,
          logContext: SessionLogSubscriptionContext
        ): void => {
          const parsedEvent = this.parseOnEvent(event, eventOptions);
          if (!parsedEvent) {
            return;
          }

          const classifiedContext: SessionEventContext = logContext.replayed
            ? { phase: "replay", replayed: true }
            : { phase: "live", replayed: false };

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
    for (const unsubscribe of this.eventSubscriptions.values()) {
      unsubscribe();
    }
    this.eventSubscriptions.clear();
    this.detachTailChannel();
    this.lifecycle.removeAllListeners();
  }

  /**
   * Backwards-compatible alias for `disconnect()`.
   */
  close(): void {
    this.disconnect();
  }

  /**
   * Updates in-memory session log retention.
   */
  setLogOptions(options: SessionLogOptions): void {
    this.log.setMaxEvents(options.maxEvents);
    this.persistLogState();
  }

  /**
   * Returns the current append queue state.
   */
  appendState(): SessionAppendQueueState {
    return this.snapshotAppendQueueState();
  }

  /**
   * Resumes a paused queue or starts a restored queue that was loaded with `autoFlush=false`.
   */
  resumeAppendQueue(): void {
    if (this.appendQueue.length === 0) {
      return;
    }

    for (const item of this.appendQueue) {
      item.retryAttempt = 0;
    }

    this.appendQueueStatus = "idle";
    this.appendRetryAttempt = 0;
    this.appendNextRetryAtMs = undefined;
    this.appendLastFailure = undefined;
    this.persistLogState();
    this.emitAppendLifecycle({
      type: "resumed",
      sessionId: this.id,
      queue: this.snapshotAppendQueueState(),
    });
    this.ensureAppendQueueProcessing();
  }

  /**
   * Clears the append queue and rotates the managed producer identity.
   */
  resetAppendQueue(): void {
    const rejection = new StarciteError(
      `append queue reset for session '${this.id}' before pending items could be acknowledged`
    );

    this.clearAppendQueue(rejection, {
      rotateProducer: true,
      lastFailure: undefined,
    });
    this.emitAppendLifecycle({
      type: "reset",
      sessionId: this.id,
      queue: this.snapshotAppendQueueState(),
    });
  }

  /**
   * Returns a stable view of the current canonical in-memory log state.
   */
  state(): SessionSnapshot {
    return this.log.state(this.tailChannel !== undefined);
  }

  /**
   * Returns the retained canonical event list.
   */
  events(): readonly SessionEvent[] {
    return this.log.events;
  }

  private parseOnEvent<TEvent extends SessionEvent>(
    event: SessionEvent,
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
      this.eventSubscriptions.size > 0 ||
      this.lifecycle.listenerCount("gap") > 0
    );
  }

  private ensureChannelAttached(): void {
    if (this.tailChannel || !this.shouldKeepChannelAttached()) {
      return;
    }

    const managedChannel =
      this.transport.socketManager.openChannel<RejoinableChannel>({
        topic: `tail:${this.id}`,
        params: () => {
          const payload: {
            cursor?: TailCursor;
          } = {};

          if (this.log.cursor) {
            payload.cursor = this.log.cursor;
          }

          return payload;
        },
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
          this.persistLogState();
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
      this.persistLogState();

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

      this.detachTailChannel();
      const error = new StarciteTokenExpiredError(
        `Tail token expired for session '${this.id}'. Re-issue a session token and reconnect from the last processed cursor.`,
        {
          closeReason: result.data.reason,
          sessionId: this.id,
        }
      );
      this.emitStreamError(error);
    });

    channel
      .join()
      .receive("error", (payload) => {
        const error = new StarciteTailError(
          `Tail connection failed for session '${this.id}': ${readJoinFailureReason(payload)}`,
          {
            sessionId: this.id,
            stage: "connect",
          }
        );
        this.emitStreamError(error);
      })
      .receive("timeout", () => {
        const error = new StarciteTailError(
          `Tail connection failed for session '${this.id}': join timeout`,
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

  private loadPersistedState(): SessionStoreState | undefined {
    if (!this.store) {
      return undefined;
    }

    try {
      return this.store.load(this.id);
    } catch {
      return undefined;
    }
  }

  private restorePersistedLogState(
    storedState: SessionStoreState | undefined
  ): boolean {
    if (storedState === undefined) {
      return true;
    }

    try {
      this.log.hydrate(storedState);
      return true;
    } catch {
      this.clearPersistedLogState();
      return false;
    }
  }

  private restorePersistedAppendState(
    storedState: SessionStoreState | undefined
  ): void {
    const storedAppendState = storedState?.append;
    if (!(storedAppendState && this.appendOptions.persist)) {
      return;
    }

    this.appendProducerId = storedAppendState.producerId;
    this.appendLastAcknowledgedProducerSeq =
      storedAppendState.lastAcknowledgedProducerSeq;
    this.appendQueue.length = 0;

    for (const pending of storedAppendState.pending) {
      this.appendQueue.push({
        id: pending.id,
        request: structuredClone(pending.request) as AppendEventRequest,
        enqueuedAtMs: pending.enqueuedAtMs,
        retryAttempt: pending.retryAttempt ?? 0,
      });
    }

    this.appendInFlightItemId = undefined;
    this.appendNextRetryAtMs = undefined;
    this.appendRetryAttempt = this.appendQueue[0]?.retryAttempt ?? 0;
    this.appendLastFailure = storedAppendState.lastFailure
      ? { ...storedAppendState.lastFailure }
      : undefined;

    if (this.appendQueue.length === 0) {
      this.appendQueueStatus = "idle";
      return;
    }

    if (
      storedAppendState.status === "paused" ||
      !this.appendOptions.autoFlush
    ) {
      this.appendQueueStatus = "paused";
      return;
    }

    this.appendQueueStatus = "idle";
  }

  private persistLogState(): void {
    if (!this.store) {
      return;
    }

    try {
      this.store.save(this.id, {
        cursor: this.log.cursor,
        lastSeq: this.log.lastSeq,
        events: [...this.log.events],
        append: this.serializeAppendStoreState(),
        metadata: {
          schemaVersion: 4,
          updatedAtMs: Date.now(),
        },
      });
    } catch (error) {
      const storeError =
        error instanceof Error
          ? new StarciteError(
              `Session store save failed for session '${this.id}': ${error.message}`
            )
          : new StarciteError(
              `Session store save failed for session '${this.id}': ${String(error)}`
            );

      if (this.lifecycle.listenerCount("error") > 0) {
        this.lifecycle.emit("error", storeError);
      }
    }
  }

  private serializeAppendStoreState(): SessionAppendStoreState | undefined {
    if (!this.appendOptions.persist) {
      return undefined;
    }

    return {
      producerId: this.appendProducerId,
      lastAcknowledgedProducerSeq: this.appendLastAcknowledgedProducerSeq,
      pending: this.appendQueue.map((item) => {
        return {
          id: item.id,
          request: structuredClone(item.request) as AppendEventRequest,
          enqueuedAtMs: item.enqueuedAtMs,
          retryAttempt: item.retryAttempt,
        };
      }),
      status: this.appendQueueStatus === "paused" ? "paused" : "idle",
      lastFailure: this.appendLastFailure
        ? { ...this.appendLastFailure }
        : undefined,
    };
  }

  private clearPersistedLogState(): void {
    try {
      this.store?.clear?.(this.id);
    } catch {
      // Ignore cache-clear failures; the live stream can still recover state.
    }
  }

  private nextManagedProducerSeq(): number {
    let highestProducerSeq = this.appendLastAcknowledgedProducerSeq;

    for (const item of this.appendQueue) {
      if (
        item.request.producer_id === this.appendProducerId &&
        item.request.producer_seq > highestProducerSeq
      ) {
        highestProducerSeq = item.request.producer_seq;
      }
    }

    return highestProducerSeq + 1;
  }

  private enqueueAppend(
    item: RuntimeAppendQueueItem
  ): Promise<AppendEventResponse> {
    if (item.signal?.aborted) {
      return Promise.reject(createAppendAbortError(this.id));
    }

    const wasEmpty = this.appendQueue.length === 0;
    const promise = new Promise<AppendEventResponse>((resolve, reject) => {
      item.deferred = { resolve, reject };
    });

    this.appendQueue.push(item);
    if (wasEmpty && this.appendQueueStatus === "idle") {
      this.appendRetryAttempt = 0;
      this.appendNextRetryAtMs = undefined;
      this.appendLastFailure = undefined;
    }

    this.persistLogState();
    this.emitAppendLifecycle({
      type: "queued",
      sessionId: this.id,
      item: this.snapshotPendingAppend(item),
      queue: this.snapshotAppendQueueState(),
    });

    if (this.appendQueueStatus !== "paused" && this.appendOptions.autoFlush) {
      this.ensureAppendQueueProcessing();
    }

    return promise;
  }

  private ensureAppendQueueProcessing(): void {
    if (
      this.appendQueueTask ||
      this.appendQueueStatus === "paused" ||
      this.appendQueue.length === 0
    ) {
      return;
    }

    const runId = ++this.appendQueueVersion;
    const controller = new AbortController();
    this.appendQueueRunController = controller;

    const task = this.runAppendQueue(runId, controller.signal).finally(() => {
      if (this.appendQueueTask === task) {
        this.appendQueueTask = undefined;
      }
      if (this.appendQueueRunController === controller) {
        this.appendQueueRunController = undefined;
      }
      if (this.appendQueue.length > 0 && this.appendQueueStatus !== "paused") {
        this.ensureAppendQueueProcessing();
      }
    });

    this.appendQueueTask = task;
  }

  private async runAppendQueue(
    runId: number,
    runSignal: AbortSignal
  ): Promise<void> {
    while (!runSignal.aborted && runId === this.appendQueueVersion) {
      if (this.appendQueueStatus === "paused") {
        return;
      }

      const head = this.appendQueue[0];
      if (!head) {
        this.appendQueueStatus = "idle";
        this.appendInFlightItemId = undefined;
        this.appendRetryAttempt = 0;
        this.appendNextRetryAtMs = undefined;
        this.persistLogState();
        return;
      }

      const shouldContinue = await this.processAppendQueueHead(
        head,
        runId,
        runSignal
      );
      if (!shouldContinue) {
        return;
      }
    }
  }

  private async processAppendQueueHead(
    item: RuntimeAppendQueueItem,
    runId: number,
    runSignal: AbortSignal
  ): Promise<boolean> {
    if (item.signal?.aborted) {
      this.handleTerminalAppendFailure(item, createAppendAbortError(this.id));
      return false;
    }

    this.appendQueueStatus = "flushing";
    this.appendInFlightItemId = item.id;
    this.appendRetryAttempt = item.retryAttempt;
    this.appendNextRetryAtMs = undefined;
    this.persistLogState();
    this.emitAppendLifecycle({
      type: "attempt_started",
      sessionId: this.id,
      itemId: item.id,
      attempt: item.retryAttempt + 1,
      queue: this.snapshotAppendQueueState(),
    });

    const { controller, detach } = createLinkedAbortController([
      item.signal,
      runSignal,
    ]);

    try {
      const response = await request(
        this.transport,
        `/sessions/${encodeURIComponent(this.id)}/append`,
        {
          method: "POST",
          body: JSON.stringify(item.request),
          signal: controller.signal,
        },
        AppendEventResponseSchema
      );

      if (
        runSignal.aborted ||
        runId !== this.appendQueueVersion ||
        this.appendQueue[0]?.id !== item.id
      ) {
        return false;
      }

      this.handleAcknowledgedAppend(item, response);
      return true;
    } catch (error) {
      if (
        runSignal.aborted ||
        runId !== this.appendQueueVersion ||
        this.appendQueue[0]?.id !== item.id
      ) {
        return false;
      }

      if (item.signal?.aborted) {
        this.handleTerminalAppendFailure(item, createAppendAbortError(this.id));
        return false;
      }

      const retryable = this.isRetryableAppendError(error);
      const nextRetryAttempt = item.retryAttempt + 1;
      if (
        retryable &&
        nextRetryAttempt <= this.appendOptions.retryPolicy.maxAttempts
      ) {
        const failure = this.snapshotAppendFailure(error, true, false);
        item.retryAttempt = nextRetryAttempt;
        this.appendQueueStatus = "retrying";
        this.appendRetryAttempt = item.retryAttempt;
        const delayMs = calculateAppendRetryDelay(
          item.retryAttempt,
          this.appendOptions.retryPolicy
        );
        this.appendNextRetryAtMs = Date.now() + delayMs;
        this.appendLastFailure = failure;
        this.persistLogState();
        this.emitAppendLifecycle({
          type: "retry_scheduled",
          sessionId: this.id,
          itemId: item.id,
          attempt: item.retryAttempt + 1,
          delayMs,
          failure,
          queue: this.snapshotAppendQueueState(),
        });

        await this.waitForAppendRetry(delayMs, item.signal, runSignal);
        return !runSignal.aborted && runId === this.appendQueueVersion;
      }

      const terminalFailure = this.snapshotAppendFailure(
        error,
        retryable,
        true
      );
      this.handleTerminalAppendFailure(
        item,
        this.toError(error),
        terminalFailure
      );
      return false;
    } finally {
      detach();
    }
  }

  private handleAcknowledgedAppend(
    item: RuntimeAppendQueueItem,
    response: AppendEventResponse
  ): void {
    this.appendQueue.shift();
    this.appendInFlightItemId = undefined;
    this.appendRetryAttempt = 0;
    this.appendNextRetryAtMs = undefined;
    this.appendLastFailure = undefined;
    this.appendQueueStatus = this.appendQueue.length > 0 ? "idle" : "idle";

    if (item.request.producer_id === this.appendProducerId) {
      this.appendLastAcknowledgedProducerSeq = Math.max(
        this.appendLastAcknowledgedProducerSeq,
        item.request.producer_seq
      );
    }

    this.persistLogState();
    item.deferred?.resolve(response);
    this.emitAppendLifecycle({
      type: "acknowledged",
      sessionId: this.id,
      itemId: item.id,
      seq: response.seq,
      deduped: response.deduped,
      queue: this.snapshotAppendQueueState(),
    });
  }

  private handleTerminalAppendFailure(
    item: RuntimeAppendQueueItem,
    error: Error,
    failure = this.snapshotAppendFailure(error, false, true)
  ): void {
    item.deferred?.reject(error);

    if (this.appendOptions.terminalFailureMode === "clear") {
      this.clearAppendQueue(error, {
        rotateProducer: true,
        lastFailure: failure,
      });
      this.emitAppendLifecycle({
        type: "cleared",
        sessionId: this.id,
        itemId: item.id,
        failure,
        queue: this.snapshotAppendQueueState(),
      });
      return;
    }

    this.appendQueueStatus = "paused";
    this.appendInFlightItemId = undefined;
    this.appendRetryAttempt = item.retryAttempt;
    this.appendNextRetryAtMs = undefined;
    this.appendLastFailure = failure;
    this.persistLogState();
    this.emitAppendLifecycle({
      type: "paused",
      sessionId: this.id,
      itemId: item.id,
      failure,
      queue: this.snapshotAppendQueueState(),
    });
  }

  private clearAppendQueue(
    reason: Error,
    options: {
      rotateProducer: boolean;
      lastFailure: SessionAppendFailureSnapshot | undefined;
    }
  ): void {
    this.appendQueueVersion += 1;
    this.appendQueueRunController?.abort();

    const pendingItems = [...this.appendQueue];
    this.appendQueue.length = 0;
    this.appendQueueStatus = "idle";
    this.appendInFlightItemId = undefined;
    this.appendRetryAttempt = 0;
    this.appendNextRetryAtMs = undefined;
    this.appendLastFailure = options.lastFailure;

    if (options.rotateProducer) {
      this.appendProducerId = crypto.randomUUID();
      this.appendLastAcknowledgedProducerSeq = 0;
    }

    for (const pending of pendingItems) {
      pending.deferred?.reject(reason);
    }

    this.persistLogState();
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new StarciteError(String(error));
  }

  private snapshotAppendFailure(
    error: unknown,
    retryable: boolean,
    terminal: boolean
  ): SessionAppendFailureSnapshot {
    if (error instanceof StarciteApiError) {
      return {
        name: error.name,
        message: error.message,
        retryable,
        terminal,
        occurredAtMs: Date.now(),
        status: error.status,
        code: error.code,
      };
    }

    const appendError = this.toError(error);
    return {
      name: appendError.name,
      message: appendError.message,
      retryable,
      terminal,
      occurredAtMs: Date.now(),
    };
  }

  private snapshotPendingAppend(item: RuntimeAppendQueueItem) {
    return {
      id: item.id,
      request: structuredClone(item.request) as AppendEventRequest,
      enqueuedAtMs: item.enqueuedAtMs,
      retryAttempt: item.retryAttempt,
    };
  }

  private snapshotAppendQueueState(): SessionAppendQueueState {
    return {
      status: this.appendQueueStatus,
      producerId: this.appendProducerId,
      lastAcknowledgedProducerSeq: this.appendLastAcknowledgedProducerSeq,
      pending: this.appendQueue.map((item) => this.snapshotPendingAppend(item)),
      inFlightItemId: this.appendInFlightItemId,
      retryAttempt: this.appendRetryAttempt || undefined,
      nextRetryAtMs: this.appendNextRetryAtMs,
      lastFailure: this.appendLastFailure
        ? { ...this.appendLastFailure }
        : undefined,
    };
  }

  private emitAppendLifecycle(event: SessionAppendLifecycleEvent): void {
    const listeners = this.lifecycle.listeners(
      "append"
    ) as SessionAppendListener[];

    for (const listener of listeners) {
      try {
        this.observeListenerResult(listener(event));
      } catch (error) {
        this.emitStreamError(error);
      }
    }
  }

  private isRetryableAppendError(error: unknown): boolean {
    if (error instanceof StarciteConnectionError) {
      return true;
    }

    return (
      error instanceof StarciteApiError &&
      RETRYABLE_APPEND_STATUS_CODES.has(error.status)
    );
  }

  private waitForAppendRetry(
    delayMs: number,
    itemSignal: AbortSignal | undefined,
    runSignal: AbortSignal
  ): Promise<void> {
    if (delayMs <= 0 || runSignal.aborted) {
      return Promise.resolve();
    }

    const { controller, detach } = createLinkedAbortController([
      itemSignal,
      runSignal,
    ]);
    if (controller.signal.aborted) {
      detach();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        detach();
        resolve();
      };

      const timer = setTimeout(() => {
        finish();
      }, delayMs);

      controller.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
