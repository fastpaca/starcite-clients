import { type Channel, Socket } from "phoenix";
import { z } from "zod";
import type {
  TailCursor,
  TailEvent,
  TailGap,
  TailReconnectPolicy,
  TailTokenExpiredPayload,
} from "../types";
import {
  TailEventSchema,
  TailGapSchema,
  TailTokenExpiredPayloadSchema,
} from "../types";

const CONNECTION_TIMEOUT_CLOSE_CODE = 4100;
const CONNECTION_TIMEOUT_REASON = "connection timeout";

const TailEventsPayloadSchema = z.object({
  events: z.array(TailEventSchema),
});

interface ResolvedReconnectPolicy {
  mode: "fixed" | "exponential";
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export interface TailSocketAuthContext {
  key: string;
  token: string | undefined;
}

export type TailSocketLifecycleEvent =
  | {
      type: "connect_attempt";
      attempt: number;
    }
  | {
      type: "connect_failed";
      attempt: number;
      rootCause: string;
    }
  | {
      type: "reconnect_scheduled";
      attempt: number;
      delayMs: number;
      trigger: "connect_failed" | "dropped";
      closeCode?: number;
      closeReason?: string;
    }
  | {
      type: "open";
    }
  | {
      type: "dropped";
      attempt: number;
      closeCode?: number;
      closeReason?: string;
    };

interface TailSocketConsumer {
  connectionTimeoutMs: number;
  connectionTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  onConnectionTimeout: (payload: {
    closeCode: number;
    closeReason: string;
  }) => void;
  onEvents: (events: TailEvent[]) => void;
  onGap: (gap: TailGap) => void;
  onLifecycle: (event: TailSocketLifecycleEvent) => void;
  onTokenExpired: (payload: TailTokenExpiredPayload) => void;
  reconnectPolicy: ResolvedReconnectPolicy;
}

interface RejoinableChannel extends Channel {
  rejoin: (timeout?: number) => void;
}

interface SessionRecord {
  attempt: number;
  awaitingAttempt: boolean;
  batchSize: number | undefined;
  channel: RejoinableChannel;
  consumers: Set<TailSocketConsumer>;
  eventBindingRef: number;
  gapBindingRef: number;
  lastCursor: TailCursor;
  ready: boolean;
  sessionId: string;
  tokenExpiredBindingRef: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeJoinFailure(payload: unknown): string {
  if (payload === undefined) {
    return "join failed";
  }

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

  return describeError(payload);
}

function resolveReconnectPolicy(
  policy: TailReconnectPolicy | undefined
): ResolvedReconnectPolicy {
  const mode = policy?.mode === "fixed" ? "fixed" : "exponential";
  const initialDelayMs = policy?.initialDelayMs ?? 500;

  return {
    mode,
    initialDelayMs,
    maxDelayMs:
      policy?.maxDelayMs ??
      (mode === "fixed" ? initialDelayMs : Math.max(initialDelayMs, 15_000)),
    multiplier: mode === "fixed" ? 1 : (policy?.multiplier ?? 2),
    jitterRatio: policy?.jitterRatio ?? 0.2,
  };
}

function calculateReconnectDelay(
  attempt: number,
  policy: ResolvedReconnectPolicy
): number {
  const exponent = policy.mode === "fixed" ? 0 : Math.max(0, attempt - 1);
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

function clampBatchSize(batchSize: number | undefined): number | undefined {
  if (batchSize === undefined || !Number.isInteger(batchSize)) {
    return undefined;
  }

  if (!(batchSize >= 1 && batchSize <= 1000)) {
    return undefined;
  }

  return batchSize;
}

export class TailSocketManagerRegistry {
  private readonly managers = new Map<string, StarciteSocketManager>();

  getManager(input: {
    auth: TailSocketAuthContext;
    socketUrl: string;
  }): StarciteSocketManager {
    const key = `${input.socketUrl}|${input.auth.key}`;
    let manager = this.managers.get(key);

    if (!manager) {
      manager = new StarciteSocketManager({
        auth: input.auth,
        onEmpty: () => {
          this.managers.delete(key);
        },
        socketUrl: input.socketUrl,
      });
      this.managers.set(key, manager);
    }

    return manager;
  }
}

class StarciteSocketManager {
  private readonly auth: TailSocketAuthContext;
  private manualReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onEmpty: () => void;
  private reconnectContext:
    | {
        trigger: "connect_failed" | "dropped";
        closeCode?: number;
        closeReason?: string;
      }
    | undefined;
  private readonly records = new Map<string, SessionRecord>();
  private sawTransportErrorSinceOpen = false;
  private socket: Socket | undefined;
  private socketCallbackRefs: string[] = [];
  private readonly socketUrl: string;
  private suppressSocketClose = false;

  constructor(input: {
    auth: TailSocketAuthContext;
    onEmpty: () => void;
    socketUrl: string;
  }) {
    this.auth = input.auth;
    this.onEmpty = input.onEmpty;
    this.socketUrl = input.socketUrl;
  }

  subscribe(input: {
    batchSize?: number;
    connectionTimeoutMs: number;
    cursor: TailCursor;
    onConnectionTimeout: (payload: {
      closeCode: number;
      closeReason: string;
    }) => void;
    onEvents: (events: TailEvent[]) => void;
    onGap: (gap: TailGap) => void;
    onLifecycle: (event: TailSocketLifecycleEvent) => void;
    onTokenExpired: (payload: TailTokenExpiredPayload) => void;
    reconnectPolicy: TailReconnectPolicy | undefined;
    sessionId: string;
  }): () => void {
    const consumer: TailSocketConsumer = {
      connectionTimeoutMs: input.connectionTimeoutMs,
      connectionTimeoutTimer: undefined,
      onConnectionTimeout: input.onConnectionTimeout,
      onEvents: input.onEvents,
      onGap: input.onGap,
      onLifecycle: input.onLifecycle,
      onTokenExpired: input.onTokenExpired,
      reconnectPolicy: resolveReconnectPolicy(input.reconnectPolicy),
    };

    const existingRecord = this.records.get(input.sessionId);
    if (existingRecord) {
      existingRecord.consumers.add(consumer);
      if (!existingRecord.ready) {
        this.armConnectionTimeout(existingRecord, consumer);
      }
      this.ensureSocketConnected();
      return () => {
        this.unsubscribeConsumer(existingRecord, consumer);
      };
    }

    const channel = this.ensureSocket().channel(
      `tail:${input.sessionId}`,
      () => {
        const payload: {
          batch_size?: number;
          cursor: TailCursor;
        } = {
          cursor: record.lastCursor,
        };

        if (record.batchSize !== undefined) {
          payload.batch_size = record.batchSize;
        }

        return payload;
      }
    ) as RejoinableChannel;

    const record: SessionRecord = {
      attempt: 0,
      awaitingAttempt: true,
      batchSize: clampBatchSize(input.batchSize),
      channel,
      consumers: new Set([consumer]),
      eventBindingRef: 0,
      gapBindingRef: 0,
      lastCursor: input.cursor,
      ready: false,
      sessionId: input.sessionId,
      tokenExpiredBindingRef: 0,
    };

    const originalRejoin = channel.rejoin.bind(channel);
    channel.rejoin = (timeout?: number) => {
      this.startAttempt(record);
      return originalRejoin(timeout);
    };

    record.eventBindingRef = channel.on("events", (payload) => {
      this.handleEvents(record, payload);
    });
    record.gapBindingRef = channel.on("gap", (payload) => {
      this.handleGap(record, payload);
    });
    record.tokenExpiredBindingRef = channel.on("token_expired", (payload) => {
      this.handleTokenExpired(record, payload);
    });

    const joinPush = channel.join();
    joinPush
      .receive("ok", () => {
        this.handleJoinOk(record);
      })
      .receive("error", (payload) => {
        this.handleJoinFailure(record, describeJoinFailure(payload));
      })
      .receive("timeout", () => {
        this.handleJoinFailure(record, "join timeout");
      });

    this.records.set(input.sessionId, record);
    this.ensureSocketConnected();

    return () => {
      this.unsubscribeConsumer(record, consumer);
    };
  }

  private armConnectionTimeout(
    record: SessionRecord,
    consumer: TailSocketConsumer
  ): void {
    this.clearConnectionTimeout(consumer);

    if (consumer.connectionTimeoutMs <= 0 || record.ready) {
      return;
    }

    consumer.connectionTimeoutTimer = setTimeout(() => {
      consumer.connectionTimeoutTimer = undefined;

      if (!record.consumers.has(consumer) || record.ready) {
        return;
      }

      consumer.onConnectionTimeout({
        closeCode: CONNECTION_TIMEOUT_CLOSE_CODE,
        closeReason: CONNECTION_TIMEOUT_REASON,
      });
    }, consumer.connectionTimeoutMs);
  }

  private armConnectionTimeouts(record: SessionRecord): void {
    for (const consumer of record.consumers) {
      this.armConnectionTimeout(record, consumer);
    }
  }

  private broadcast(
    record: SessionRecord,
    event: TailSocketLifecycleEvent
  ): void {
    for (const consumer of [...record.consumers]) {
      consumer.onLifecycle(event);
    }
  }

  private broadcastAll(
    callback: (record: SessionRecord) => TailSocketLifecycleEvent | undefined
  ): void {
    for (const record of this.records.values()) {
      const event = callback(record);
      if (event) {
        this.broadcast(record, event);
      }
    }
  }

  private clearConnectionTimeout(consumer: TailSocketConsumer): void {
    if (!consumer.connectionTimeoutTimer) {
      return;
    }

    clearTimeout(consumer.connectionTimeoutTimer);
    consumer.connectionTimeoutTimer = undefined;
  }

  private clearConnectionTimeouts(record: SessionRecord): void {
    for (const consumer of record.consumers) {
      this.clearConnectionTimeout(consumer);
    }
  }

  private clearManualReconnectTimer(): void {
    if (!this.manualReconnectTimer) {
      return;
    }

    clearTimeout(this.manualReconnectTimer);
    this.manualReconnectTimer = undefined;
  }

  private computeSocketReconnectDelay(attempt: number): number {
    let minimumDelayMs: number | undefined;

    for (const record of this.records.values()) {
      for (const consumer of record.consumers) {
        const delayMs = calculateReconnectDelay(
          attempt,
          consumer.reconnectPolicy
        );
        minimumDelayMs =
          minimumDelayMs === undefined
            ? delayMs
            : Math.min(minimumDelayMs, delayMs);
      }
    }

    return minimumDelayMs ?? 500;
  }

  private ensureSocket(): Socket {
    if (this.socket) {
      return this.socket;
    }

    const socket = new Socket(this.socketUrl, {
      params: () => {
        if (!this.auth.token) {
          return {};
        }

        return {
          access_token: this.auth.token,
          token: this.auth.token,
        };
      },
      reconnectAfterMs: (tries) => {
        const delayMs = this.computeSocketReconnectDelay(tries);
        const reconnectContext = this.reconnectContext ?? {
          trigger: "dropped" as const,
        };

        queueMicrotask(() => {
          this.broadcastAll((record) => {
            this.clearConnectionTimeouts(record);
            record.awaitingAttempt = true;
            record.ready = false;
            return {
              attempt: record.attempt,
              closeCode: reconnectContext.closeCode,
              closeReason: reconnectContext.closeReason,
              delayMs,
              trigger: reconnectContext.trigger,
              type: "reconnect_scheduled",
            };
          });
        });

        return delayMs;
      },
      rejoinAfterMs: (tries) => {
        return this.computeSocketReconnectDelay(tries);
      },
    });

    const originalConnect = socket.connect.bind(socket);
    socket.connect = (params?: unknown) => {
      this.clearManualReconnectTimer();
      this.startPendingAttempts();
      originalConnect(params);
    };

    this.socket = socket;
    this.socketCallbackRefs = [
      socket.onOpen(() => {
        this.clearManualReconnectTimer();
        this.reconnectContext = undefined;
        this.sawTransportErrorSinceOpen = false;
        this.broadcastAll(() => {
          return { type: "open" };
        });
      }),
      socket.onClose((event) => {
        if (this.suppressSocketClose) {
          return;
        }

        this.reconnectContext = {
          closeCode: event.code,
          closeReason: event.reason,
          trigger: "dropped",
        };

        this.broadcastAll((record) => {
          record.ready = false;
          return {
            attempt: record.attempt,
            closeCode: event.code,
            closeReason: event.reason,
            type: "dropped",
          };
        });

        if (event.code === 1000 && this.sawTransportErrorSinceOpen) {
          this.scheduleManualSocketReconnect({
            closeCode: event.code,
            closeReason: event.reason,
          });
        }
      }),
      socket.onError((error, _transport, establishedConnections) => {
        if (establishedConnections > 0) {
          this.sawTransportErrorSinceOpen = true;
          return;
        }

        const rootCause = describeError(error);
        this.reconnectContext = {
          trigger: "connect_failed",
        };
        this.broadcastAll((record) => {
          record.ready = false;
          return {
            attempt: record.attempt,
            rootCause,
            type: "connect_failed",
          };
        });
      }),
    ];

    return socket;
  }

  private ensureSocketConnected(): void {
    const socket = this.ensureSocket();
    if (socket.isConnected()) {
      return;
    }

    socket.connect();
  }

  private handleEvents(record: SessionRecord, payload: unknown): void {
    const result = TailEventsPayloadSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    record.ready = true;
    this.clearConnectionTimeouts(record);

    for (const event of result.data.events) {
      record.lastCursor = event.cursor ?? event.seq;
    }

    for (const consumer of [...record.consumers]) {
      consumer.onEvents(result.data.events);
    }
  }

  private handleGap(record: SessionRecord, payload: unknown): void {
    const result = TailGapSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    for (const consumer of [...record.consumers]) {
      consumer.onGap(result.data);
    }

    record.ready = false;
    record.awaitingAttempt = true;
    record.channel.rejoin();
  }

  private handleJoinFailure(record: SessionRecord, rootCause: string): void {
    if (!this.records.has(record.sessionId) || record.consumers.size === 0) {
      return;
    }

    this.clearConnectionTimeouts(record);
    record.ready = false;
    record.awaitingAttempt = true;
    this.broadcast(record, {
      attempt: record.attempt,
      rootCause,
      type: "connect_failed",
    });

    if (this.socket?.isConnected()) {
      this.broadcast(record, {
        attempt: record.attempt,
        delayMs: this.computeSocketReconnectDelay(record.attempt),
        trigger: "connect_failed",
        type: "reconnect_scheduled",
      });
    }
  }

  private handleJoinOk(record: SessionRecord): void {
    if (!this.records.has(record.sessionId)) {
      return;
    }

    record.ready = true;
    record.awaitingAttempt = false;
    this.clearConnectionTimeouts(record);
  }

  private handleTokenExpired(record: SessionRecord, payload: unknown): void {
    const result = TailTokenExpiredPayloadSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    for (const consumer of [...record.consumers]) {
      consumer.onTokenExpired(result.data);
    }
  }

  private scheduleManualSocketReconnect(input: {
    closeCode?: number;
    closeReason?: string;
  }): void {
    if (this.manualReconnectTimer || this.records.size === 0) {
      return;
    }

    const delayMs = this.computeSocketReconnectDelay(
      Math.max(
        1,
        ...[...this.records.values()].map((record) => {
          return record.attempt;
        })
      )
    );

    this.broadcastAll((record) => {
      this.clearConnectionTimeouts(record);
      record.awaitingAttempt = true;
      record.ready = false;
      return {
        attempt: record.attempt,
        closeCode: input.closeCode,
        closeReason: input.closeReason,
        delayMs,
        trigger: "dropped",
        type: "reconnect_scheduled",
      };
    });

    this.manualReconnectTimer = setTimeout(() => {
      this.manualReconnectTimer = undefined;

      if (this.records.size === 0 || this.socket?.isConnected()) {
        return;
      }

      this.ensureSocketConnected();
    }, delayMs);
  }

  private startAttempt(record: SessionRecord): void {
    if (!record.awaitingAttempt || record.consumers.size === 0) {
      return;
    }

    record.awaitingAttempt = false;
    record.ready = false;
    record.attempt += 1;
    this.armConnectionTimeouts(record);
    this.broadcast(record, {
      attempt: record.attempt,
      type: "connect_attempt",
    });
  }

  private startPendingAttempts(): void {
    for (const record of this.records.values()) {
      this.startAttempt(record);
    }
  }

  private teardownSocket(): void {
    if (!this.socket) {
      return;
    }

    this.clearManualReconnectTimer();
    this.sawTransportErrorSinceOpen = false;
    this.suppressSocketClose = true;
    this.socket.off(this.socketCallbackRefs);
    this.socket.disconnect();
    this.socket = undefined;
    this.socketCallbackRefs = [];
    this.suppressSocketClose = false;
  }

  private unsubscribeConsumer(
    record: SessionRecord,
    consumer: TailSocketConsumer
  ): void {
    this.clearConnectionTimeout(consumer);
    record.consumers.delete(consumer);
    if (record.consumers.size > 0) {
      return;
    }

    record.channel.off("events", record.eventBindingRef);
    record.channel.off("gap", record.gapBindingRef);
    record.channel.off("token_expired", record.tokenExpiredBindingRef);
    record.channel.leave();
    this.records.delete(record.sessionId);

    if (this.records.size === 0) {
      this.teardownSocket();
      this.onEmpty();
    }
  }
}
