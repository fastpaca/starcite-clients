import { Socket } from "phoenix";

export class SocketManager {
  private leaseCount = 0;
  private readonly socketUrl: string;
  private readonly token: string | undefined;
  private socket: Socket | undefined;

  constructor(input: { socketUrl: string; token: string | undefined }) {
    this.socketUrl = input.socketUrl;
    this.token = input.token;
  }

  acquire(): { release: () => void; socket: Socket } {
    this.leaseCount += 1;

    const socket = this.ensureSocket();
    if (!socket.isConnected()) {
      socket.connect();
    }

    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        this.release();
      },
      socket,
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

  private release(): void {
    this.leaseCount = Math.max(0, this.leaseCount - 1);
    if (this.leaseCount > 0) {
      return;
    }

    this.socket?.disconnect();
    this.socket = undefined;
  }
}
