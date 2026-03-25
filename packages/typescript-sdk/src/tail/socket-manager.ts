import { type Channel, Socket } from "phoenix";
import { z } from "zod";
import type {
  TailCursor,
  TailEvent,
  TailGap,
  TailTokenExpiredPayload,
} from "../types";
import {
  TailEventSchema,
  TailGapSchema,
  TailTokenExpiredPayloadSchema,
} from "../types";

const CONNECTION_TIMEOUT_CLOSE_CODE = 4100;
const CONNECTION_TIMEOUT_REASON = "connection timeout";
const ENCODED_CURSOR_PATTERN = /^(\d+):(\d+)$/;

const TailEventsPayloadSchema = z.object({
  events: z.array(TailEventSchema),
});

export interface TailSocketAuthContext {
  key: string;
  token: string | undefined;
}

export interface TailSocketReconnectPolicy {
  initialDelayMs: number;
  jitterRatio: number;
  maxDelayMs: number;
  mode: "fixed" | "exponential";
  multiplier: number;
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

interface TailSubscription {
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
  reconnectPolicy: TailSocketReconnectPolicy;
}

interface ConnectionState {
  auth: TailSocketAuthContext;
  closedByClient: boolean;
  manualReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  reconnectContext:
    | {
        trigger: "connect_failed" | "dropped";
        closeCode?: number;
        closeReason?: string;
      }
    | undefined;
  sawTransportErrorSinceOpen: boolean;
  sessions: Map<string, TailSession>;
  socket: Socket | undefined;
  socketUrl: string;
}

interface RejoinableChannel extends Channel {
  rejoin: (timeout?: number) => void;
}

interface TailSession {
  attempt: number;
  awaitingAttempt: boolean;
  batchSize: number | undefined;
  channel: RejoinableChannel;
  subscriptions: Set<TailSubscription>;
  eventBindingRef: number;
  history: TailEvent[];
  gapBindingRef: number;
  lastCursor: TailCursor;
  ready: boolean;
  sessionId: string;
  tokenExpiredBindingRef: number;
}

export class TailSocketManager {
  private readonly connections = new Map<string, ConnectionState>();

