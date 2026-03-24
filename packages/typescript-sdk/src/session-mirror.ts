import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import { SessionLog, SessionLogGapError } from "./session-log";
import { TailStream } from "./tail/stream";
import type { TransportConfig } from "./transport";
import type {
  AppendEventRequest,
  AppendEventResponse,
  SessionLogOptions,
  SessionSnapshot,
  SessionStore,
  SessionStoreState,
} from "./types";

const DEFAULT_LIVE_COOLDOWN_MS = 15_000;
const DEFAULT_IDLE_EVICTION_MS = 5 * 60_000;
const INTERNAL_SNAPSHOT_CATCH_UP_IDLE_MS = 1000;

interface SessionMirrorRuntimeEvents {
  error: (error: Error) => void;
}

export interface SessionMirrorRuntimeOptions {
  id: string;
  sessionToken: string;
  transport: TransportConfig;
  store?: SessionStore;
  logOptions?: SessionLogOptions;
  onEvict?: () => void;
}

/**
 * Starcite sessions are an ordered shared event log, but most app code expects
 * a coherent local view with simple "read current state / subscribe / append"
 * semantics. The mirror is the internal bridge between those models.
 *
 * It owns one canonical in-process `SessionLog` for a session, keeps it caught
 * up from the tail stream when needed, and lets append callers wait for the
 * real canonical event instead of guessing locally.
 */
export class SessionMirrorRuntime {
  readonly id: string;
  readonly log: SessionLog;

  private sessionToken: string;
  private transport: TransportConfig;
  private readonly store: SessionStore | undefined;
  private readonly lifecycle = new EventEmitter<SessionMirrorRuntimeEvents>();
  private readonly onEvict: (() => void) | undefined;

  private subscriberCount = 0;
  private transientInterestCount = 0;
  private followController: AbortController | undefined;
  private followTask: Promise<void> | undefined;
  private hydrationTask: Promise<void> | undefined;
  private followCatchUpActive = false;
  private immediateTeardownRequested = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private evictionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly provisionalSeqs = new Set<number>();
  private readonly seqWaiters = new Set<{
    targetSeq: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }>();

  constructor(options: SessionMirrorRuntimeOptions) {
    this.id = options.id;
    this.sessionToken = options.sessionToken;
    this.transport = options.transport;
    this.store = options.store;
    this.log = new SessionLog(options.logOptions);
    this.onEvict = options.onEvict;

    const storedState = this.loadPersistedState();
    if (!this.restorePersistedLogState(storedState)) {
      this.clearPersistedLogState();
    }
  }

  updateTransport(sessionToken: string, transport: TransportConfig): void {
    this.sessionToken = sessionToken;
    this.transport = transport;
  }

  state(): SessionSnapshot {
    return this.log.state(
      this.followTask !== undefined || this.hydrationTask !== undefined
    );
  }

  setLogOptions(options: SessionLogOptions): void {
    this.log.setMaxEvents(options.maxEvents);
    this.persistLogState();
  }

  isCatchUpActive(): boolean {
    return this.followCatchUpActive;
  }

  subscribeError(listener: (error: Error) => void): () => void {
    this.lifecycle.on("error", listener);
    return () => {
      this.lifecycle.off("error", listener);
    };
  }

  retainSubscriberInterest(): void {
    this.immediateTeardownRequested = false;
    this.subscriberCount += 1;
    this.clearIdleTimers();
    this.ensureFollowing();
  }

  releaseSubscriberInterest(): void {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    this.scheduleIdleTimersIfNeeded();
  }

  shutdownIfIdle(): void {
    if (this.subscriberCount > 0 || this.transientInterestCount > 0) {
      return;
    }

    this.immediateTeardownRequested = true;
    this.clearIdleTimers();
    this.followController?.abort();
    if (this.followTask === undefined && this.hydrationTask === undefined) {
      this.onEvict?.();
    }
  }

  ensureHydratedForRead(targetSeq?: number): Promise<void> {
    if (targetSeq !== undefined && this.log.lastSeq >= targetSeq) {
      return Promise.resolve();
    }

    this.immediateTeardownRequested = false;
    this.clearIdleTimers();
    if (this.hydrationTask) {
      if (targetSeq === undefined) {
        return this.hydrationTask;
      }

      return this.hydrationTask.then(() => {
        if (this.log.lastSeq >= targetSeq) {
          return;
        }

        return this.ensureHydratedForRead(targetSeq);
      });
    }

    if (!this.hydrationTask) {
      this.hydrationTask = this.runTransientTask(async () => {
        await this.catchUpSnapshot(targetSeq);
      }).finally(() => {
        this.hydrationTask = undefined;
        this.scheduleIdleTimersIfNeeded();
      });
    }

    return this.hydrationTask;
  }

