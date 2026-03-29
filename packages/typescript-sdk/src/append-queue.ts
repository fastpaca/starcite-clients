import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import type { TransportConfig } from "./transport";
import { request } from "./transport";
import type {
  AppendEventRequest,
  AppendEventResponse,
  AppendResult,
  SessionAppendFailureSnapshot,
  SessionAppendInput,
  SessionAppendLifecycleEvent,
  SessionAppendOptions,
  SessionAppendQueueState,
  SessionAppendStoreState,
  SessionPendingAppend,
  TailEvent,
} from "./types";
import { AppendEventResponseSchema } from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APPEND_RETRY_INITIAL_DELAY_MS = 250;
const APPEND_RETRY_MAX_DELAY_MS = 5000;
const APPEND_RETRY_MULTIPLIER = 2;
const APPEND_RETRY_JITTER_RATIO = 0;
const RETRYABLE_APPEND_STATUS_CODES = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function calculateAppendRetryDelay(
  retryAttempt: number,
  policy: ResolvedSessionAppendRetryPolicy,
): number {
  const exponent = policy.mode === "fixed" ? 0 : Math.max(0, retryAttempt - 1);
  const baseDelayMs = Math.min(
    policy.initialDelayMs * policy.multiplier ** exponent,
    policy.maxDelayMs,
  );

  if (policy.jitterRatio === 0) {
    return baseDelayMs;
  }

  const jitterWindowMs = Math.round(baseDelayMs * policy.jitterRatio);
  const minimumDelayMs = Math.max(0, baseDelayMs - jitterWindowMs);
  const maximumDelayMs = baseDelayMs + jitterWindowMs;
  return Math.round(
    minimumDelayMs + Math.random() * (maximumDelayMs - minimumDelayMs),
  );
}

function createLinkedAbortController(
  signals: readonly (AbortSignal | undefined)[],
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
    `append() aborted for session '${sessionId}' before the request could be sent`,
  );
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface AppendQueueOptions {
  sessionId: string;
  transport: TransportConfig;
  appendOptions?: SessionAppendOptions;
  persist: boolean;
  onStateChange: () => void;
  onError: (error: Error) => void;
  onLifecycle: (event: SessionAppendLifecycleEvent) => void;
}

// ---------------------------------------------------------------------------
// AppendQueue
// ---------------------------------------------------------------------------

export class AppendQueue {
  private readonly sessionId: string;
  private readonly transport: TransportConfig;
  private readonly options: ResolvedSessionAppendOptions;
  private readonly onStateChange: () => void;
  private readonly onError: (error: Error) => void;
  private readonly onLifecycle: (event: SessionAppendLifecycleEvent) => void;

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

