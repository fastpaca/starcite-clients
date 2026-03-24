import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import type { TransportConfig } from "./transport";
import type { SessionCreatedLifecycleEvent, StarciteWebSocket } from "./types";
import { SessionCreatedLifecycleEventSchema } from "./types";

const PHOENIX_VSN = "2.0.0";
const PHOENIX_TOPIC = "phoenix";
const LIFECYCLE_TOPIC = "lifecycle";
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;

interface LifecycleRuntimeEvents {
  "session.created": (event: SessionCreatedLifecycleEvent) => void;
  error: (error: Error) => void;
}

type PhoenixFrame = [string | null, string | null, string, string, unknown];

/**
 * Minimal Phoenix channel client for Starcite lifecycle events.
 *
 * This keeps the public API simple (`starcite.on(...)`) while hiding the
 * Phoenix join / heartbeat / reconnect mechanics needed to subscribe to the
 * backend-only `lifecycle` topic on `/v1/socket`.
 */
export class LifecycleRuntime {
  private readonly transport: TransportConfig;
  private readonly token: string;
  private readonly emitter = new EventEmitter<LifecycleRuntimeEvents>();

  private socket: StarciteWebSocket | undefined;
  private joinRef: string | undefined;
  private ref = 0;
  private reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private explicitClose = false;
  private terminalFailure = false;

  constructor(options: { transport: TransportConfig; token: string }) {
    this.transport = options.transport;
    this.token = options.token;
  }

  on(
    eventName: "session.created",
    listener: (event: SessionCreatedLifecycleEvent) => void
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "session.created" | "error",
    listener:
      | ((event: SessionCreatedLifecycleEvent) => void)
      | ((error: Error) => void)
  ): () => void {
    if (eventName === "session.created") {
      this.emitter.on(
        eventName,
        listener as (event: SessionCreatedLifecycleEvent) => void
      );
    } else {
      this.emitter.on(eventName, listener as (error: Error) => void);
    }

    this.explicitClose = false;
    this.ensureConnected();
    return () => {
      if (eventName === "session.created") {
        this.off(
          eventName,
          listener as (event: SessionCreatedLifecycleEvent) => void
        );
      } else {
        this.off(eventName, listener as (error: Error) => void);
      }
    };
  }

