import type {
  AppendResult,
  SessionAppendInput,
  SessionHandle,
  TailEvent,
} from "@starcite/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UseStarciteSessionOptions {
  /** Pass `null` / `undefined` before the session is available — the hook is inert until connected. */
  session: SessionHandle | null | undefined;
  /** Reset key — changing this resets state. Defaults to `session.id`. */
  id?: string;
  /** Optional initial durable history read to issue on connect. */
  read?: "all" | false;
  onError?: (error: Error) => void;
}

export interface UseStarciteSessionResult {
  events: readonly TailEvent[];
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

const NOOP_APPEND = (): Promise<AppendResult> =>
  Promise.resolve({ seq: -1, deduped: false });
const EMPTY_EVENTS: readonly TailEvent[] = [];
const NOOP_UNSUBSCRIBE = (): void => undefined;

function mergeEvents(
  current: readonly TailEvent[],
  incoming: readonly TailEvent[]
): readonly TailEvent[] {
  if (incoming.length === 0) {
    return current;
  }

  const bySeq = new Map<number, TailEvent>();
  for (const event of current) {
    bySeq.set(event.seq, event);
  }
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function toHookError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useStarciteSession(
  options: UseStarciteSessionOptions
): UseStarciteSessionResult {
  const { session, id, read = false, onError } = options;
  const resetKey = id ?? session?.id ?? "__none__";

  const [events, setEvents] = useState<readonly TailEvent[]>([]);

  const sessionKeyRef = useRef(resetKey);
  const onErrorRef = useRef(onError);
  const loadVersionRef = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const onEvent = useCallback((event: TailEvent) => {
    setEvents((current) => mergeEvents(current, [event]));
  }, []);

  useEffect(() => {
    sessionKeyRef.current = resetKey;
    loadVersionRef.current += 1;
    setEvents([]);

    if (!session) {
      return;
    }

    const loadVersion = loadVersionRef.current;
    let offEvent = NOOP_UNSUBSCRIBE;
    let offError = NOOP_UNSUBSCRIBE;
    const isStale = (): boolean => {
      return (
        sessionKeyRef.current !== resetKey ||
        loadVersionRef.current !== loadVersion
      );
    };

    const bindLiveListeners = (): void => {
      offEvent = session.on("event", onEvent, { replay: false });
      offError = session.on("error", (error: Error) => {
        onErrorRef.current?.(toHookError(error));
      });
    };

    setEvents(session.state().events);
    bindLiveListeners();
    if (read === "all") {
      session
        .all()
        .then((slice) => {
          if (isStale()) {
            return;
          }

          setEvents((current) => mergeEvents(current, slice.events));
        })
        .catch((error) => {
          if (isStale()) {
            return;
          }

          onErrorRef.current?.(toHookError(error));
        });
    }

    return () => {
      loadVersionRef.current += 1;
      offEvent();
      offError();
    };
  }, [onEvent, read, session, resetKey]);

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
