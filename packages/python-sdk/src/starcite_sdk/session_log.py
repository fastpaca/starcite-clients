from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .errors import StarciteError
from .types import SessionSnapshot, SessionStoreState, TailCursor, TailEvent


@dataclass(frozen=True)
class SessionLogSubscriptionContext:
    replayed: bool


SessionLogListener = Callable[[TailEvent, SessionLogSubscriptionContext], None]


class SessionLog:
    """Canonical in-memory log for one session."""

    def __init__(self) -> None:
        self._event_by_seq: dict[int, TailEvent] = {}
        self._applied_seq = 0
        self._applied_cursor: TailCursor | None = None
        self._listeners: list[SessionLogListener] = []

    def _ordered_events(self) -> list[TailEvent]:
        return [self._event_by_seq[key] for key in sorted(self._event_by_seq)]

    def apply_batch(self, batch: list[TailEvent]) -> list[TailEvent]:
        applied: list[TailEvent] = []
        for event in batch:
            self.apply(event)
            applied.append(event)
            for listener in list(self._listeners):
                listener(event, SessionLogSubscriptionContext(replayed=False))
        return applied

    def apply(self, event: TailEvent) -> None:
        previous_last_seq = self._applied_seq
        self._event_by_seq[event.seq] = event
        self._applied_seq = max(self._applied_seq, event.seq)
        if event.cursor is not None and (
            self._applied_cursor is None or event.seq >= previous_last_seq
        ):
            self._applied_cursor = event.cursor

    def hydrate(self, state: SessionStoreState) -> None:
        if state.last_seq < 0:
            raise StarciteError("Session store last_seq must be a non-negative integer")
        next_events: dict[int, TailEvent] = {}
        latest_event: TailEvent | None = None
        for event in state.events:
            if event.seq > state.last_seq:
                raise StarciteError(
                    f"Session store contains event seq {event.seq} above last_seq {state.last_seq}"
                )
            if latest_event is None or event.seq > latest_event.seq:
                latest_event = event
            next_events[event.seq] = event
        self._event_by_seq = next_events
        self._applied_seq = state.last_seq
        self._applied_cursor = state.cursor if state.cursor is not None else (
            latest_event.cursor if latest_event is not None else None
        )

    def subscribe(self, listener: SessionLogListener, *, replay: bool = True) -> Callable[[], None]:
        if replay:
            for event in self._ordered_events():
                listener(event, SessionLogSubscriptionContext(replayed=True))
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def state(self, syncing: bool) -> SessionSnapshot:
        return SessionSnapshot(
            events=self._ordered_events(),
            last_seq=self._applied_seq,
            cursor=self._applied_cursor,
            syncing=syncing,
        )

    @property
    def events(self) -> list[TailEvent]:
        return self._ordered_events()

    @property
    def cursor(self) -> TailCursor | None:
        return self._applied_cursor

    @property
    def last_seq(self) -> int:
        return self._applied_seq

    def advance_cursor(self, cursor: TailCursor) -> None:
        self._applied_cursor = cursor
