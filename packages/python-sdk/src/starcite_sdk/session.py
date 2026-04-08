from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Iterator, Mapping
from contextlib import suppress

from phoenix_channels_python_client.exceptions import PHXClientError
from phoenix_channels_python_client.phx_messages import ChannelMessage

from .errors import StarciteTailError, StarciteTokenExpiredError
from .identity import StarciteIdentity
from .phoenix import StarcitePhoenixClient
from .session_log import SessionLog
from .session_store import SessionStore
from .transport import TransportConfig, request_json
from .types import (
    AppendEventRequest,
    AppendResult,
    JsonObject,
    RequestOptions,
    SessionAppendInput,
    SessionAppendQueueState,
    SessionRecord,
    SessionSnapshot,
    SessionStoreState,
    TailEvent,
    parse_append_event_response,
    parse_tail_event,
    parse_tail_gap,
)


class StarciteSession:
    """Session-scoped client bound to one session token."""

    def __init__(
        self,
        *,
        session_id: str,
        token: str,
        identity: StarciteIdentity,
        transport: TransportConfig,
        store: SessionStore | None = None,
        record: SessionRecord | None = None,
    ) -> None:
        self.id = session_id
        self.token = token
        self.identity = identity
        self.record = record
        self.log = SessionLog()
        self._transport = transport
        self._store = store
        self._producer_id = str(uuid.uuid4())
        self._next_producer_seq = 1
        self._last_acknowledged_producer_seq = 0
        self._active_streams = 0

        stored_state = self._store.load(self.id) if self._store is not None else None
        if stored_state is not None:
            self.log.hydrate(stored_state)
            if stored_state.append is not None:
                self._producer_id = stored_state.append.producer_id
                self._last_acknowledged_producer_seq = (
                    stored_state.append.last_acknowledged_producer_seq
                )
                self._next_producer_seq = (
                    stored_state.append.next_producer_seq
                    or self._last_acknowledged_producer_seq + 1
                )

    async def append(
        self,
        input: SessionAppendInput | None = None,
        *,
        text: str | None = None,
        payload: Mapping[str, object] | None = None,
        type: str | None = None,
        actor: str | None = None,
        source: str | None = None,
        metadata: Mapping[str, object] | None = None,
        refs: Mapping[str, object] | None = None,
        idempotency_key: str | None = None,
        expected_seq: int | None = None,
        request_options: RequestOptions | None = None,
    ) -> AppendResult:
        append_input = self._resolve_append_input(
            input=input,
            text=text,
            payload=payload,
            type=type,
            actor=actor,
            source=source,
            metadata=metadata,
            refs=refs,
            idempotency_key=idempotency_key,
            expected_seq=expected_seq,
        )
        item_id = append_input.idempotency_key or str(uuid.uuid4())
        request = AppendEventRequest(
            type=append_input.type or "content",
            payload=self._resolve_append_payload(append_input),
            actor=append_input.actor,
            producer_id=self._producer_id,
            producer_seq=self._reserve_producer_seq(),
            source=append_input.source or "agent",
            metadata=dict(append_input.metadata) if append_input.metadata is not None else None,
            refs=dict(append_input.refs) if append_input.refs is not None else None,
            idempotency_key=item_id,
            expected_seq=append_input.expected_seq,
        )
        response = await request_json(
            self._transport,
            path=f"/sessions/{self.id}/append",
            method="POST",
            parser=parse_append_event_response,
            body=request.to_wire(),
            request_options=request_options,
        )
        self._last_acknowledged_producer_seq = max(
            self._last_acknowledged_producer_seq,
            request.producer_seq,
        )
        self._persist_state()
        return AppendResult(seq=response.seq, deduped=response.deduped)

    async def append_text(
        self,
        text: str,
        *,
        actor: str | None = None,
        source: str | None = None,
        metadata: Mapping[str, object] | None = None,
        refs: Mapping[str, object] | None = None,
        idempotency_key: str | None = None,
        expected_seq: int | None = None,
        request_options: RequestOptions | None = None,
    ) -> AppendResult:
        return await self.append(
            text=text,
            actor=actor,
            source=source,
            metadata=metadata,
            refs=refs,
            idempotency_key=idempotency_key,
            expected_seq=expected_seq,
            request_options=request_options,
        )

    async def append_event(
        self,
        *,
        type: str,
        payload: Mapping[str, object],
        actor: str | None = None,
        source: str | None = None,
        metadata: Mapping[str, object] | None = None,
        refs: Mapping[str, object] | None = None,
        idempotency_key: str | None = None,
        expected_seq: int | None = None,
        request_options: RequestOptions | None = None,
    ) -> AppendResult:
        return await self.append(
            type=type,
            payload=payload,
            actor=actor,
            source=source,
            metadata=metadata,
            refs=refs,
            idempotency_key=idempotency_key,
            expected_seq=expected_seq,
            request_options=request_options,
        )

    async def stream_events(
        self,
        *,
        replay: bool = True,
        agent: str | None = None,
    ) -> AsyncIterator[TailEvent]:
        if replay:
            for event in self.log.events:
                if self._matches_agent(event, agent):
                    yield event

        topic = f"tail:{self.id}"
        self._active_streams += 1
        try:
            while True:
                queue: asyncio.Queue[ChannelMessage] = asyncio.Queue()

                async def on_message(message: ChannelMessage) -> None:
                    await queue.put(message)

                phoenix = StarcitePhoenixClient(
                    websocket_url=self._transport.websocket_url,
                    token=self.token,
                )
                try:
                    async with phoenix:
                        await phoenix.subscribe_to_topic(
                            topic,
                            join_payload={"cursor": self.log.cursor or 0},
                            async_callback=on_message,
                        )
                        run_task = asyncio.create_task(phoenix.run_forever())
                        reconnect_from_gap = False

                        while True:
                            queue_task = asyncio.create_task(queue.get())
                            try:
                                done, _ = await asyncio.wait(
                                    {queue_task, run_task},
                                    return_when=asyncio.FIRST_COMPLETED,
                                )
                                if queue_task not in done:
                                    queue_task.cancel()
                                    with suppress(asyncio.CancelledError):
                                        await queue_task
                                    await run_task
                                    return

                                message = queue_task.result()
                            finally:
                                if not queue_task.done():
                                    queue_task.cancel()
                                    with suppress(asyncio.CancelledError):
                                        await queue_task

                            event_name = str(message.event)

                            if event_name == "events":
                                events_raw = message.payload.get("events")
                                if not isinstance(events_raw, list):
                                    continue
                                live_events = [parse_tail_event(item) for item in events_raw]
                                applied_events = self.log.apply_batch(live_events)
                                if self.log.cursor is not None:
                                    phoenix.set_topic_join_payload(
                                        topic,
                                        {"cursor": self.log.cursor},
                                    )
                                self._persist_state()
                                for event in applied_events:
                                    if self._matches_agent(event, agent):
                                        yield event
                                continue

                            if event_name == "gap":
                                gap = parse_tail_gap(message.payload)
                                self.log.advance_cursor(gap.next_cursor)
                                phoenix.set_topic_join_payload(
                                    topic,
                                    {"cursor": gap.next_cursor},
                                )
                                self._persist_state()
                                reconnect_from_gap = True
                                break

                            if event_name == "token_expired":
                                raise StarciteTokenExpiredError(
                                    f"Tail token expired for session '{self.id}'. Re-issue a session token and reconnect from the last processed cursor.",
                                    session_id=self.id,
                                    close_reason=str(message.payload.get("reason", "")),
                                )

                    if reconnect_from_gap:
                        continue
                    return
                except StarciteTokenExpiredError:
                    raise
                except (TypeError, ValueError) as exc:
                    raise StarciteTailError(
                        f"Tail stream returned invalid payload for session '{self.id}': {exc}",
                        session_id=self.id,
                        stage="decode",
                    ) from exc
                except PHXClientError as exc:
                    raise StarciteTailError(
                        f"Tail stream failed for session '{self.id}': {exc}",
                        session_id=self.id,
                        stage="stream",
                    ) from exc
        finally:
            self._active_streams -= 1

    def append_state(self) -> SessionAppendQueueState:
        return SessionAppendQueueState(
            status="idle",
            producer_id=self._producer_id,
            last_acknowledged_producer_seq=self._last_acknowledged_producer_seq,
            pending=[],
            next_producer_seq=self._next_producer_seq,
        )

    def state(self) -> SessionSnapshot:
        snapshot = self.log.state(syncing=self._active_streams > 0)
        return SessionSnapshot(
            events=snapshot.events,
            last_seq=snapshot.last_seq,
            cursor=snapshot.cursor,
            syncing=snapshot.syncing,
            append=self.append_state(),
        )

    @property
    def events(self) -> tuple[TailEvent, ...]:
        return tuple(self.log.events)

    def iter_events(self) -> Iterator[TailEvent]:
        return iter(self.events)

    async def close(self) -> None:
        return None

    def _persist_state(self) -> None:
        if self._store is None:
            return
        self._store.save(
            self.id,
            SessionStoreState(
                last_seq=self.log.last_seq,
                cursor=self.log.cursor,
                events=self.log.events,
                append=self.append_state(),
            ),
        )

    def _matches_agent(self, event: TailEvent, agent: str | None) -> bool:
        if agent is None:
            return True
        return event.actor == f"agent:{agent}"

    def _reserve_producer_seq(self) -> int:
        producer_seq = self._next_producer_seq
        self._next_producer_seq = producer_seq + 1
        self._persist_state()
        return producer_seq

    def _resolve_append_payload(self, append_input: SessionAppendInput) -> JsonObject:
        if append_input.payload is not None:
            return dict(append_input.payload)
        if append_input.text is not None:
            return {"text": append_input.text}
        raise TypeError("append() requires text or payload")

    def _resolve_append_input(
        self,
        *,
        input: SessionAppendInput | None,
        text: str | None,
        payload: Mapping[str, object] | None,
        type: str | None,
        actor: str | None,
        source: str | None,
        metadata: Mapping[str, object] | None,
        refs: Mapping[str, object] | None,
        idempotency_key: str | None,
        expected_seq: int | None,
    ) -> SessionAppendInput:
        keyword_input = any(
            value is not None
            for value in (
                text,
                payload,
                type,
                actor,
                source,
                metadata,
                refs,
                idempotency_key,
                expected_seq,
            )
        )
        if input is not None and keyword_input:
            raise TypeError("append() accepts either SessionAppendInput or keyword fields, not both")
        if input is not None:
            return input
        return SessionAppendInput(
            text=text,
            payload=dict(payload) if payload is not None else None,
            type=type,
            actor=actor,
            source=source,
            metadata=dict(metadata) if metadata is not None else None,
            refs=dict(refs) if refs is not None else None,
            idempotency_key=idempotency_key,
            expected_seq=expected_seq,
        )
