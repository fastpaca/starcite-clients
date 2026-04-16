import type {
  AppendResult,
  SessionAppendInput,
  SessionHandle,
  SessionSnapshot,
  TailEvent,
} from "@starcite/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UseStarciteSessionOptions {
  /** Pass `null` / `undefined` before the session is available — the hook is inert until connected. */
  session: SessionHandle | null | undefined;
  /** Reset key — changing this resets state. Defaults to `session.id`. */
  id?: string;
  onError?: (error: Error) => void;
}

export interface UseStarciteSessionResult {
  events: readonly TailEvent[];
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

const NOOP_APPEND = (): Promise<AppendResult> =>
  Promise.resolve({ seq: -1, deduped: false });
const EMPTY_EVENTS: readonly TailEvent[] = [];

function sameEventSlice(
  left: readonly TailEvent[],
  right: readonly TailEvent[]
): boolean {
  return (
    left.length === right.length &&
    left.every((event, index) => event === right[index])
  );
}

export function useStarciteSession(
  options: UseStarciteSessionOptions
): UseStarciteSessionResult {
  const { session, id, onError } = options;
  const resetKey = id ?? session?.id ?? "__none__";

  const [events, setEvents] = useState<readonly TailEvent[]>([]);
  const onErrorRef = useRef(onError);
  const previousBindingRef = useRef<{
    readonly session: SessionHandle | null | undefined;
    readonly resetKey: string;
  } | null>(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (!session) {
      previousBindingRef.current = { session, resetKey };
      setEvents(EMPTY_EVENTS);
      return;
    }

    const previousBinding = previousBindingRef.current;
    const baselineSeq =
      previousBinding?.session === session &&
      previousBinding.resetKey !== resetKey
        ? session.state().lastSeq
        : 0;
    previousBindingRef.current = { session, resetKey };

    let cancelled = false;
    const syncEvents = (snapshot: SessionSnapshot = session.state()): void => {
      if (cancelled) {
        return;
      }
      const nextEvents =
        baselineSeq === 0
          ? snapshot.events
          : snapshot.events.filter((event) => event.seq > baselineSeq);
      setEvents((previousEvents) => {
        return sameEventSlice(previousEvents, nextEvents)
          ? previousEvents
          : nextEvents;
      });
    };

    setEvents(EMPTY_EVENTS);
    syncEvents();
    const offState = session.on("state", (snapshot) => {
      syncEvents(snapshot);
    });
    const offError = session.on("error", (error: Error) => {
      if (!cancelled) {
        onErrorRef.current?.(error);
      }
    });

    return () => {
      cancelled = true;
      offState();
      offError();
    };
  }, [session, resetKey]);

  const append = useCallback(
    (input: SessionAppendInput) =>
      session ? session.append(input) : NOOP_APPEND(),
    [session]
  );

  return useMemo(
    () => ({
      events: session ? events : EMPTY_EVENTS,
      append,
    }),
    [session, events, append]
  );
}
