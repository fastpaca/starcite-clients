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
  SessionAppendInput,
  SessionEvent,
  SessionEventContext,
  SessionEventListener,
  SessionLogOptions,
  SessionOnEventOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTailItem,
  SessionTailIteratorOptions,
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
}

interface SessionLifecycleEvents {
  error: (error: Error) => void;
}

interface TailRuntime<TEvent extends SessionEvent> {
  next: () => Promise<SessionTailItem<TEvent> | undefined>;
  getFailure: () => unknown;
  dispose: () => Promise<void>;
}

const APPEND_RETRY_INITIAL_DELAY_MS = 250;
const APPEND_RETRY_MAX_DELAY_MS = 5000;
const RETRYABLE_APPEND_STATUS_CODES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Session-scoped client bound to a specific identity and session token.
 *
 * All operations use the session token for auth — not the parent client's API key.
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
  private readonly producerId: string;
  private producerSeq = 0;

  readonly log: SessionLog;
  private readonly store: SessionStore | undefined;
  private readonly lifecycle = new EventEmitter<SessionLifecycleEvents>();
  private readonly eventSubscriptions = new Map<
    SessionEventListener,
    () => void
  >();
  private appendTask: Promise<void> = Promise.resolve();
  private liveSyncController: AbortController | undefined;
  private liveSyncTask: Promise<void> | undefined;
  private liveSyncCatchUpActive = false;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.token = options.token;
    this.identity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
    this.producerId = crypto.randomUUID();
    this.store = options.store;
    this.log = new SessionLog(options.logOptions);

    this.restorePersistedLogState();
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
    const runAppend = this.appendTask.then(async () => {
      this.producerSeq += 1;

      const result = await this.appendRaw(
        {
          type: parsed.type ?? "content",
          payload: parsed.payload ?? { text: parsed.text },
          actor: parsed.actor ?? this.identity.toActor(),
          producer_id: this.producerId,
          producer_seq: this.producerSeq,
          source: parsed.source ?? "agent",
          metadata: parsed.metadata,
          refs: parsed.refs,
          idempotency_key: parsed.idempotencyKey,
          expected_seq: parsed.expectedSeq,
        },
        options
      );

      return {
        seq: result.seq,
        deduped: result.deduped,
      };
    });

    // Keep queue progression alive even if one append fails.
    this.appendTask = runAppend.then(
      () => undefined,
      () => undefined
    );

    return runAppend;
  }

  /**
   * Appends a raw event payload as-is. Caller manages all fields.
   */
  appendRaw(
    input: AppendEventRequest,
    options?: RequestOptions
  ): Promise<AppendEventResponse> {
    return this.appendRawWithRetry(input, options);
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
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "error",
    listener: SessionEventListener | ((error: Error) => void),
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
            this.observeEventListenerResult(
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
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "event" | "error",
    listener: SessionEventListener | ((error: Error) => void)
  ): void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      const unsubscribe = this.eventSubscriptions.get(eventListener);
      if (!unsubscribe) {
        return;
      }

      this.eventSubscriptions.delete(eventListener);
      unsubscribe();

      if (this.eventSubscriptions.size === 0) {
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

  private observeEventListenerResult(result: void | Promise<void>): void {
    Promise.resolve(result).catch((error) => {
      this.emitStreamError(error);
    });
  }

  private createTailAbortController(outerSignal: AbortSignal | undefined): {
    controller: AbortController;
    detach: () => void;
  } {
    const controller = new AbortController();
    if (!outerSignal) {
      return { controller, detach: () => undefined };
    }

    const abortFromOuterSignal = () => {
      controller.abort(outerSignal.reason);
    };

    if (outerSignal.aborted) {
      controller.abort(outerSignal.reason);
      return { controller, detach: () => undefined };
    }

    outerSignal.addEventListener("abort", abortFromOuterSignal, { once: true });
    return {
      controller,
      detach: () => {
        outerSignal.removeEventListener("abort", abortFromOuterSignal);
      },
    };
  }

  private createTailRuntime<TEvent extends SessionEvent>({
    parseEvent,
    replayCutoffSeq,
    startCursor,
    tailOptions,
  }: {
    parseEvent: (event: SessionEvent) => TEvent;
    replayCutoffSeq: number;
    startCursor: number;
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
      sessionId: this.id,
      token: this.token,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      options: {
        ...tailOptions,
        cursor: startCursor,
        signal: controller.signal,
      },
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

        const next = queue.shift();
        return next;
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
    startCursor: number;
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

  private ensureLiveSync(): void {
    if (this.liveSyncTask || this.eventSubscriptions.size === 0) {
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
        if (this.eventSubscriptions.size > 0) {
          this.ensureLiveSync();
        }
      });
  }

  private async runLiveSync(signal: AbortSignal): Promise<void> {
    let shouldRunCatchUpPass = this.log.lastSeq === 0;
    let retryDelayMs = 250;

    while (!signal.aborted && this.eventSubscriptions.size > 0) {
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
      sessionId: this.id,
      token: this.token,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      options: {
        cursor: this.log.lastSeq,
        follow,
        signal,
      },
    });

    await stream.subscribe((batch) => {
      const appliedEvents = this.log.applyBatch(batch);
      if (appliedEvents.length > 0) {
        this.persistLogState();
      }
    });
  }

  private async appendRawWithRetry(
    input: AppendEventRequest,
    options?: RequestOptions
  ): Promise<AppendEventResponse> {
    let retryDelayMs = APPEND_RETRY_INITIAL_DELAY_MS;

    while (true) {
      if (options?.signal?.aborted) {
        throw new StarciteError(
          `append() aborted for session '${this.id}' before the request could be sent`
        );
      }

      try {
        return await request(
          this.transport,
          `/sessions/${encodeURIComponent(this.id)}/append`,
          {
            method: "POST",
            body: JSON.stringify(input),
            signal: options?.signal,
          },
          AppendEventResponseSchema
        );
      } catch (error) {
        if (!this.isRetryableAppendError(error, options?.signal)) {
          throw error;
        }

        await this.waitForAppendRetry(retryDelayMs, options?.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, APPEND_RETRY_MAX_DELAY_MS);
      }
    }
  }

  private restorePersistedLogState(): void {
    if (!this.store) {
      return;
    }

    let storedState: ReturnType<SessionStore["load"]>;
    try {
      storedState = this.store.load(this.id);
    } catch {
      return;
    }

    if (storedState === undefined) {
      return;
    }

    try {
      // Persisted session state is a cache boundary and must not brick session startup.
      this.log.hydrate(storedState);
    } catch {
      this.clearPersistedLogState();
    }
  }

  private persistLogState(): void {
    if (!this.store) {
      return;
    }

    try {
      this.store.save(this.id, {
        cursor: this.log.cursor,
        events: [...this.log.events],
        metadata: {
          schemaVersion: 1,
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

  private clearPersistedLogState(): void {
    try {
      this.store?.clear?.(this.id);
    } catch {
      // Ignore cache-clear failures; the live stream can still recover state.
    }
  }

  private isRetryableAppendError(
    error: unknown,
    signal: AbortSignal | undefined
  ): boolean {
    if (signal?.aborted) {
      return false;
    }

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
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (delayMs <= 0 || signal?.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };

      signal?.addEventListener("abort", onAbort, { once: true });
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