  /**
   * Maintains one shared Phoenix socket per auth context and one joined
   * `tail:<sessionId>` channel per active session topic. Multiple local SDK
   * subscribers can attach to the same TailSession and receive the same events.
   */
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
    reconnectPolicy: TailSocketReconnectPolicy;
    sessionId: string;
    socketAuth: TailSocketAuthContext;
    socketUrl: string;
  }): () => void {
    const connection = this.getConnection(input.socketUrl, input.socketAuth);
    const subscription: TailSubscription = {
      connectionTimeoutMs: input.connectionTimeoutMs,
      connectionTimeoutTimer: undefined,
      onConnectionTimeout: input.onConnectionTimeout,
      onEvents: input.onEvents,
      onGap: input.onGap,
      onLifecycle: input.onLifecycle,
      onTokenExpired: input.onTokenExpired,
      reconnectPolicy: input.reconnectPolicy,
    };

    const existingSession = connection.sessions.get(input.sessionId);
    if (existingSession) {
      existingSession.subscriptions.add(subscription);
      // A second local subscriber must catch up from the existing channel's
      // buffered history instead of opening a second Phoenix channel.
      const bufferedEvents = existingSession.history.filter((event) => {
        return this.isEventAfterCursor(event, input.cursor);
      });
      if (bufferedEvents.length > 0) {
        subscription.onEvents(bufferedEvents);
      }
      if (!existingSession.ready) {
        this.armConnectionTimeout(existingSession, subscription);
      }
      this.ensureConnected(connection);
      return () => {
        this.unsubscribe(connection, existingSession, subscription);
      };
    }

    let session: TailSession;
    const channel = this.ensureSocket(connection).channel(
      `tail:${input.sessionId}`,
      () => {
        // Phoenix re-evaluates channel params on rejoin, so this closure always
        // sends the session's latest resume cursor instead of the original one.
        const payload: {
          batch_size?: number;
          cursor: TailCursor;
        } = {
          cursor: session.lastCursor,
        };

        if (session.batchSize !== undefined) {
          payload.batch_size = session.batchSize;
        }

        return payload;
      }
    ) as RejoinableChannel;

    session = {
      attempt: 0,
      awaitingAttempt: true,
      batchSize: input.batchSize,
      channel,
      subscriptions: new Set([subscription]),
      eventBindingRef: 0,
      history: [],
      gapBindingRef: 0,
      lastCursor: input.cursor,
      ready: false,
      sessionId: input.sessionId,
      tokenExpiredBindingRef: 0,
    };

    const rejoin = channel.rejoin.bind(channel);
    channel.rejoin = (timeout?: number) => {
      // Phoenix tracks socket reconnects for us, but we still need per-session
      // attempt accounting for lifecycle events and timeout enforcement.
      this.startAttempt(session);
      return rejoin(timeout);
    };

    session.eventBindingRef = channel.on("events", (payload) => {
      this.handleEvents(session, payload);
    });
    session.gapBindingRef = channel.on("gap", (payload) => {
      this.handleGap(session, payload);
    });
    session.tokenExpiredBindingRef = channel.on("token_expired", (payload) => {
      this.handleTokenExpired(session, payload);
    });

    channel
      .join()
      .receive("ok", () => {
        if (!connection.sessions.has(session.sessionId)) {
          return;
        }

        session.ready = true;
        session.awaitingAttempt = false;
        this.clearConnectionTimeouts(session);
      })
      .receive("error", (payload) => {
        let rootCause = "join failed";

        if (payload instanceof Error) {
          rootCause = payload.message;
        } else if (typeof payload === "string") {
          rootCause = payload;
        } else if (typeof payload === "object" && payload !== null) {
          if ("reason" in payload && typeof payload.reason === "string") {
            rootCause = payload.reason;
          } else if (
            "message" in payload &&
            typeof payload.message === "string"
          ) {
            rootCause = payload.message;
          }
        }

        this.handleJoinFailure(connection, session, rootCause);
      })
      .receive("timeout", () => {
        this.handleJoinFailure(connection, session, "join timeout");
      });

    connection.sessions.set(session.sessionId, session);
    this.ensureConnected(connection);

    return () => {
      this.unsubscribe(connection, session, subscription);
    };
  }

  private armConnectionTimeout(
    session: TailSession,
    subscription: TailSubscription
  ): void {
    this.clearConnectionTimeout(subscription);

    if (subscription.connectionTimeoutMs <= 0 || session.ready) {
      return;
    }

    subscription.connectionTimeoutTimer = setTimeout(() => {
      subscription.connectionTimeoutTimer = undefined;

      if (!session.subscriptions.has(subscription) || session.ready) {
        return;
      }

      subscription.onConnectionTimeout({
        closeCode: CONNECTION_TIMEOUT_CLOSE_CODE,
        closeReason: CONNECTION_TIMEOUT_REASON,
      });
    }, subscription.connectionTimeoutMs);
  }

  private armConnectionTimeouts(session: TailSession): void {
    for (const subscription of session.subscriptions) {
      this.armConnectionTimeout(session, subscription);
    }
  }

  private broadcast(
    session: TailSession,
    event: TailSocketLifecycleEvent
  ): void {
    for (const subscription of session.subscriptions) {
      subscription.onLifecycle(event);
    }
  }

  private broadcastAll(
    connection: ConnectionState,
    getEvent: (session: TailSession) => TailSocketLifecycleEvent | undefined
  ): void {
    for (const session of connection.sessions.values()) {
      const event = getEvent(session);
      if (event) {
        this.broadcast(session, event);
      }
    }
  }

  private clearConnectionTimeout(subscription: TailSubscription): void {
    if (!subscription.connectionTimeoutTimer) {
      return;
    }

    clearTimeout(subscription.connectionTimeoutTimer);
    subscription.connectionTimeoutTimer = undefined;
  }

  private clearConnectionTimeouts(session: TailSession): void {
    for (const subscription of session.subscriptions) {
      this.clearConnectionTimeout(subscription);
    }
  }

  private clearManualReconnectTimer(connection: ConnectionState): void {
    if (!connection.manualReconnectTimer) {
      return;
    }

    clearTimeout(connection.manualReconnectTimer);
    connection.manualReconnectTimer = undefined;
  }

  private computeReconnectDelay(
    connection: ConnectionState,
    attempt: number
  ): number {
    let delayMs: number | undefined;

    for (const session of connection.sessions.values()) {
      for (const subscription of session.subscriptions) {
        const policy = subscription.reconnectPolicy;
        const exponent = policy.mode === "fixed" ? 0 : Math.max(0, attempt - 1);
        const baseDelayMs = Math.min(
          policy.initialDelayMs * policy.multiplier ** exponent,
          policy.maxDelayMs
        );
        const spreadMs = Math.round(baseDelayMs * policy.jitterRatio);
        const minimumDelayMs = Math.max(0, baseDelayMs - spreadMs);
        const maximumDelayMs = baseDelayMs + spreadMs;
        const candidateDelayMs =
          spreadMs === 0
            ? baseDelayMs
            : Math.round(
                minimumDelayMs +
                  Math.random() * (maximumDelayMs - minimumDelayMs)
              );

        delayMs =
          delayMs === undefined
            ? candidateDelayMs
            : Math.min(delayMs, candidateDelayMs);
      }
    }

    return delayMs ?? 500;
  }

  private ensureConnected(connection: ConnectionState): void {
    const socket = this.ensureSocket(connection);
    if (socket.isConnected()) {
      return;
    }

    socket.connect();
  }

  private ensureSocket(connection: ConnectionState): Socket {
    if (connection.socket) {
      return connection.socket;
    }

    const socket = new Socket(connection.socketUrl, {
      params: () => {
        if (!connection.auth.token) {
          return {};
        }

        return {
          token: connection.auth.token,
        };
      },
      reconnectAfterMs: (tries) => {
        const delayMs = this.computeReconnectDelay(connection, tries);
        const reconnectContext = connection.reconnectContext ?? {
          trigger: "dropped" as const,
        };

        // Phoenix invokes this while it is scheduling its own reconnect work.
        // Defer our fan-out so consumers observe the updated session state.
        queueMicrotask(() => {
          this.broadcastAll(connection, (session) => {
            this.clearConnectionTimeouts(session);
            session.awaitingAttempt = true;
            session.ready = false;
            return {
              attempt: session.attempt,
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
        return this.computeReconnectDelay(connection, tries);
      },
    });

    const connect = socket.connect.bind(socket);
    socket.connect = (params?: unknown) => {
      this.clearManualReconnectTimer(connection);
      this.startPendingAttempts(connection);
      connect(params);
    };

    socket.onOpen(() => {
      if (connection.closedByClient) {
        return;
      }

      this.clearManualReconnectTimer(connection);
      connection.reconnectContext = undefined;
      connection.sawTransportErrorSinceOpen = false;
      this.broadcastAll(connection, () => {
        return { type: "open" };
      });
    });

    socket.onClose((event) => {
      if (connection.closedByClient) {
        return;
      }

      connection.reconnectContext = {
        closeCode: event.code,
        closeReason: event.reason,
        trigger: "dropped",
      };
      this.broadcastAll(connection, (session) => {
        session.ready = false;
        return {
          attempt: session.attempt,
          closeCode: event.code,
          closeReason: event.reason,
          type: "dropped",
        };
      });

      if (event.code === 1000 && connection.sawTransportErrorSinceOpen) {
        this.scheduleManualReconnect(connection, {
          closeCode: event.code,
          closeReason: event.reason,
        });
      }
    });

    socket.onError((error, _transport, establishedConnections) => {
      if (connection.closedByClient) {
        return;
      }

      if (establishedConnections > 0) {
        // Phoenix will follow an established transport error with onClose. Keep
        // this marker so a later close(1000) is still treated as a drop.
        connection.sawTransportErrorSinceOpen = true;
        return;
      }

      connection.reconnectContext = {
        trigger: "connect_failed",
      };

      const rootCause = error instanceof Error ? error.message : String(error);
      this.broadcastAll(connection, (session) => {
        session.ready = false;
        return {
          attempt: session.attempt,
          rootCause,
          type: "connect_failed",
        };
      });
    });

    connection.socket = socket;
    return socket;
  }

  private getConnection(
    socketUrl: string,
    auth: TailSocketAuthContext
  ): ConnectionState {
    const key = `${socketUrl}|${auth.key}`;
    let connection = this.connections.get(key);

    if (!connection) {
      connection = {
        auth,
        closedByClient: false,
        manualReconnectTimer: undefined,
        reconnectContext: undefined,
        sawTransportErrorSinceOpen: false,
        sessions: new Map(),
        socket: undefined,
        socketUrl,
      };
      this.connections.set(key, connection);
    }

    return connection;
  }

  private isEventAfterCursor(event: TailEvent, cursor: TailCursor): boolean {
    // Local subscribers share one joined channel, so late subscribers replay
    // from buffered channel history by comparing each event against their
    // requested resume cursor.
    if (typeof cursor === "number") {
      return event.seq > cursor;
    }

    const cursorMatch = ENCODED_CURSOR_PATTERN.exec(cursor);
    if (!cursorMatch) {
      return false;
    }

    const cursorEpoch = Number(cursorMatch[1]);
    const cursorSeq = Number(cursorMatch[2]);
    const eventCursor = event.cursor;

    if (typeof eventCursor === "string") {
      const eventMatch = ENCODED_CURSOR_PATTERN.exec(eventCursor);
      if (!eventMatch) {
        return event.seq > cursorSeq;
      }

      const eventEpoch = Number(eventMatch[1]);
      const eventSeq = Number(eventMatch[2]);
      return (
        eventEpoch > cursorEpoch ||
        (eventEpoch === cursorEpoch && eventSeq > cursorSeq)
      );
    }

    if (typeof eventCursor === "number") {
      return eventCursor > cursorSeq;
    }

    return event.seq > cursorSeq;
  }

  private handleEvents(session: TailSession, payload: unknown): void {
    const result = TailEventsPayloadSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    session.ready = true;
    this.clearConnectionTimeouts(session);

    for (const event of result.data.events) {
      session.history.push(event);
      session.lastCursor = event.cursor ?? event.seq;
    }

    for (const subscription of session.subscriptions) {
      subscription.onEvents(result.data.events);
    }
  }

  private handleGap(session: TailSession, payload: unknown): void {
    const result = TailGapSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    for (const subscription of session.subscriptions) {
      subscription.onGap(result.data);
    }

    session.ready = false;
    session.awaitingAttempt = true;
    session.channel.rejoin();
  }

  private handleJoinFailure(
    connection: ConnectionState,
    session: TailSession,
    rootCause: string
  ): void {
    if (
      !connection.sessions.has(session.sessionId) ||
      session.subscriptions.size === 0
    ) {
      return;
    }

    this.clearConnectionTimeouts(session);
    session.ready = false;
    session.awaitingAttempt = true;
    this.broadcast(session, {
      attempt: session.attempt,
      rootCause,
      type: "connect_failed",
    });

    if (connection.socket?.isConnected()) {
      this.broadcast(session, {
        attempt: session.attempt,
        delayMs: this.computeReconnectDelay(connection, session.attempt),
        trigger: "connect_failed",
        type: "reconnect_scheduled",
      });
    }
  }

  private handleTokenExpired(session: TailSession, payload: unknown): void {
    const result = TailTokenExpiredPayloadSchema.safeParse(payload);
    if (!result.success) {
      return;
    }

    for (const subscription of session.subscriptions) {
      subscription.onTokenExpired(result.data);
    }
  }

  private scheduleManualReconnect(
    connection: ConnectionState,
    input: {
      closeCode?: number;
      closeReason?: string;
    }
  ): void {
    if (connection.manualReconnectTimer || connection.sessions.size === 0) {
      return;
    }

    // Phoenix does not reconnect after a normal close code. When we know that
    // close(1000) followed a transport error, schedule one reconnect ourselves.
    const delayMs = this.computeReconnectDelay(
      connection,
      Math.max(
        1,
        ...[...connection.sessions.values()].map((session) => session.attempt)
      )
    );

    this.broadcastAll(connection, (session) => {
      this.clearConnectionTimeouts(session);
      session.awaitingAttempt = true;
      session.ready = false;
      return {
        attempt: session.attempt,
        closeCode: input.closeCode,
        closeReason: input.closeReason,
        delayMs,
        trigger: "dropped",
        type: "reconnect_scheduled",
      };
    });

    connection.manualReconnectTimer = setTimeout(() => {
      connection.manualReconnectTimer = undefined;

      if (connection.sessions.size === 0 || connection.socket?.isConnected()) {
        return;
      }

      this.ensureConnected(connection);
    }, delayMs);
  }

  private startAttempt(session: TailSession): void {
    if (!session.awaitingAttempt || session.subscriptions.size === 0) {
      return;
    }

    session.awaitingAttempt = false;
    session.ready = false;
    session.attempt += 1;
    this.armConnectionTimeouts(session);
    this.broadcast(session, {
      attempt: session.attempt,
      type: "connect_attempt",
    });
  }

  private startPendingAttempts(connection: ConnectionState): void {
    for (const session of connection.sessions.values()) {
      this.startAttempt(session);
    }
  }

  private teardownConnection(connection: ConnectionState): void {
    this.clearManualReconnectTimer(connection);
    connection.closedByClient = true;
    connection.sawTransportErrorSinceOpen = false;

    if (connection.socket) {
      connection.socket.disconnect();
      connection.socket = undefined;
    }

    this.connections.delete(`${connection.socketUrl}|${connection.auth.key}`);
  }

  private unsubscribe(
    connection: ConnectionState,
    session: TailSession,
    subscription: TailSubscription
  ): void {
    this.clearConnectionTimeout(subscription);
    session.subscriptions.delete(subscription);
    if (session.subscriptions.size > 0) {
      return;
    }

    // The physical channel only goes away after the last local subscriber for
    // that session detaches.
    session.channel.off("events", session.eventBindingRef);
    session.channel.off("gap", session.gapBindingRef);
    session.channel.off("token_expired", session.tokenExpiredBindingRef);
    session.channel.leave();
    connection.sessions.delete(session.sessionId);

    if (connection.sessions.size === 0) {
      this.teardownConnection(connection);
    }
  }
}
