import type {
  AppendResult,
  SessionAppendInput,
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
  private readonly eventLog: TailEvent[] = [];
  private nextSeq = 1;

  constructor(id: string) {
    this.id = id;
  }

  append(_input: SessionAppendInput): Promise<AppendResult> {
    return Promise.resolve({ deduped: false, seq: this.nextSeq });
  }

  events(): readonly TailEvent[] {
    return [...this.eventLog];
  }

  on(
    eventName: "event",
    listener: SessionEventListener,
    _options?: SessionOnEventOptions<TailEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "error",
    listener: SessionEventListener | ((error: Error) => void)
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      this.eventListeners.add(eventListener);
      return () => {
        this.eventListeners.delete(eventListener);
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

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

describe("useStarciteSession", () => {
  it("surfaces retained events and forwards session errors", async () => {
    const session = new FakeSession("ses_session_hook");
    const errors: string[] = [];
    const { result } = renderHook(() =>
      useStarciteSession({
        session,
        onError: (error) => {
          errors.push(error.message);
        },
      })
    );

    act(() => {
      session.emitEvent("first");
      session.emitError(new Error("refresh failed"));
    });

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });
    expect(errors).toEqual(["refresh failed"]);
  });

  it("resets retained events when the session key changes", async () => {
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

    rerender({
      session: secondSession,
      id: secondSession.id,
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([]);
    });
  });
});