  ensureHydratedInBackground(): void {
    this.ensureHydratedForRead().catch((error) => {
      this.emitError(error);
    });
  }

  async waitForSeq(targetSeq: number): Promise<void> {
    if (this.log.lastSeq >= targetSeq) {
      return;
    }

    this.clearIdleTimers();
    if (this.followTask || this.subscriberCount > 0) {
      this.ensureFollowing();
      await this.awaitObservedSeq(targetSeq);
      this.scheduleIdleTimersIfNeeded();
      return;
    }

    try {
      await this.runTransientTask(async () => {
        await this.followUntilSeq(targetSeq);
      });
    } finally {
      this.scheduleIdleTimersIfNeeded();
    }
  }

  async reconcileAppend(
    request: AppendEventRequest,
    response: AppendEventResponse
  ): Promise<void> {
    if (this.log.lastSeq >= response.seq) {
      return;
    }

    if (response.seq === this.log.lastSeq + 1) {
      this.applyProvisionalEvent(request, response);
      return;
    }

    await this.waitForSeq(response.seq);
  }

  private applyProvisionalEvent(
    request: AppendEventRequest,
    response: AppendEventResponse
  ): void {
    const applied = this.log.applyEvent({
      seq: response.seq,
      type: request.type,
      payload: request.payload,
      actor: request.actor ?? "unknown",
      producer_id: request.producer_id,
      producer_seq: request.producer_seq,
      source: request.source,
      metadata: request.metadata,
      refs: request.refs,
      idempotency_key: request.idempotency_key ?? null,
    });

    if (!applied) {
      return;
    }

    this.provisionalSeqs.add(response.seq);
    this.persistLogState();
    this.resolveObservedSeqWaiters();
  }

