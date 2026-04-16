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
  onError?: (error: Error) => void;
}

export interface UseStarciteSessionResult {
  events: readonly TailEvent[];
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

const NOOP_APPEND = (): Promise<AppendResult> =>
  Promise.resolve({ seq: -1, deduped: false });
const EMPTY_EVENTS: readonly TailEvent[] = [];

export function useStarciteSession(
  options: UseStarciteSessionOptions
): UseStarciteSessionResult {
  const { session, id, onError } = options;
  const resetKey = id ?? session?.id ?? "__none__";

  const [events, setEvents] = useState<readonly TailEvent[]>([]);
  const resetKeyRef = useRef(resetKey);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    resetKeyRef.current = resetKey;
    setEvents([]);

    if (!session) {
      return;
    }

    const syncEvents = (): void => {
      if (resetKeyRef.current !== resetKey) {
        return;
      }
      setEvents(session.state().events);
    };

    syncEvents();
    const offEvent = session.on(
      "event",
      () => {
        syncEvents();
      },
      { replay: false }
    );
    const offError = session.on("error", (error: Error) => {
      onErrorRef.current?.(error);
    });

    return () => {
      offEvent();
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
