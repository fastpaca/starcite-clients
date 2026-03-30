import EventEmitter from "eventemitter3";
import { StarciteError } from "./errors";
import {
  type RejoinableChannel,
  readJoinFailureReason,
  type SocketManager,
} from "./socket-manager";
import {
  LifecycleEventEnvelopeSchema,
  type SessionCreatedLifecycleEvent,
  SessionCreatedLifecycleEventSchema,
  TailTokenExpiredPayloadSchema,
} from "./types";

interface LifecycleRuntimeEvents {
  "session.created": (event: SessionCreatedLifecycleEvent) => void;
  error: (error: Error) => void;
}

const LIFECYCLE_TOPIC = "lifecycle";

export class LifecycleRuntime {
  private readonly socketManager: SocketManager;
  private readonly emitter = new EventEmitter<LifecycleRuntimeEvents>();

  private channel: RejoinableChannel | undefined;
  private closeChannel: (() => void) | undefined;
  private lifecycleBindingRef = 0;
  private tokenExpiredBindingRef = 0;
  private terminalFailure = false;

  constructor(options: { socketManager: SocketManager }) {
    this.socketManager = options.socketManager;
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
    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.emitter.on(eventName, listener as any);
    this.ensureChannelAttached();

    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
      this.off(eventName as any, listener as any);
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
    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.emitter.off(eventName, listener as any);

    if (this.listenerCount() === 0) {
      this.close();
    }
  }

  close(): void {
    this.detachChannel();
  }

  private listenerCount(): number {
    return (
      this.emitter.listenerCount("session.created") +
      this.emitter.listenerCount("error")
    );
  }

  private ensureChannelAttached(): void {
    if (this.channel || this.terminalFailure || this.listenerCount() === 0) {
      return;
    }

    const managedChannel = this.socketManager.openChannel<RejoinableChannel>({
      topic: LIFECYCLE_TOPIC,
      params: {},
    });
    const channel = managedChannel.channel;

    this.closeChannel = managedChannel.close;
    this.channel = channel;

    this.lifecycleBindingRef = channel.on("lifecycle", (payload) => {
      this.handleLifecyclePayload(payload);
    });

    this.tokenExpiredBindingRef = channel.on("token_expired", (payload) => {
      const result = TailTokenExpiredPayloadSchema.safeParse(payload);
      if (!result.success) {
        this.emitError(
          new StarciteError(
            `Invalid token_expired payload: ${result.error.issues[0]?.message ?? "parse failed"}`
          )
        );
        return;
      }

      this.terminalFailure = true;
      this.detachChannel();
      this.emitError(new StarciteError("Lifecycle subscription token expired"));
    });

    channel
      .join()
      .receive("error", (payload) => {
        this.emitError(
          new StarciteError(
            `Lifecycle subscription failed: ${readJoinFailureReason(payload)}`
          )
        );
      })
      .receive("timeout", () => {
        this.emitError(
          new StarciteError("Lifecycle subscription failed: join timeout")
        );
      });
  }

  private handleLifecyclePayload(payload: unknown): void {
    const event = (payload as { event?: unknown })?.event;
    const envelope = LifecycleEventEnvelopeSchema.safeParse(event);
    if (!envelope.success) {
      this.emitError(
        new StarciteError(
          `Invalid lifecycle payload: ${envelope.error.issues[0]?.message ?? "parse failed"}`
        )
      );
      return;
    }

    if (envelope.data.kind !== "session.created") {
      return;
    }

    const parsed = SessionCreatedLifecycleEventSchema.safeParse(envelope.data);
    if (!parsed.success) {
      this.emitError(
        new StarciteError(
          `Invalid session.created payload: ${parsed.error.issues[0]?.message ?? "parse failed"}`
        )
      );
      return;
    }

    this.emitter.emit("session.created", parsed.data);
  }

  private detachChannel(): void {
    if (this.channel) {
      this.channel.off("lifecycle", this.lifecycleBindingRef);
      this.channel.off("token_expired", this.tokenExpiredBindingRef);
      this.channel = undefined;
    }

    this.lifecycleBindingRef = 0;
    this.tokenExpiredBindingRef = 0;
    this.closeChannel?.();
    this.closeChannel = undefined;
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