  private awaitObservedSeq(targetSeq: number): Promise<void> {
    if (this.log.lastSeq >= targetSeq) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = { targetSeq, resolve, reject };
      this.seqWaiters.add(waiter);

      if (this.log.lastSeq >= targetSeq) {
        this.seqWaiters.delete(waiter);
        resolve();
      }
    });
  }

  private resolveObservedSeqWaiters(): void {
    for (const waiter of [...this.seqWaiters]) {
      if (this.log.lastSeq < waiter.targetSeq) {
        continue;
      }

      this.seqWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectObservedSeqWaiters(error: unknown): void {
    for (const waiter of [...this.seqWaiters]) {
      this.seqWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private async runTransientTask<T>(task: () => Promise<T>): Promise<T> {
    this.transientInterestCount += 1;
    try {
      return await task();
    } finally {
      this.transientInterestCount = Math.max(
        0,
        this.transientInterestCount - 1
      );
    }
  }

  private async catchUpSnapshot(targetSeq?: number): Promise<void> {
    await this.subscribePass({
      follow: false,
      catchUpIdleMs: INTERNAL_SNAPSHOT_CATCH_UP_IDLE_MS,
    });

    if (targetSeq !== undefined && this.log.lastSeq < targetSeq) {
      throw new StarciteError(
        `Session '${this.id}' did not hydrate through seq ${targetSeq}`
      );
    }
  }

  private async followUntilSeq(targetSeq: number): Promise<void> {
    if (this.log.lastSeq >= targetSeq) {
      return;
    }

    const controller = new AbortController();
    let reachedTarget = false;

    try {
      await this.subscribePass({
        follow: true,
        signal: controller.signal,
        onApplied: () => {
          if (this.log.lastSeq < targetSeq) {
            return;
          }

          reachedTarget = true;
          controller.abort();
        },
      });
    } catch (error) {
      if (!(controller.signal.aborted && reachedTarget)) {
        throw error;
      }
    }

    if (this.log.lastSeq < targetSeq) {
      throw new StarciteError(
        `Session '${this.id}' did not reconcile through seq ${targetSeq}`
      );
    }
  }

  private ensureFollowing(): void {
    if (this.followTask || this.subscriberCount === 0) {
      return;
    }

    this.clearIdleTimers();
    const controller = new AbortController();
    this.followController = controller;

    this.followTask = this.runFollowingLoop(controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted) {
          this.emitError(error);
          this.rejectObservedSeqWaiters(error);
        }
      })
      .finally(() => {
        this.followController = undefined;
        this.followTask = undefined;
        if (this.subscriberCount > 0) {
          this.ensureFollowing();
          return;
        }

        this.scheduleIdleTimersIfNeeded();
      });
  }

  private async runFollowingLoop(signal: AbortSignal): Promise<void> {
    let shouldRunCatchUpPass = this.log.lastSeq === 0;
    let retryDelayMs = 250;

    while (!signal.aborted && this.subscriberCount > 0) {
      this.followCatchUpActive = shouldRunCatchUpPass;

      try {
        await this.subscribePass({
          follow: !shouldRunCatchUpPass,
          signal,
        });
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

        this.emitError(error);
        shouldRunCatchUpPass = true;
        await this.waitForRetry(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 5000);
      } finally {
        this.followCatchUpActive = false;
      }
    }
  }

  private async subscribePass(options: {
    follow: boolean;
    signal?: AbortSignal;
    catchUpIdleMs?: number;
    onApplied?: () => void;
  }): Promise<void> {
    const stream = new TailStream({
      sessionId: this.id,
      token: this.sessionToken,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      options: {
        cursor: this.log.lastSeq,
        follow: options.follow,
        signal: options.signal,
        catchUpIdleMs: options.catchUpIdleMs,
      },
    });

    await stream.subscribe((batch) => {
      this.applyCanonicalBatch(batch);
      options.onApplied?.();
    });
  }

  private applyCanonicalBatch(batch: SessionStoreState["events"]): void {
    let changed = false;
    for (const event of batch) {
      if (this.provisionalSeqs.delete(event.seq)) {
        this.log.replaceEvent(event);
        changed = true;
        continue;
      }

      if (this.log.applyBatch([event]).length > 0) {
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    this.persistLogState();
    this.resolveObservedSeqWaiters();
  }

  private emitError(error: unknown): void {
    const sessionError =
      error instanceof Error
        ? error
        : new StarciteError(`Session stream failed: ${String(error)}`);

    if (this.lifecycle.listenerCount("error") > 0) {
      this.lifecycle.emit("error", sessionError);
      return;
    }

    queueMicrotask(() => {
      throw sessionError;
    });
  }

  private scheduleIdleTimersIfNeeded(): void {
    if (this.subscriberCount > 0 || this.transientInterestCount > 0) {
      return;
    }

    if (this.immediateTeardownRequested) {
      this.immediateTeardownRequested = false;
      this.onEvict?.();
      return;
    }

    this.scheduleCooldown();
    this.scheduleEviction();
  }

  private scheduleCooldown(): void {
    if (this.followTask === undefined || this.followController === undefined) {
      return;
    }

    this.clearCooldownTimer();
    if (DEFAULT_LIVE_COOLDOWN_MS <= 0) {
      this.followController.abort();
      return;
    }

    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      this.followController?.abort();
    }, DEFAULT_LIVE_COOLDOWN_MS);
  }

  private scheduleEviction(): void {
    this.clearEvictionTimer();
    if (DEFAULT_IDLE_EVICTION_MS <= 0) {
      this.onEvict?.();
      return;
    }

    this.evictionTimer = setTimeout(() => {
      this.evictionTimer = undefined;
      if (this.subscriberCount > 0 || this.transientInterestCount > 0) {
        return;
      }

      this.onEvict?.();
    }, DEFAULT_IDLE_EVICTION_MS);
  }

  private clearIdleTimers(): void {
    this.clearCooldownTimer();
    this.clearEvictionTimer();
  }

  private clearCooldownTimer(): void {
    if (!this.cooldownTimer) {
      return;
    }

    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
  }

  private clearEvictionTimer(): void {
    if (!this.evictionTimer) {
      return;
    }

    clearTimeout(this.evictionTimer);
    this.evictionTimer = undefined;
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
      return false;
    }
  }

  private persistLogState(): void {
    if (!this.store) {
      return;
    }

    const existingState = this.loadPersistedState();

    try {
      this.store.save(this.id, {
        cursor: this.log.cursor,
        events: [...this.log.events],
        append: existingState?.append,
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

  private clearPersistedLogState(): void {
    try {
      this.store?.clear?.(this.id);
    } catch {
      // Ignore cache-clear failures; the live stream can still recover state.
    }
  }

  private waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
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
