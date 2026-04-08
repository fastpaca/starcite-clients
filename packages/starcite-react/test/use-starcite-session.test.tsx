import type {
  AppendResult,
  SessionAppendInput,
  SessionAuthState,
  SessionEventContext,
  SessionEventListener,
  SessionOnEventOptions,
  TailEvent,
} from "@starcite/sdk";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStarciteSession } from "../src/use-starcite-session";

class FakeSession {
  readonly id: string;
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly authListeners = new Set<(state: SessionAuthState) => void>();
  private readonly eventLog: TailEvent[] = [];
  private nextSeq = 1;
  private state: SessionAuthState = { status: "ready" };

  constructor(id: string) {
    this.id = id;
  }

  append(_input: SessionAppendInput): Promise<AppendResult> {
    return Promise.resolve({ deduped: false, seq: this.nextSeq });
  }

  events(): readonly TailEvent[] {
    return [...this.eventLog];
  }

  authState(): SessionAuthState {
    return this.state;
  }

  on(
    eventName: "event",
    listener: SessionEventListener,
    _options?: SessionOnEventOptions<TailEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "auth",
    listener: (state: SessionAuthState) => void
  ): () => void;
  on(
    eventName: "event" | "error" | "auth",
    listener:
      | SessionEventListener
      | ((error: Error) => void)
      | ((state: SessionAuthState) => void)
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      this.eventListeners.add(eventListener);
      return () => {
        this.eventListeners.delete(eventListener);
      };
    }

    if (eventName === "auth") {
      const authListener = listener as (state: SessionAuthState) => void;
      this.authListeners.add(authListener);
      return () => {
        this.authListeners.delete(authListener);
      };
    }

    const errorListener = listener as (error: Error) => void;
    this.errorListeners.add(errorListener);
    return () => {
      this.errorListeners.delete(errorListener);
    };
  }

  emitEvent(text: string): void {
    const event = {
      seq: this.nextSeq,
      type: "content",
      payload: { text },
      actor: "agent:test",
      producer_id: "producer:test",
      producer_seq: this.nextSeq,
    } as TailEvent;

    this.nextSeq += 1;
    this.eventLog.push(event);

    for (const listener of this.eventListeners) {
      listener(event, { phase: "live" } as SessionEventContext);
    }
  }

  emitAuthState(state: SessionAuthState): void {
    this.state = state;
    for (const listener of this.authListeners) {
      listener(state);
    }
  }
}

describe("useStarciteSession", () => {
  it("surfaces session auth refresh state without dropping retained events", async () => {
    const session = new FakeSession("ses_auth_state");
    const { result } = renderHook(() => useStarciteSession({ session }));

    expect(result.current.authState).toEqual({ status: "ready" });

    act(() => {
      session.emitEvent("first");
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    act(() => {
      session.emitAuthState({
        status: "refreshing",
        reason: "token_expired",
      });
    });

    await waitFor(() => {
      expect(result.current.authState).toEqual({
        reason: "token_expired",
        status: "refreshing",
      });
    });
    expect(result.current.events).toHaveLength(1);

    act(() => {
      session.emitAuthState({
        status: "failed",
        reason: "token_expired",
        error: {
          name: "Error",
          message: "reauth denied",
          occurredAtMs: Date.now(),
        },
      });
    });

    await waitFor(() => {
      expect(result.current.authState.status).toBe("failed");
    });
    expect(result.current.events).toHaveLength(1);
  });

  it("resets auth state and retained events when the session key changes", async () => {
    const firstSession = new FakeSession("ses_first");
    const secondSession = new FakeSession("ses_second");
    const { result, rerender } = renderHook(
      ({ session, id }: { session: FakeSession; id: string }) =>
        useStarciteSession({ session, id }),
      {
        initialProps: {
          session: firstSession,
          id: firstSession.id,
        },
      }
    );

    act(() => {
      firstSession.emitEvent("first");
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    act(() => {
      firstSession.emitAuthState({
        status: "failed",
        reason: "token_expired",
        error: {
          name: "Error",
          message: "reauth denied",
          occurredAtMs: Date.now(),
        },
      });
    });

    await waitFor(() => {
      expect(result.current.authState.status).toBe("failed");
    });

    rerender({
      session: secondSession,
      id: secondSession.id,
    });

    await waitFor(() => {
      expect(result.current.authState).toEqual({ status: "ready" });
    });
    expect(result.current.events).toEqual([]);
  });
});
