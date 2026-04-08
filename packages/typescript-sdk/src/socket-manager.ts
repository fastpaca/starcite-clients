import type { Channel } from "phoenix";
import { Socket } from "phoenix";

type ChannelParams = Record<string, unknown> | (() => Record<string, unknown>);

export interface ManagedChannel<TChannel extends Channel = Channel> {
  channel: TChannel;
  close: () => void;
}

export interface RejoinableChannel extends Channel {
  rejoin: (timeout?: number) => void;
}

export function readJoinFailureReason(payload: unknown): string {
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

  return "join failed";
}

/**
 * Manages multiple channels connected to a single socket. The socket
 * itself is held open until each channel is _manually_ closed (need to be
 * careful here). The socket is lazy opened on first use.
 */
export class SocketManager {
  private activeChannelCount = 0;
  private readonly socketUrl: string;
  private token: string | undefined;
  private socket: Socket | undefined;

  constructor(input: { socketUrl: string; token: string | undefined }) {
    this.socketUrl = input.socketUrl;
    this.token = input.token;
  }

  openChannel<TChannel extends Channel = Channel>(input: {
    params?: ChannelParams;
    topic: string;
  }): ManagedChannel<TChannel> {
    const socket = this.ensureSocket();
    if (!socket.isConnected()) {
      socket.connect();
    }

    const channel = socket.channel(input.topic, input.params) as TChannel;
    this.activeChannelCount += 1;

    let closed = false;

    return {
      channel,
      close: () => {
        if (closed) {
          return;
        }

        closed = true;
        channel.leave();
        this.releaseChannel();
      },
    };
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private ensureSocket(): Socket {
    if (this.socket) {
      return this.socket;
    }

    this.socket = new Socket(this.socketUrl, {
      params: () => (this.token ? { token: this.token } : {}),
    });

    return this.socket;
  }

  private releaseChannel(): void {
    this.activeChannelCount -= 1;
    if (this.activeChannelCount > 0) {
      return;
    }

    this.socket?.disconnect();
    this.socket = undefined;
  }
}
