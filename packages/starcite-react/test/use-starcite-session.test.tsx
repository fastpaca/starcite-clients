import type {
  AppendResult,
  SessionAppendInput,
  SessionEventContext,
  SessionEventListener,
  SessionOnEventOptions,
  SessionSnapshot,
  SessionStateListener,
  TailEvent,
} from "@starcite/sdk";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStarciteSession } from "../src/use-starcite-session";

class FakeSession {
  readonly id: string;
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly stateListeners = new Set<SessionStateListener>();
  private readonly eventLog: TailEvent[] = [];
  private readonly queuedRangeEvents: TailEvent[] = [];
  private nextSeq = 1;

  constructor(id: string) {
    this.id = id;
  }

  append(_input: SessionAppendInput): Promise<AppendResult> {
    return Promise.resolve({ deduped: false, seq: this.nextSeq });
  }

  range(fromSeq: number, toSeq: number): Promise<readonly TailEvent[]> {
    const nextEvents = this.queuedRangeEvents.filter((event) => {
      return event.seq >= fromSeq && event.seq <= toSeq;
    });
    if (nextEvents.length > 0) {
      for (const event of nextEvents) {
        this.eventLog.push(event);
      }
      this.queuedRangeEvents.length = 0;
      this.emitState();
    }

    return Promise.resolve(
      this.orderedEvents().filter(
        (event) => event.seq >= fromSeq && event.seq <= toSeq
      )
    );
  }

  events(): readonly TailEvent[] {
    return this.orderedEvents();
  }

  state(): SessionSnapshot {
    return {
      append: undefined,
      cursor: this.orderedEvents().at(-1)?.cursor,
      events: this.orderedEvents(),
      lastSeq: this.orderedEvents().at(-1)?.seq ?? 0,
      syncing: false,
    };
  }

  on(
    eventName: "event",
    listener: SessionEventListener,
    _options?: SessionOnEventOptions<TailEvent>
  ): () => void;
  on(eventName: "state", listener: SessionStateListener): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "state" | "error",
    listener:
      | SessionEventListener
      | SessionStateListener
      | ((error: Error) => void)
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      this.eventListeners.add(eventListener);
      return () => {
        this.eventListeners.delete(eventListener);
      };
    }

    if (eventName === "state") {
      const stateListener = listener as SessionStateListener;
      this.stateListeners.add(stateListener);
      return () => {
        this.stateListeners.delete(stateListener);
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
    this.emitState();

    for (const listener of this.eventListeners) {
      listener(event, { phase: "live" } as SessionEventContext);
    }
  }

  queueRangeEvent(text: string, seq = this.nextSeq): void {
    this.queuedRangeEvents.push({
      seq,
      type: "content",
      payload: { text },
      actor: "agent:test",
      producer_id: "producer:test",
      producer_seq: seq,
    } as TailEvent);
    this.nextSeq = Math.max(this.nextSeq, seq + 1);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private emitState(): void {
    const snapshot = this.state();
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
  }

  private orderedEvents(): TailEvent[] {
    const bySeq = new Map<number, TailEvent>();
    for (const event of this.eventLog) {
      bySeq.set(event.seq, event);
    }

    return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  }
}

describe("useStarciteSession", () => {
  it("surfaces live events and forwards session errors", async () => {
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

  it("starts from the current materialized session state", async () => {
    const session = new FakeSession("ses_window_hook");
    act(() => {
      session.emitEvent("first");
      session.emitEvent("second");
    });

    const { result } = renderHook(() =>
      useStarciteSession({
        session,
      })
    );

    await waitFor(() => {
      expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    });
  });

  it("updates when session.range materializes additional events", async () => {
    const session = new FakeSession("ses_backfill_hook");
    const { result } = renderHook(() =>
      useStarciteSession({
        session,
      })
    );

    session.queueRangeEvent("backfilled");

    await act(async () => {
      await session.range(1, 1);
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.payload)).toEqual([
        { text: "backfilled" },
      ]);
    });
  });

  it("subscribes to session errors even when onError is added later", () => {
    const session = new FakeSession("ses_late_error_listener");
    const errors: string[] = [];
    const { rerender } = renderHook(
      ({ onError }: { onError?: (error: Error) => void }) =>
        useStarciteSession({
          session,
          onError,
        }),
      {
        initialProps: {},
      }
    );

    rerender({
      onError: (error: Error) => {
        errors.push(error.message);
      },
    });

    act(() => {
      session.emitError(new Error("late listener attached"));
    });

    expect(errors).toEqual(["late listener attached"]);
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

  it("starts a fresh local view when the same session handle is reused with a different id", async () => {
    const session = new FakeSession("ses_reused");
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useStarciteSession({
          session,
          id,
        }),
      {
        initialProps: {
          id: "view-a",
        },
      }
    );

    act(() => {
      session.emitEvent("before reset");
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.payload)).toEqual([
        { text: "before reset" },
      ]);
    });

    rerender({
      id: "view-b",
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([]);
    });

    act(() => {
      session.emitEvent("after reset");
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.payload)).toEqual([
        { text: "after reset" },
      ]);
    });
  });

  it("keeps pre-reset backfills hidden when the same session handle is rebound to a new id", async () => {
    const session = new FakeSession("ses_reused_backfill");
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useStarciteSession({
          session,
          id,
        }),
      {
        initialProps: {
          id: "view-a",
        },
      }
    );

    act(() => {
      session.emitEvent("visible before reset");
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.seq)).toEqual([1]);
    });

    rerender({
      id: "view-b",
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([]);
    });

    session.queueRangeEvent("historical before reset", 1);

    await act(async () => {
      await session.range(1, 1);
    });

    expect(result.current.events).toEqual([]);
  });
});
