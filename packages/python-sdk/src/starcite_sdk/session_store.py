from __future__ import annotations

from typing import Protocol

from .types import SessionStoreState


class SessionStore(Protocol):
    def load(self, session_id: str) -> SessionStoreState | None: ...

    def save(self, session_id: str, state: SessionStoreState) -> None: ...

    def clear(self, session_id: str) -> None: ...


class MemoryStore:
    """Simple in-memory session store."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionStoreState] = {}

    def load(self, session_id: str) -> SessionStoreState | None:
        return self._sessions.get(session_id)

    def save(self, session_id: str, state: SessionStoreState) -> None:
        self._sessions[session_id] = state

    def clear(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
