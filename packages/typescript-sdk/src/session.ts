import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
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
  SessionConsumeOptions,
  SessionEvent,
  SessionLogOptions,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
  SessionTailOptions,
  TailEvent,
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
  store: SessionStore;
  record?: SessionRecord;
  logOptions?: SessionLogOptions;
}

type SessionEventListener = (event: SessionEvent) => void;

interface SessionLifecycleEvents {
  error: (error: Error) => void;
}

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
  private readonly store: SessionStore;
  private readonly lifecycle = new EventEmitter<SessionLifecycleEvents>();
  private readonly eventSubscriptions = new Map<
    SessionEventListener,
    () => void
  >();
  private liveSyncController: AbortController | undefined;
  private liveSyncTask: Promise<void> | undefined;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.token = options.token;
    this.identity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
    this.producerId = crypto.randomUUID();
    this.store = options.store;
    this.log = new SessionLog(options.logOptions);

    const storedState = this.store.load(this.id);
    if (storedState) {
      this.log.hydrate(storedState);
    }
  }

  /**
   * Appends an event to this session.
   *
   * The SDK manages `actor`, `producer_id`, and `producer_seq` automatically.
   */
  async append(
    input: SessionAppendInput,
    options?: RequestOptions
  ): Promise<AppendResult> {
    const parsed = SessionAppendInputSchema.parse(input);
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
  }

  /**
   * Appends a raw event payload as-is. Caller manages all fields.
   */
  appendRaw(
    input: AppendEventRequest,
    options?: RequestOptions
  ): Promise<AppendEventResponse> {
    return request(
      this.transport,
      `/sessions/${encodeURIComponent(this.id)}/append`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options?.signal,
      },
      AppendEventResponseSchema
    );
  }

  /**
   * Subscribes to canonical session events and lifecycle errors.
   */
  on(eventName: "event", listener: SessionEventListener): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "error",
    listener: SessionEventListener | ((error: Error) => void)
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      if (!this.eventSubscriptions.has(eventListener)) {
        const unsubscribe = this.log.subscribe(eventListener, { replay: true });
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
   * Returns a stable snapshot of the current canonical in-memory log.
   */
  getSnapshot(): SessionSnapshot {
    return this.log.getSnapshot(this.liveSyncTask !== undefined);
  }

  /**
   * Streams tail events one at a time via callback.
   */
  async tail(
    onEvent: (event: TailEvent) => void | Promise<void>,
    options: SessionTailOptions = {}
  ): Promise<void> {
    await this.tailBatches(async (batch) => {
      for (const event of batch) {
        await onEvent(event);
      }
    }, options);
  }

  /**
   * Streams tail event batches grouped by incoming frame via callback.
   */
  async tailBatches(
    onBatch: (batch: TailEvent[]) => void | Promise<void>,
    options: SessionTailOptions = {}
  ): Promise<void> {
    await new TailStream({
      sessionId: this.id,
      token: this.token,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      options,
    }).subscribe(onBatch);
  }

  /**
   * Durably consumes events and checkpoints `event.seq` after each successful handler invocation.
   */
  async consume(options: SessionConsumeOptions): Promise<void> {
    const {
      cursorStore,
      handler,
      cursor: requestedCursor,
      ...tailOptions
    } = options;

    let cursor: number;

    if (requestedCursor !== undefined) {
      cursor = requestedCursor;
    } else {
      try {
        cursor = (await cursorStore.load(this.id)) ?? 0;
      } catch (error) {
        throw new StarciteError(
          `consume() failed to load cursor for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const stream = new TailStream({
      sessionId: this.id,
      token: this.token,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      options: {
        ...tailOptions,
        cursor,
      },
    });

    await stream.subscribe(async (batch) => {
      for (const event of batch) {
        await handler(event);

        try {
          await cursorStore.save(this.id, event.seq);
        } catch (error) {
          throw new StarciteError(
            `consume() failed to save cursor for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      });
  }

  private async runLiveSync(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.eventSubscriptions.size > 0) {
      const stream = new TailStream({
        sessionId: this.id,
        token: this.token,
        websocketBaseUrl: this.transport.websocketBaseUrl,
        websocketFactory: this.transport.websocketFactory,
        options: {
          cursor: this.log.lastSeq,
          signal,
        },
      });

      try {
        await stream.subscribe((batch) => {
          const appliedEvents = this.log.applyBatch(batch);
          if (appliedEvents.length > 0) {
            this.persistLogState();
          }
        });
      } catch (error) {
        if (signal.aborted) {
          return;
        }

        if (error instanceof SessionLogGapError) {
          continue;
        }

        throw error;
      }
    }
  }

  private persistLogState(): void {
    this.store.save(this.id, {
      cursor: this.log.cursor,
      events: [...this.log.events],
    });
  }
}
