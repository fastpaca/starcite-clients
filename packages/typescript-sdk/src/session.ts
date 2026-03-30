import EventEmitter from "eventemitter3";
import { z } from "zod";
import { AppendQueue } from "./append-queue";
import {
  StarciteError,
  StarciteTailError,
  StarciteTokenExpiredError,
} from "./errors";
import type { StarciteIdentity } from "./identity";
import { SessionLog, type SessionLogSubscriptionContext } from "./session-log";
import {
  type RejoinableChannel,
  readJoinFailureReason,
} from "./socket-manager";
import type { TransportConfig } from "./transport";
import {
  type AppendResult,
  type RequestOptions,
  type SessionAppendInput,
  type SessionAppendLifecycleEvent,
  type SessionAppendListener,
  type SessionAppendOptions,
  type SessionAppendQueueState,
  type SessionEventContext,
  type SessionEventListener,
  type SessionGapListener,
  type SessionLogOptions,
  type SessionOnEventOptions,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStore,
  type SessionStoreState,
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
  private readonly outbox: AppendQueue;

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
    this.log = new SessionLog(options.logOptions);

    this.outbox = new AppendQueue({
      sessionId: options.id,
      transport: options.transport,
      appendOptions: options.appendOptions,
      persist: this.store !== undefined,
      onStateChange: () => this.persistLogState(),
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

    const storedState = this.loadPersistedState();
    if (this.restorePersistedLogState(storedState)) {
      if (storedState?.append) {
        this.outbox.restoreState(storedState.append);
      }
      const pendingBefore = this.outbox.pendingCount;
      this.outbox.reconcileWithCommittedEvents(
        this.log.events,
        this.log.lastSeq
      );
      if (this.outbox.pendingCount !== pendingBefore) {
        this.persistLogState();
      }
    }

    this.ensureChannelAttached();
    this.outbox.ensureProcessing();
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
        const replay = eventOptions?.replay ?? true;

        const dispatch = (
          event: TailEvent,
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
    this.outbox.stop();
    for (const unsubscribe of this.eventSubscriptions.values()) {
      unsubscribe();
    }
    this.eventSubscriptions.clear();
    this.detachTailChannel();
    this.lifecycle.removeAllListeners();
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
   * Returns a stable view of the current canonical in-memory log state.
   */
  state(): SessionSnapshot {
    return {
      ...this.log.state(this.tailChannel !== undefined),
      append: this.outbox.state(),
    };
  }

  /**
   * Returns the retained canonical event list.
   */
  events(): readonly TailEvent[] {
    return this.log.events;
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
        params: () => ({ cursor: this.log.cursor ?? 0 }),
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

  private persistLogState(): void {
    if (!this.store) {
      return;
    }

    try {
      this.store.save(this.id, {
        cursor: this.log.cursor,
        lastSeq: this.log.lastSeq,
        events: [...this.log.events],
        append: this.outbox.serializeState(),
        metadata: {
          schemaVersion: 4,
          updatedAtMs: Date.now(),
        },
      });
    } catch (error) {
      const storeError = new StarciteError(
        `Session store save failed for session '${this.id}': ${error instanceof Error ? error.message : String(error)}`
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
}