  off(
    eventName: "session.created",
    listener: (event: SessionCreatedLifecycleEvent) => void
  ): void;
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "session.created" | "error",
    listener:
      | ((event: SessionCreatedLifecycleEvent) => void)
      | ((error: Error) => void)
  ): void {
    if (eventName === "session.created") {
      this.emitter.off(
        eventName,
        listener as (event: SessionCreatedLifecycleEvent) => void
      );
    } else {
      this.emitter.off(eventName, listener as (error: Error) => void);
    }

    if (this.listenerCount() === 0) {
      this.close();
    }
  }

  close(): void {
    this.explicitClose = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.socket?.close(1000, "closed");
    this.socket = undefined;
    this.joinRef = undefined;
  }

  private listenerCount(): number {
    return (
      this.emitter.listenerCount("session.created") +
      this.emitter.listenerCount("error")
    );
  }

  private ensureConnected(): void {
    if (
      this.socket ||
      this.terminalFailure ||
      this.reconnectTimer !== undefined ||
      this.listenerCount() === 0
    ) {
      return;
    }

    const socket = this.transport.websocketFactory(this.buildSocketUrl());
    this.socket = socket;

    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("error", this.handleError);
    socket.addEventListener("close", this.handleClose);
  }

  private readonly handleOpen = (): void => {
    this.joinRef = this.nextRef();
    this.sendFrame([
      this.joinRef,
      this.joinRef,
      LIFECYCLE_TOPIC,
      "phx_join",
      {},
    ]);
    this.startHeartbeat();
  };

  private readonly handleMessage = (event: { data: unknown }): void => {
    const frame = this.parseFrame(event.data);
    if (!frame) {
      return;
    }

    const [, ref, topic, channelEvent, payload] = frame;
    if (topic !== LIFECYCLE_TOPIC && topic !== PHOENIX_TOPIC) {
      return;
    }

    if (
      topic === LIFECYCLE_TOPIC &&
      channelEvent === "phx_reply" &&
      ref === this.joinRef
    ) {
      this.handleJoinReply(payload);
      return;
    }

    if (topic === LIFECYCLE_TOPIC && channelEvent === "lifecycle") {
      this.handleLifecyclePayload(payload);
      return;
    }

    if (topic === LIFECYCLE_TOPIC && channelEvent === "token_expired") {
      this.emitError(new StarciteError("Lifecycle subscription token expired"));
      this.terminalFailure = true;
      this.close();
      return;
    }

    if (
      channelEvent === "phx_close" ||
      channelEvent === "phx_error" ||
      (topic === PHOENIX_TOPIC && channelEvent === "phx_error")
    ) {
      this.socket?.close(1011, channelEvent);
    }
  };

  private handleJoinReply(payload: unknown): void {
    const parsed = payload as {
      status?: unknown;
      response?: { reason?: unknown };
    };

    if (parsed.status === "ok") {
      this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      return;
    }

    const reason =
      typeof parsed.response?.reason === "string"
        ? parsed.response.reason
        : "join_failed";
    this.terminalFailure = true;
    this.emitError(
      new StarciteError(`Lifecycle subscription failed: ${reason}`)
    );
    this.close();
  }

  private handleLifecyclePayload(payload: unknown): void {
    const envelope = payload as { event?: unknown };
    const parsed = SessionCreatedLifecycleEventSchema.safeParse(envelope.event);
    if (!parsed.success) {
      this.emitError(
        new StarciteError(
          `Invalid lifecycle payload: ${parsed.error.issues[0]?.message ?? "parse failed"}`
        )
      );
      return;
    }

    if (parsed.data.kind === "session.created") {
      this.emitter.emit("session.created", parsed.data);
    }
  }

  private readonly handleError = (): void => {
    // Phoenix transports typically follow with a close event; reconnect is driven there.
  };

  private readonly handleClose = (event: {
    code?: number;
    reason?: string;
  }): void => {
    this.clearHeartbeatTimer();
    this.socket = undefined;
    this.joinRef = undefined;

    if (
      this.explicitClose ||
      this.terminalFailure ||
      this.listenerCount() === 0
    ) {
      return;
    }

    this.emitError(
      new StarciteError(
        `Lifecycle socket closed${event.code ? ` (code ${event.code}${event.reason ? `, reason '${event.reason}'` : ""})` : ""}`
      )
    );
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_DELAY_MS
    );
  }

  private buildSocketUrl(): string {
    const url = new URL(`${this.transport.websocketBaseUrl}/socket/websocket`);
    url.searchParams.set("token", this.token);
    url.searchParams.set("vsn", PHOENIX_VSN);
    return url.toString();
  }

  private sendFrame(frame: PhoenixFrame): void {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.emitError(
        error instanceof Error
          ? error
          : new StarciteError(`Lifecycle send failed: ${String(error)}`)
      );
      this.socket.close(1011, "send failed");
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) {
        return;
      }

      this.sendFrame([null, this.nextRef(), PHOENIX_TOPIC, "heartbeat", {}]);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private nextRef(): string {
    this.ref += 1;
    return `${this.ref}`;
  }

  private parseFrame(data: unknown): PhoenixFrame | undefined {
    if (typeof data !== "string") {
      this.emitError(
        new StarciteError("Lifecycle socket received a non-text frame")
      );
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      this.emitError(
        new StarciteError(
          `Lifecycle socket received invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return undefined;
    }

    if (!Array.isArray(parsed) || parsed.length !== 5) {
      this.emitError(
        new StarciteError("Lifecycle socket received an invalid Phoenix frame")
      );
      return undefined;
    }

    const [joinRef, ref, topic, event, payload] = parsed;
    if (
      (joinRef !== null && typeof joinRef !== "string") ||
      (ref !== null && typeof ref !== "string") ||
      typeof topic !== "string" ||
      typeof event !== "string"
    ) {
      this.emitError(
        new StarciteError("Lifecycle socket received a malformed Phoenix frame")
      );
      return undefined;
    }

    return [joinRef, ref, topic, event, payload];
  }

  private emitError(error: Error): void {
    if (this.emitter.listenerCount("error") > 0) {
      this.emitter.emit("error", error);
      return;
    }

    queueMicrotask(() => {
      throw error;
    });
  }
}
