import type { Channel } from "phoenix";
import { Socket } from "phoenix";

type ChannelParams = Record<string, unknown> | (() => Record<string, unknown>);

export interface ManagedChannel<TChannel extends Channel = Channel> {
  channel: TChannel;
  close: () => void;
}

export class SocketManager {
  private activeChannelCount = 0;
  private readonly socketUrl: string;
  private readonly token: string | undefined;
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
    this.activeChannelCount = Math.max(0, this.activeChannelCount - 1);
    if (this.activeChannelCount > 0) {
      return;
    }

    this.socket?.disconnect();
    this.socket = undefined;
  }
}
