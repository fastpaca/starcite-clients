from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, TypeAlias, cast

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
TailCursor: TypeAlias = int
SessionAppendQueueStatus: TypeAlias = Literal["idle", "flushing", "retrying", "paused"]
VALID_TAIL_GAP_REASONS = {"cursor_expired", "resume_invalidated"}
VALID_APPEND_QUEUE_STATUSES = {"idle", "flushing", "retrying", "paused"}


def _require_mapping(value: object, context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError(f"{context} must be an object")
    return cast(dict[str, object], value)


def _require_string(mapping: dict[str, object], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or value == "":
        raise TypeError(f"{key} must be a non-empty string")
    return value


def _optional_string(mapping: dict[str, object], key: str) -> str | None:
    value = mapping.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or value == "":
        raise TypeError(f"{key} must be a non-empty string when provided")
    return value


def _require_int(mapping: dict[str, object], key: str, *, minimum: int = 0) -> int:
    value = mapping.get(key)
    if type(value) is not int or value < minimum:
        raise TypeError(f"{key} must be an integer >= {minimum}")
    return value


def _optional_int(mapping: dict[str, object], key: str, *, minimum: int = 0) -> int | None:
    value = mapping.get(key)
    if value is None:
        return None
    if type(value) is not int or value < minimum:
        raise TypeError(f"{key} must be an integer >= {minimum} when provided")
    return value


def _require_list(mapping: dict[str, object], key: str) -> list[object]:
    value = mapping.get(key)
    if not isinstance(value, list):
        raise TypeError(f"{key} must be a list")
    return value


def _object_field(mapping: dict[str, object], key: str) -> JsonObject:
    value = mapping.get(key)
    if not isinstance(value, dict):
        raise TypeError(f"{key} must be an object")
    return cast(JsonObject, value)


def _optional_object_field(mapping: dict[str, object], key: str) -> JsonObject | None:
    value = mapping.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError(f"{key} must be an object when provided")
    return cast(JsonObject, value)


@dataclass(frozen=True)
class IssueSessionTokenInput:
    session_id: str
    principal: dict[str, str]
    scopes: list[str]
    ttl_seconds: int | None = None

    def to_wire(self) -> JsonObject:
        wire: JsonObject = {
            "session_id": self.session_id,
            "principal": cast(JsonValue, self.principal),
            "scopes": cast(JsonValue, self.scopes),
        }
        if self.ttl_seconds is not None:
            wire["ttl_seconds"] = self.ttl_seconds
        return wire


@dataclass(frozen=True)
class IssueSessionTokenResponse:
    token: str
    expires_in: int


def parse_issue_session_token_response(value: object) -> IssueSessionTokenResponse:
    mapping = _require_mapping(value, "IssueSessionTokenResponse")
    return IssueSessionTokenResponse(
        token=_require_string(mapping, "token"),
        expires_in=_require_int(mapping, "expires_in", minimum=1),
    )


@dataclass(frozen=True)
class SessionRecord:
    id: str
    title: str | None
    metadata: JsonObject
    last_seq: int
    created_at: str
    updated_at: str


def parse_session_record(value: object) -> SessionRecord:
    mapping = _require_mapping(value, "SessionRecord")
    return SessionRecord(
        id=_require_string(mapping, "id"),
        title=_optional_string(mapping, "title"),
        metadata=_object_field(mapping, "metadata"),
        last_seq=_require_int(mapping, "last_seq", minimum=0),
        created_at=_require_string(mapping, "created_at"),
        updated_at=_require_string(mapping, "updated_at"),
    )


@dataclass(frozen=True)
class SessionListItem:
    id: str
    title: str | None
    metadata: JsonObject
    created_at: str


def parse_session_list_item(value: object) -> SessionListItem:
    mapping = _require_mapping(value, "SessionListItem")
    return SessionListItem(
        id=_require_string(mapping, "id"),
        title=_optional_string(mapping, "title"),
        metadata=_object_field(mapping, "metadata"),
        created_at=_require_string(mapping, "created_at"),
    )


@dataclass(frozen=True)
class SessionListPage:
    sessions: list[SessionListItem]
    next_cursor: str | None


def parse_session_list_page(value: object) -> SessionListPage:
    mapping = _require_mapping(value, "SessionListPage")
    return SessionListPage(
        sessions=[parse_session_list_item(item) for item in _require_list(mapping, "sessions")],
        next_cursor=_optional_string(mapping, "next_cursor"),
    )


@dataclass(frozen=True)
class AppendEventRequest:
    type: str
    payload: JsonObject
    producer_id: str
    producer_seq: int
    actor: str | None = None
    source: str | None = None
    metadata: JsonObject | None = None
    refs: JsonObject | None = None
    idempotency_key: str | None = None
    expected_seq: int | None = None

    def to_wire(self) -> JsonObject:
        wire: JsonObject = {
            "type": self.type,
            "payload": self.payload,
            "producer_id": self.producer_id,
            "producer_seq": self.producer_seq,
        }
        if self.actor is not None:
            wire["actor"] = self.actor
        if self.source is not None:
            wire["source"] = self.source
        if self.metadata is not None:
            wire["metadata"] = self.metadata
        if self.refs is not None:
            wire["refs"] = self.refs
        if self.idempotency_key is not None:
            wire["idempotency_key"] = self.idempotency_key
        if self.expected_seq is not None:
            wire["expected_seq"] = self.expected_seq
        return wire


@dataclass(frozen=True)
class AppendEventResponse:
    seq: int
    last_seq: int
    deduped: bool


def parse_append_event_response(value: object) -> AppendEventResponse:
    mapping = _require_mapping(value, "AppendEventResponse")
    deduped = mapping.get("deduped")
    if not isinstance(deduped, bool):
        raise TypeError("deduped must be a boolean")
    return AppendEventResponse(
        seq=_require_int(mapping, "seq", minimum=0),
        last_seq=_require_int(mapping, "last_seq", minimum=0),
        deduped=deduped,
    )


@dataclass(frozen=True)
class AppendResult:
    seq: int
    deduped: bool


@dataclass(frozen=True)
class TailEvent:
    seq: int
    type: str
    payload: JsonObject
    actor: str
    producer_id: str
    producer_seq: int
    cursor: TailCursor | None = None
    source: str | None = None
    metadata: JsonObject | None = None
    refs: JsonObject | None = None
    idempotency_key: str | None = None
    inserted_at: str | None = None


def parse_tail_event(value: object) -> TailEvent:
    mapping = _require_mapping(value, "TailEvent")
    return TailEvent(
        seq=_require_int(mapping, "seq", minimum=0),
        cursor=_optional_int(mapping, "cursor", minimum=0),
        type=_require_string(mapping, "type"),
        payload=_object_field(mapping, "payload"),
        actor=_require_string(mapping, "actor"),
        producer_id=_require_string(mapping, "producer_id"),
        producer_seq=_require_int(mapping, "producer_seq", minimum=1),
        source=_optional_string(mapping, "source"),
        metadata=_optional_object_field(mapping, "metadata"),
        refs=_optional_object_field(mapping, "refs"),
        idempotency_key=_optional_string(mapping, "idempotency_key"),
        inserted_at=_optional_string(mapping, "inserted_at"),
    )


@dataclass(frozen=True)
class TailGap:
    type: Literal["gap"]
    reason: Literal["cursor_expired", "resume_invalidated"]
    from_cursor: TailCursor
    next_cursor: TailCursor
    committed_cursor: TailCursor
    earliest_available_cursor: TailCursor


def parse_tail_gap(value: object) -> TailGap:
    mapping = _require_mapping(value, "TailGap")
    if mapping.get("type") != "gap":
        raise TypeError("type must equal 'gap'")
    reason = mapping.get("reason")
    if reason not in VALID_TAIL_GAP_REASONS:
        raise TypeError("reason must be 'cursor_expired' or 'resume_invalidated'")
    return TailGap(
        type="gap",
        reason=reason,
        from_cursor=_require_int(mapping, "from_cursor", minimum=0),
        next_cursor=_require_int(mapping, "next_cursor", minimum=0),
        committed_cursor=_require_int(mapping, "committed_cursor", minimum=0),
        earliest_available_cursor=_require_int(
            mapping,
            "earliest_available_cursor",
            minimum=0,
        ),
    )


@dataclass(frozen=True)
class SessionAppendInput:
    text: str | None = None
    payload: JsonObject | None = None
    type: str | None = None
    actor: str | None = None
    source: str | None = None
    metadata: JsonObject | None = None
    refs: JsonObject | None = None
    idempotency_key: str | None = None
    expected_seq: int | None = None


@dataclass(frozen=True)
class SessionAppendQueueState:
    status: SessionAppendQueueStatus
    producer_id: str
    last_acknowledged_producer_seq: int
    pending: list[AppendEventRequest] = field(default_factory=list)


@dataclass(frozen=True)
class SessionSnapshot:
    events: list[TailEvent]
    last_seq: int
    cursor: TailCursor | None
    syncing: bool
    append: SessionAppendQueueState | None = None


@dataclass(frozen=True)
class SessionStoreState:
    last_seq: int
    events: list[TailEvent]
    cursor: TailCursor | None = None
    append: SessionAppendQueueState | None = None
    metadata: JsonObject | None = None


def parse_session_store_state(value: object) -> SessionStoreState:
    mapping = _require_mapping(value, "SessionStoreState")
    append = mapping.get("append")
    append_state: SessionAppendQueueState | None = None
    if append is not None:
        append_mapping = _require_mapping(append, "SessionAppendQueueState")
        status = append_mapping.get("status")
        if status not in VALID_APPEND_QUEUE_STATUSES:
            raise TypeError("append.status must be a valid queue status")
        append_state = SessionAppendQueueState(
            status=status,
            producer_id=_require_string(append_mapping, "producer_id"),
            last_acknowledged_producer_seq=_require_int(
                append_mapping,
                "last_acknowledged_producer_seq",
                minimum=0,
            ),
            pending=[
                parse_append_event_request(item)
                for item in _require_list(append_mapping, "pending")
            ],
        )
    return SessionStoreState(
        last_seq=_require_int(mapping, "last_seq", minimum=0),
        cursor=_optional_int(mapping, "cursor", minimum=0),
        events=[parse_tail_event(item) for item in _require_list(mapping, "events")],
        append=append_state,
        metadata=_optional_object_field(mapping, "metadata"),
    )


def parse_append_event_request(value: object) -> AppendEventRequest:
    mapping = _require_mapping(value, "AppendEventRequest")
    return AppendEventRequest(
        type=_require_string(mapping, "type"),
        payload=_object_field(mapping, "payload"),
        actor=_optional_string(mapping, "actor"),
        producer_id=_require_string(mapping, "producer_id"),
        producer_seq=_require_int(mapping, "producer_seq", minimum=1),
        source=_optional_string(mapping, "source"),
        metadata=_optional_object_field(mapping, "metadata"),
        refs=_optional_object_field(mapping, "refs"),
        idempotency_key=_optional_string(mapping, "idempotency_key"),
        expected_seq=_optional_int(mapping, "expected_seq", minimum=0),
    )


@dataclass(frozen=True)
class RequestOptions:
    timeout_seconds: float | None = None
