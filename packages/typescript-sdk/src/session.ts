import EventEmitter from "eventemitter3";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import type { StarciteIdentity } from "./identity";
import { SessionLog, SessionLogGapError } from "./session-log";
import { TailStream } from "./tail/stream";
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
  SessionTailItem,
  SessionTailIteratorOptions,
  TailCursor,
  TailGap,
} from "./types";
import { AppendEventResponseSchema, SessionAppendInputSchema } from "./types";

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

interface TailRuntime<TEvent extends SessionEvent> {
  next: () => Promise<SessionTailItem<TEvent> | undefined>;
  getFailure: () => unknown;
  dispose: () => Promise<void>;
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
  private liveSyncController: AbortController | undefined;
  private liveSyncTask: Promise<void> | undefined;
  private liveSyncCatchUpActive = false;

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
  }

  /**
   * Appends an event to this session.
   *
   * The SDK manages `actor`, `producer_id`, and `producer_seq` automatically.
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
        actor: parsed.actor ?? this.identity.toActor(),
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
        const replayCutoffSeq = replay ? this.log.lastSeq : -1;
        const schema = eventOptions?.schema;

        const dispatch = (event: SessionEvent): void => {
          const parsedEvent = this.parseOnEvent(event, schema);
          if (!parsedEvent) {
            return;
          }

          const classifiedContext = this.resolveEventContext(
            event.seq,
            replayCutoffSeq,
            this.liveSyncCatchUpActive
          );

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

      this.ensureLiveSync();
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
      this.ensureLiveSync();
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

      if (!this.shouldKeepLiveSync()) {
        this.liveSyncController?.abort();
      }
      return;
    }

    if (eventName === "append") {
      this.lifecycle.off("append", listener as SessionAppendListener);
      return;
    }

    if (eventName === "gap") {
      this.lifecycle.off("gap", listener as SessionGapListener);
      if (!this.shouldKeepLiveSync()) {
        this.liveSyncController?.abort();
      }
      return;
    }

    if (eventName === "error") {
      this.lifecycle.off("error", listener as (error: Error) => void);
      return;
    }

    throw new StarciteError(`Unsupported event name '${eventName}'`);
  }

  /**
   * Stops live syncing and removes listeners registered via `on()`.
   */
  disconnect(): void {
    this.liveSyncController?.abort();

    for (const unsubscribe of this.eventSubscriptions.values()) {
      unsubscribe();
    }
    this.eventSubscriptions.clear();
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
    return this.log.state(this.liveSyncTask !== undefined);
  }

  /**
   * Returns the retained canonical event list.
   */
  events(): readonly SessionEvent[] {
    return this.log.events;
  }

  /**
   * Streams canonical events as an async iterator.
   *
   * Replay semantics and schema validation mirror `session.on("event", ...)`.
   */
  tail<TEvent extends SessionEvent = SessionEvent>(
    options: SessionTailIteratorOptions<TEvent> = {}
  ): AsyncIterable<SessionTailItem<TEvent>> {
    const { replay = true, schema, ...tailOptions } = options;
    const replayCutoffSeq = replay ? this.log.lastSeq : -1;
    const startCursor = tailOptions.cursor ?? this.log.lastSeq;
    const session = this;

    const parseEvent = (event: SessionEvent): TEvent =>
      session.parseTailEvent(event, schema);

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<SessionTailItem<TEvent>> {
        if (replay) {
          for (const replayEvent of session.log.events) {
            yield {
              event: parseEvent(replayEvent),
              context: { phase: "replay", replayed: true },
            };
          }
        }
        yield* session.iterateLiveTail({
          parseEvent,
          replayCutoffSeq,
          startCursor,
          tailOptions,
        });
      },
    };
  }

  private parseOnEvent<TEvent extends SessionEvent>(
    event: SessionEvent,
    schema: SessionOnEventOptions<TEvent>["schema"] | undefined
  ): TEvent | undefined {
    if (!schema) {
      return event as TEvent;
    }

    try {
      return schema.parse(event);
    } catch (error) {
      this.emitStreamError(
        new StarciteError(
          `session.on("event") schema validation failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return undefined;
    }
  }

  private parseTailEvent<TEvent extends SessionEvent>(
    event: SessionEvent,
    schema: SessionTailIteratorOptions<TEvent>["schema"] | undefined
  ): TEvent {
    if (!schema) {
      return event as TEvent;
    }

    try {
      return schema.parse(event);
    } catch (error) {
      throw new StarciteError(
        `session.tail() schema validation failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private resolveEventContext(
    eventSeq: number,
    replayCutoffSeq: number,
    forceReplay = false
  ): SessionEventContext {
    const replayed = forceReplay || eventSeq <= replayCutoffSeq;
    return replayed
      ? { phase: "replay", replayed: true }
      : { phase: "live", replayed: false };
  }

  private observeListenerResult(result: void | Promise<void>): void {
    Promise.resolve(result).catch((error) => {
      this.emitStreamError(error);
    });
  }

  private createTailAbortController(outerSignal: AbortSignal | undefined): {
    controller: AbortController;
    detach: () => void;
  } {
    return createLinkedAbortController([outerSignal]);
  }

  private createTailRuntime<TEvent extends SessionEvent>({
    parseEvent,
    replayCutoffSeq,
    startCursor,
    tailOptions,
  }: {
    parseEvent: (event: SessionEvent) => TEvent;
    replayCutoffSeq: number;
    startCursor: TailCursor;
    tailOptions: Omit<SessionTailIteratorOptions<TEvent>, "schema" | "replay">;
  }): TailRuntime<TEvent> {
    const queue: SessionTailItem<TEvent>[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    const shouldApplyToLog = tailOptions.agent === undefined;

    const { controller, detach } = this.createTailAbortController(
      tailOptions.signal
    );
    const wake = () => {
      notify?.();
    };

    const streamTask = new TailStream({
      options: {
        ...tailOptions,
        cursor: startCursor,
        signal: controller.signal,
      },
      customWebSocketFactoryProvided:
        this.transport.customWebSocketFactoryProvided,
      sessionId: this.id,
      socketAuth: this.transport.socketAuth,
      socketManager: this.transport.tailSocketManager,
      socketUrl: `${this.transport.websocketBaseUrl}/socket`,
    })
      .subscribe((batch) => {
        const queuedEvents = shouldApplyToLog
          ? this.log.applyBatch(batch)
          : batch;
        if (shouldApplyToLog && queuedEvents.length > 0) {
          this.persistLogState();
        }

        for (const event of queuedEvents) {
          queue.push({
            event: parseEvent(event),
            context: this.resolveEventContext(event.seq, replayCutoffSeq),
          });
        }

        wake();
      })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        done = true;
        wake();
      });

    return {
      next: async () => {
        while (queue.length === 0 && !done && !failure) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = undefined;
        }

        return queue.shift();
      },
      getFailure: () => failure,
      dispose: async () => {
        controller.abort();
        detach();
        await streamTask;
      },
    };
  }

  private async *iterateLiveTail<TEvent extends SessionEvent>({
    parseEvent,
    replayCutoffSeq,
    startCursor,
    tailOptions,
  }: {
    parseEvent: (event: SessionEvent) => TEvent;
    replayCutoffSeq: number;
    startCursor: TailCursor;
    tailOptions: Omit<SessionTailIteratorOptions<TEvent>, "schema" | "replay">;
  }): AsyncGenerator<SessionTailItem<TEvent>> {
    const runtime = this.createTailRuntime({
      parseEvent,
      replayCutoffSeq,
      startCursor,
      tailOptions,
    });

    try {
      while (true) {
        const next = await runtime.next();
        if (next) {
          yield next;
          continue;
        }

        const failure = runtime.getFailure();
        if (failure) {
          throw failure;
        }

        return;
      }
    } finally {
      await runtime.dispose();
    }
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

  private shouldKeepLiveSync(): boolean {
    return (
      this.eventSubscriptions.size > 0 ||
      this.lifecycle.listenerCount("gap") > 0
    );
  }

  private ensureLiveSync(): void {
    if (this.liveSyncTask || !this.shouldKeepLiveSync()) {
      return;
    }

    const controller = new AbortController();
    this.liveSyncController = controller;

    this.liveSyncTask = this.runLiveSync(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.emitStreamError(error);
        }
      })
      .finally(() => {
        this.liveSyncTask = undefined;
        this.liveSyncController = undefined;
        if (this.shouldKeepLiveSync()) {
          this.ensureLiveSync();
        }
      });
  }

  private async runLiveSync(signal: AbortSignal): Promise<void> {
    let shouldRunCatchUpPass = this.log.lastSeq === 0;
    let retryDelayMs = 250;

    while (!signal.aborted && this.shouldKeepLiveSync()) {
      this.liveSyncCatchUpActive = shouldRunCatchUpPass;

      try {
        await this.subscribeLiveSyncPass(signal, !shouldRunCatchUpPass);
        shouldRunCatchUpPass = false;
        retryDelayMs = 250;
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        if (error instanceof SessionLogGapError) {
          shouldRunCatchUpPass = true;
          continue;
        }

        this.emitStreamError(error);
        shouldRunCatchUpPass = true;
        await this.waitForLiveSyncRetry(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 5000);
      } finally {
        this.liveSyncCatchUpActive = false;
      }
    }
  }

  private async subscribeLiveSyncPass(
    signal: AbortSignal,
    follow: boolean
  ): Promise<void> {
    const stream = new TailStream({
      options: {
        cursor: this.log.lastSeq,
        follow,
        onGap: (gap) => {
          if (this.lifecycle.listenerCount("gap") > 0) {
            this.lifecycle.emit("gap", gap);
          }
        },
        signal,
      },
      customWebSocketFactoryProvided:
        this.transport.customWebSocketFactoryProvided,
      sessionId: this.id,
      socketAuth: this.transport.socketAuth,
      socketManager: this.transport.tailSocketManager,
      socketUrl: `${this.transport.websocketBaseUrl}/socket`,
    });

    await stream.subscribe((batch) => {
      const appliedEvents = this.log.applyBatch(batch);
      if (appliedEvents.length > 0) {
        this.persistLogState();
      }
    });
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
        events: [...this.log.events],
        append: this.serializeAppendStoreState(),
        metadata: {
          schemaVersion: 2,
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

  private waitForLiveSyncRetry(
    delayMs: number,
    signal: AbortSignal
  ): Promise<void> {
    if (delayMs <= 0 || signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