  constructor(opts: AppendQueueOptions) {
    this.sessionId = opts.sessionId;
    this.transport = opts.transport;
    this.onStateChange = opts.onStateChange;
    this.onError = opts.onError;
    this.onLifecycle = opts.onLifecycle;

    const retryPolicy = opts.appendOptions?.retryPolicy;
    this.options = {
      retryPolicy: {
        mode: retryPolicy?.mode ?? "exponential",
        initialDelayMs:
          retryPolicy?.initialDelayMs ?? APPEND_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: retryPolicy?.maxDelayMs ?? APPEND_RETRY_MAX_DELAY_MS,
        multiplier: retryPolicy?.multiplier ?? APPEND_RETRY_MULTIPLIER,
        jitterRatio: retryPolicy?.jitterRatio ?? APPEND_RETRY_JITTER_RATIO,
        maxAttempts: retryPolicy?.maxAttempts ?? Number.POSITIVE_INFINITY,
      },
      persist: opts.persist && (opts.appendOptions?.persist ?? true),
      autoFlush: opts.appendOptions?.autoFlush ?? true,
      terminalFailureMode:
        opts.appendOptions?.terminalFailureMode ?? "pause",
    };

    this.appendProducerId = crypto.randomUUID();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  append(
    input: SessionAppendInput,
    signal?: AbortSignal,
  ): Promise<AppendResult> {
    const itemId = crypto.randomUUID();

    return this.enqueueAppend({
      id: itemId,
      request: {
        type: input.type ?? "content",
        payload: input.payload ?? { text: input.text },
        actor: input.actor,
        producer_id: this.appendProducerId,
        producer_seq: this.nextManagedProducerSeq(),
        source: input.source ?? "agent",
        metadata: input.metadata,
        refs: input.refs,
        idempotency_key: input.idempotencyKey ?? itemId,
        expected_seq: input.expectedSeq,
      },
      enqueuedAtMs: Date.now(),
      retryAttempt: 0,
      signal,
    }).then((result) => ({
      seq: result.seq,
      deduped: result.deduped,
    }));
  }

  state(): SessionAppendQueueState {
    return this.snapshotAppendQueueState();
  }

  resume(): void {
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
    this.onStateChange();
    this.emitLifecycle({
      type: "resumed",
      sessionId: this.sessionId,
      queue: this.snapshotAppendQueueState(),
    });
    this.startProcessing();
  }

  reset(): void {
    const rejection = new StarciteError(
      `append queue reset for session '${this.sessionId}' before pending items could be acknowledged`,
    );

    this.clear(rejection, {
      rotateProducer: true,
      lastFailure: undefined,
    });
    this.emitLifecycle({
      type: "reset",
      sessionId: this.sessionId,
      queue: this.snapshotAppendQueueState(),
    });
  }

  ensureProcessing(): void {
    if (
      this.options.autoFlush &&
      this.appendQueueStatus !== "paused" &&
      this.appendQueue.length > 0
    ) {
      this.startProcessing();
    }
  }

  stop(): void {
    this.appendQueueVersion += 1;
    this.appendQueueRunController?.abort();
  }

  // -----------------------------------------------------------------------
  // Reconciliation
  // -----------------------------------------------------------------------

  reconcileWithCommittedEvents(
    events: readonly TailEvent[],
    lastSeq: number,
  ): boolean {
    if (this.appendQueue.length === 0) {
      return false;
    }

    const reconciled: Array<{
      event: TailEvent;
      item: RuntimeAppendQueueItem;
    }> = [];
    let removedInFlightItem = false;

    for (const event of events) {
      const matchedIndex = this.appendQueue.findIndex((item) =>
        this.matchesCommittedEvent(item.request, event),
      );
      if (matchedIndex < 0) {
        continue;
      }

      const [matchedItem] = this.appendQueue.splice(matchedIndex, 1);
      if (!matchedItem) {
        continue;
      }

      if (matchedItem.id === this.appendInFlightItemId) {
        removedInFlightItem = true;
      }

      if (matchedItem.request.producer_id === this.appendProducerId) {
        this.appendLastAcknowledgedProducerSeq = Math.max(
          this.appendLastAcknowledgedProducerSeq,
          matchedItem.request.producer_seq,
        );
      }

      reconciled.push({ event, item: matchedItem });
    }

    if (reconciled.length === 0) {
      return false;
    }

    if (removedInFlightItem) {
      this.appendQueueVersion += 1;
      this.appendQueueRunController?.abort();
    }

    if (this.appendQueueStatus !== "paused") {
      this.appendQueueStatus = "idle";
    }

    if (removedInFlightItem || this.appendQueue.length === 0) {
      this.appendInFlightItemId = undefined;
      this.appendRetryAttempt = 0;
      this.appendNextRetryAtMs = undefined;
      this.appendLastFailure = undefined;
    }

    const queueSnapshot = this.snapshotAppendQueueState();
    for (const { event, item } of reconciled) {
      item.deferred?.resolve({
        deduped: false,
        last_seq: lastSeq,
        seq: event.seq,
      });
      this.emitLifecycle({
        type: "acknowledged",
        sessionId: this.sessionId,
        itemId: item.id,
        seq: event.seq,
        deduped: false,
        queue: queueSnapshot,
      });
    }

    if (
      !(removedInFlightItem || this.appendQueueTask) &&
      this.appendQueue.length > 0 &&
      this.appendQueueStatus !== "paused" &&
      this.options.autoFlush
    ) {
      this.startProcessing();
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  serializeState(): SessionAppendStoreState | undefined {
    if (!this.options.persist) {
      return undefined;
    }

    return {
      producerId: this.appendProducerId,
      lastAcknowledgedProducerSeq: this.appendLastAcknowledgedProducerSeq,
      pending: this.appendQueue.map((item) => ({
        id: item.id,
        request: structuredClone(item.request) as AppendEventRequest,
        enqueuedAtMs: item.enqueuedAtMs,
        retryAttempt: item.retryAttempt,
      })),
      status: this.appendQueueStatus === "paused" ? "paused" : "idle",
      lastFailure: this.appendLastFailure
        ? { ...this.appendLastFailure }
        : undefined,
    };
  }

  restoreState(storedState: SessionAppendStoreState): void {
    if (!this.options.persist) {
      return;
    }

    this.appendProducerId = storedState.producerId;
    this.appendLastAcknowledgedProducerSeq =
      storedState.lastAcknowledgedProducerSeq;
    this.appendQueue.length = 0;

    for (const pending of storedState.pending) {
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
    this.appendLastFailure = storedState.lastFailure
      ? { ...storedState.lastFailure }
      : undefined;

    if (this.appendQueue.length === 0) {
      this.appendQueueStatus = "idle";
      return;
    }

    if (storedState.status === "paused" || !this.options.autoFlush) {
      this.appendQueueStatus = "paused";
      return;
    }

    this.appendQueueStatus = "idle";
  }

  get pendingCount(): number {
    return this.appendQueue.length;
  }

  // -----------------------------------------------------------------------
  // Private — queue management
  // -----------------------------------------------------------------------

  private enqueueAppend(
    item: RuntimeAppendQueueItem,
  ): Promise<AppendEventResponse> {
    if (item.signal?.aborted) {
      return Promise.reject(createAppendAbortError(this.sessionId));
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

    this.onStateChange();
    this.emitLifecycle({
      type: "queued",
      sessionId: this.sessionId,
      item: this.snapshotPendingAppend(item),
      queue: this.snapshotAppendQueueState(),
    });

    if (this.appendQueueStatus !== "paused" && this.options.autoFlush) {
      this.startProcessing();
    }

    return promise;
  }

  private startProcessing(): void {
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
        this.startProcessing();
      }
    });

    this.appendQueueTask = task;
  }

  private async runAppendQueue(
    runId: number,
    runSignal: AbortSignal,
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
        this.onStateChange();
        return;
      }

      const shouldContinue = await this.processAppendQueueHead(
        head,
        runId,
        runSignal,
      );
      if (!shouldContinue) {
        return;
      }
    }
  }

