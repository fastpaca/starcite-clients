import type {
  AppendResult,
  SessionAppendInput,
  SessionEvent,
  SessionEventListener,
  SessionOnEventOptions,
} from "@starcite/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Minimal session surface consumed by the hook.
 * Any object satisfying this interface works — including a real `StarciteSession`.
 */
export interface StarciteSessionLike {
  readonly id: string;
  append(input: SessionAppendInput): Promise<AppendResult>;
  events(): readonly SessionEvent[];
  on(
    eventName: "event",
    listener: SessionEventListener,
    options?: SessionOnEventOptions<SessionEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
}

export interface UseStarciteSessionOptions {
  /** Pass `null` / `undefined` before the session is available — the hook is inert until connected. */
  session: StarciteSessionLike | null | undefined;
  /** Reset key — changing this resets state. Defaults to `session.id`. */
  id?: string;
  onError?: (error: Error) => void;
}

export interface UseStarciteSessionResult {
  events: readonly SessionEvent[];
  append: (input: SessionAppendInput) => Promise<AppendResult>;
}

const NOOP_APPEND = (): Promise<AppendResult> =>
  Promise.resolve({ seq: -1, deduped: false });
const EMPTY_EVENTS: readonly SessionEvent[] = [];

export function useStarciteSession(
  options: UseStarciteSessionOptions
): UseStarciteSessionResult {
  const { session, id, onError } = options;
  const resetKey = id ?? session?.id ?? "__none__";

  const [events, setEvents] = useState<readonly SessionEvent[]>([]);

  const refreshVersionRef = useRef(0);
  const sessionKeyRef = useRef(resetKey);
  const onErrorRef = useRef(onError);
  const liveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refresh = useCallback(() => {
    if (!session || sessionKeyRef.current !== resetKey) {
      return;
    }
    const version = ++refreshVersionRef.current;
    const snapshot = [...session.events()];
    if (
      refreshVersionRef.current !== version ||
      sessionKeyRef.current !== resetKey
    ) {
      return;
    }
    setEvents(snapshot);
  }, [session, resetKey]);

  const scheduleLive = useCallback(() => {
    if (liveTimeoutRef.current !== null) {
      return;
    }
    const key = resetKey;
    liveTimeoutRef.current = setTimeout(() => {
      liveTimeoutRef.current = null;
      if (sessionKeyRef.current === key) {
        refresh();
      }
    }, 16);
  }, [refresh, resetKey]);

  const scheduleReplay = useCallback(() => {
    if (replayTimeoutRef.current !== null) {
      clearTimeout(replayTimeoutRef.current);
    }
    const key = resetKey;
    replayTimeoutRef.current = setTimeout(() => {
      replayTimeoutRef.current = null;
      if (sessionKeyRef.current === key) {
        refresh();
      }
    }, 120);
  }, [refresh, resetKey]);

  const onEvent = useCallback(
    (_event: SessionEvent, context?: { replayed: boolean }) => {
      if (context?.replayed) {
        scheduleReplay();
      } else {
        scheduleLive();
      }
    },
    [scheduleLive, scheduleReplay]
  );

  useEffect(() => {
    sessionKeyRef.current = resetKey;
    refreshVersionRef.current += 1;
    setEvents([]);

    if (!session) {
      return;
    }

    refresh();

    const offEvent = session.on("event", onEvent, { replay: false });
    const offError = session.on("error", (error: Error) => {
      onErrorRef.current?.(
        error instanceof Error ? error : new Error(String(error))
      );
    });

    return () => {
      refreshVersionRef.current += 1;
      if (liveTimeoutRef.current !== null) {
        clearTimeout(liveTimeoutRef.current);
        liveTimeoutRef.current = null;
      }
      if (replayTimeoutRef.current !== null) {
        clearTimeout(replayTimeoutRef.current);
        replayTimeoutRef.current = null;
      }
      offEvent();
      offError();
    };
  }, [onEvent, refresh, session, resetKey]);

  const append = useCallback(
    (input: SessionAppendInput) =>
      session ? session.append(input) : NOOP_APPEND(),
    [session]
  );

  return useMemo(
    () => ({ events: session ? events : EMPTY_EVENTS, append }),
    [session, events, append]
  );
}