  private async processAppendQueueHead(
    item: RuntimeAppendQueueItem,
    runId: number,
    runSignal: AbortSignal,
  ): Promise<boolean> {
    if (item.signal?.aborted) {
      this.handleTerminalAppendFailure(
        item,
        createAppendAbortError(this.sessionId),
      );
      return false;
    }

    this.appendQueueStatus = "flushing";
    this.appendInFlightItemId = item.id;
    this.appendRetryAttempt = item.retryAttempt;
    this.appendNextRetryAtMs = undefined;
    this.onStateChange();
    this.emitLifecycle({
      type: "attempt_started",
      sessionId: this.sessionId,
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
        `/sessions/${encodeURIComponent(this.sessionId)}/append`,
        {
          method: "POST",
          body: JSON.stringify(item.request),
          signal: controller.signal,
        },
        AppendEventResponseSchema,
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
        this.handleTerminalAppendFailure(
          item,
          createAppendAbortError(this.sessionId),
        );
        return false;
      }

      const retryable = this.isRetryableAppendError(error);
      const nextRetryAttempt = item.retryAttempt + 1;
      if (
        retryable &&
        nextRetryAttempt <= this.options.retryPolicy.maxAttempts
      ) {
        const failure = this.snapshotAppendFailure(error, true, false);
        item.retryAttempt = nextRetryAttempt;
        this.appendQueueStatus = "retrying";
        this.appendRetryAttempt = item.retryAttempt;
        const delayMs = calculateAppendRetryDelay(
          item.retryAttempt,
          this.options.retryPolicy,
        );
        this.appendNextRetryAtMs = Date.now() + delayMs;
        this.appendLastFailure = failure;
        this.onStateChange();
        this.emitLifecycle({
          type: "retry_scheduled",
          sessionId: this.sessionId,
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
        true,
      );
      this.handleTerminalAppendFailure(
        item,
        this.toError(error),
        terminalFailure,
      );
      return false;
    } finally {
      detach();
    }
  }

  private handleAcknowledgedAppend(
    item: RuntimeAppendQueueItem,
    response: AppendEventResponse,
  ): void {
    this.appendQueue.shift();
    this.appendInFlightItemId = undefined;
    this.appendRetryAttempt = 0;
    this.appendNextRetryAtMs = undefined;
    this.appendLastFailure = undefined;
    this.appendQueueStatus = "idle";

    if (item.request.producer_id === this.appendProducerId) {
      this.appendLastAcknowledgedProducerSeq = Math.max(
        this.appendLastAcknowledgedProducerSeq,
        item.request.producer_seq,
      );
    }

    this.onStateChange();
    item.deferred?.resolve(response);
    this.emitLifecycle({
      type: "acknowledged",
      sessionId: this.sessionId,
      itemId: item.id,
      seq: response.seq,
      deduped: response.deduped,
      queue: this.snapshotAppendQueueState(),
    });
  }

  private handleTerminalAppendFailure(
    item: RuntimeAppendQueueItem,
    error: Error,
    failure = this.snapshotAppendFailure(error, false, true),
  ): void {
    item.deferred?.reject(error);

    if (this.options.terminalFailureMode === "clear") {
      this.clear(error, {
        rotateProducer: true,
        lastFailure: failure,
      });
      this.emitLifecycle({
        type: "cleared",
        sessionId: this.sessionId,
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
    this.onStateChange();
    this.emitLifecycle({
      type: "paused",
      sessionId: this.sessionId,
      itemId: item.id,
      failure,
      queue: this.snapshotAppendQueueState(),
    });
  }

  private clear(
    reason: Error,
    options: {
      rotateProducer: boolean;
      lastFailure: SessionAppendFailureSnapshot | undefined;
    },
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

    this.onStateChange();
  }

  // -----------------------------------------------------------------------
  // Private — helpers
  // -----------------------------------------------------------------------

  private matchesCommittedEvent(
    req: AppendEventRequest,
    event: TailEvent,
  ): boolean {
    if (
      req.idempotency_key &&
      event.idempotency_key &&
      req.idempotency_key === event.idempotency_key
    ) {
      return true;
    }

    return (
      req.producer_id === event.producer_id &&
      req.producer_seq === event.producer_seq
    );
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

  private snapshotAppendFailure(
    error: unknown,
    retryable: boolean,
    terminal: boolean,
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

  private snapshotPendingAppend(item: RuntimeAppendQueueItem): SessionPendingAppend {
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

  private emitLifecycle(event: SessionAppendLifecycleEvent): void {
    try {
      this.onLifecycle(event);
    } catch (error) {
      this.onError(
        error instanceof Error
          ? error
          : new StarciteError(`Append lifecycle listener failed: ${String(error)}`),
      );
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
    runSignal: AbortSignal,
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

  private toError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new StarciteError(String(error));
  }
}
