from __future__ import annotations

import asyncio
import base64
import contextlib
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, replace
from urllib.parse import parse_qs, urlparse

import pytest
from websockets.asyncio.server import ServerConnection, serve

from starcite_sdk import MemoryStore, SessionStoreState, Starcite, StarciteError, TailEvent
from starcite_sdk.transport import HttpRequest, HttpResponse


def token_from_claims(claims: Mapping[str, object]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(dict(claims)).encode("utf-8"))
    return f"eyJhbGciOiJIUzI1NiJ9.{payload.decode('ascii').rstrip('=')}.sig"


def make_api_key(**overrides: object) -> str:
    claims = {
        "iss": "https://starcite.ai",
        "tenant_id": "test-tenant",
        "principal_id": "system",
        "principal_type": "user",
    }
    claims.update(overrides)
    return token_from_claims(claims)


def make_session_token(
    session_id: str = "ses_tail",
    principal_id: str = "drafter",
    principal_type: str = "agent",
) -> str:
    return token_from_claims(
        {
            "session_id": session_id,
            "tenant_id": "test-tenant",
            "principal_id": principal_id,
            "principal_type": principal_type,
        }
    )


class Recorder:
    def __init__(self, responses: list[HttpResponse]) -> None:
        self._responses = list(responses)
        self.requests: list[HttpRequest] = []

    async def __call__(self, request: HttpRequest) -> HttpResponse:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError("Unexpected extra HTTP request")
        return self._responses.pop(0)


def json_response(status_code: int, payload: Mapping[str, object], *, reason: str = "") -> HttpResponse:
    return HttpResponse(
        status_code=status_code,
        body=json.dumps(dict(payload)).encode("utf-8"),
        headers={"content-type": "application/json"},
        reason=reason,
    )


def body_json(request: HttpRequest) -> dict[str, object]:
    assert request.body is not None
    return json.loads(request.body.decode("utf-8"))


@dataclass
class PhoenixScenario:
    first_join: asyncio.Event
    second_join: asyncio.Event
    received_queries: list[dict[str, list[str]]]


@contextlib.asynccontextmanager
async def run_phoenix_server() -> AsyncIterator[tuple[str, PhoenixScenario]]:
    first_join = asyncio.Event()
    second_join = asyncio.Event()
    received_queries: list[dict[str, list[str]]] = []
    join_count = 0

    async def handler(connection: ServerConnection) -> None:
        nonlocal join_count
        received_queries.append(parse_qs(urlparse(str(connection.request.path)).query))

        async for raw in connection:
            message = json.loads(raw)
            join_ref, ref, topic, event, payload = message
            if event == "phx_join":
                join_count += 1
                if join_count == 1:
                    assert topic == "tail:ses_stream"
                    assert payload == {"cursor": 0}
                    await connection.send(json.dumps([join_ref, ref, topic, "phx_reply", {"status": "ok", "response": {}}]))
                    await connection.send(
                        json.dumps(
                            [
                                join_ref,
                                None,
                                topic,
                                "events",
                                {
                                    "events": [
                                        {
                                            "seq": 1,
                                            "cursor": 1,
                                            "type": "content",
                                            "payload": {"text": "event-1"},
                                            "actor": "agent:planner",
                                            "producer_id": "producer:1",
                                            "producer_seq": 1,
                                        }
                                    ]
                                },
                            ]
                        )
                    )
                    await connection.send(
                        json.dumps(
                            [
                                join_ref,
                                None,
                                topic,
                                "gap",
                                {
                                    "type": "gap",
                                    "reason": "resume_invalidated",
                                    "from_cursor": 1,
                                    "next_cursor": 4,
                                    "committed_cursor": 4,
                                    "earliest_available_cursor": 4,
                                },
                            ]
                        )
                    )
                    first_join.set()
                    return

                if join_count == 2:
                    assert topic == "tail:ses_stream"
                    assert payload == {"cursor": 4}
                    await connection.send(json.dumps([join_ref, ref, topic, "phx_reply", {"status": "ok", "response": {}}]))
                    await connection.send(
                        json.dumps(
                            [
                                join_ref,
                                None,
                                topic,
                                "events",
                                {
                                    "events": [
                                        {
                                            "seq": 4,
                                            "cursor": 4,
                                            "type": "content",
                                            "payload": {"text": "event-4"},
                                            "actor": "agent:planner",
                                            "producer_id": "producer:4",
                                            "producer_seq": 4,
                                        }
                                    ]
                                },
                            ]
                        )
                    )
                    second_join.set()
                    await asyncio.sleep(0.05)
                    return

            if topic == "phoenix" and event == "heartbeat":
                await connection.send(
                    json.dumps([None, ref, "phoenix", "phx_reply", {"status": "ok", "response": {}}])
                )

    async with serve(handler, "127.0.0.1", 0) as server:
        sockets = server.sockets
        assert sockets
        host, port = sockets[0].getsockname()[0:2]
        yield (f"ws://{host}:{port}/socket/websocket", PhoenixScenario(first_join, second_join, received_queries))


@pytest.mark.asyncio
async def test_creates_sessions_and_appends_events_using_v1_routes() -> None:
    recorder = Recorder(
        [
            json_response(
                201,
                {
                    "id": "ses_1",
                    "title": "Draft",
                    "metadata": {},
                    "last_seq": 0,
                    "created_at": "2026-02-11T00:00:00Z",
                    "updated_at": "2026-02-11T00:00:00Z",
                },
            ),
            json_response(
                200,
                {
                    "token": make_session_token("ses_1", "researcher"),
                    "expires_in": 3600,
                },
            ),
            json_response(201, {"seq": 1, "last_seq": 1, "deduped": False}),
        ]
    )

    async with Starcite(
        base_url="http://localhost:4000",
        api_key=make_api_key(),
        requester=recorder,
    ) as starcite:
        identity = starcite.agent("researcher")
        session = await starcite.create_session(identity, title="Draft")
        result = await session.append_text("Found 8 relevant cases...")

    assert session.id == "ses_1"
    assert result.seq == 1
    assert len(recorder.requests) == 3
    assert recorder.requests[0].url == "http://localhost:4000/v1/sessions"
    assert recorder.requests[1].url == "https://starcite.ai/api/v1/session-tokens"
    assert recorder.requests[2].url == "http://localhost:4000/v1/sessions/ses_1/append"

    append_payload = body_json(recorder.requests[2])
    assert append_payload["type"] == "content"
    assert append_payload["payload"] == {"text": "Found 8 relevant cases..."}
    assert append_payload["source"] == "agent"
    assert "actor" not in append_payload
    assert isinstance(append_payload["producer_id"], str)
    assert append_payload["producer_seq"] == 1


@pytest.mark.asyncio
async def test_preserves_explicit_actor_override_when_appending() -> None:
    recorder = Recorder(
        [json_response(201, {"seq": 1, "last_seq": 1, "deduped": False})]
    )

    async with Starcite(base_url="http://localhost:4000", requester=recorder) as starcite:
        session = starcite.session_from_token(make_session_token("ses_actor_override", "writer"))
        await session.append_event(
            payload={"text": "custom actor"},
            type="custom",
            actor="agent:researcher",
        )

    append_payload = body_json(recorder.requests[0])
    assert append_payload["actor"] == "agent:researcher"
    assert append_payload["type"] == "custom"
    assert append_payload["payload"] == {"text": "custom actor"}


@pytest.mark.asyncio
async def test_list_sessions_encodes_filters() -> None:
    recorder = Recorder(
        [
            json_response(
                200,
                {
                    "sessions": [
                        {
                            "id": "ses_1",
                            "title": "Draft",
                            "metadata": {"workflow": "planner"},
                            "created_at": "2026-02-11T00:00:00Z",
                        }
                    ],
                    "next_cursor": "cursor_2",
                },
            )
        ]
    )

    async with Starcite(
        base_url="http://localhost:4000",
        api_key=make_api_key(),
        requester=recorder,
    ) as starcite:
        page = await starcite.list_sessions(
            limit=10,
            cursor="cursor_1",
            metadata={"workflow": "planner"},
        )

    assert page.next_cursor == "cursor_2"
    parsed = urlparse(recorder.requests[0].url)
    query = parse_qs(parsed.query)
    assert query == {
        "limit": ["10"],
        "cursor": ["cursor_1"],
        "metadata.workflow": ["planner"],
    }


@pytest.mark.asyncio
async def test_requires_session_id_claim_for_token_binding() -> None:
    async with Starcite(base_url="http://localhost:4000") as starcite:
        token = token_from_claims({"tenant_id": "test-tenant"})
        with pytest.raises(StarciteError, match="session_id"):
            starcite.session_from_token(token)


@pytest.mark.asyncio
async def test_memory_store_rehydrates_session_log() -> None:
    recorder = Recorder([])
    store = MemoryStore()
    store.save(
        "ses_store",
        SessionStoreState(
            last_seq=1,
            cursor=1,
            events=[
                TailEvent(
                    seq=1,
                    cursor=1,
                    type="content",
                    payload={"text": "restored"},
                    actor="agent:planner",
                    producer_id="producer_1",
                    producer_seq=1,
                    source="agent",
                )
            ],
        ),
    )

    async with Starcite(
        base_url="http://localhost:4000",
        requester=recorder,
        store=store,
    ) as starcite:
        session = starcite.session_from_token(make_session_token("ses_store"))
        state = session.state()

    assert state.last_seq == 1
    assert state.cursor == 1
    assert state.events[0].payload == {"text": "restored"}
    assert session.events[0].payload == {"text": "restored"}


@pytest.mark.asyncio
async def test_stream_events_is_canonical_and_recovers_from_gap() -> None:
    session_token = make_session_token("ses_stream", "planner")

    async with run_phoenix_server() as (websocket_url, scenario):
        async with Starcite(base_url="http://localhost:4000") as starcite:
            session = starcite.session_from_token(session_token)
            session._transport = replace(
                session._transport,
                websocket_url=websocket_url,
            )

            seen: list[int] = []
            async for event in session.stream_events():
                seen.append(event.seq)
                if len(seen) == 2:
                    break

    assert seen == [1, 4]
    assert session.events[-1].seq == 4
    assert session.state().cursor == 4
    assert scenario.received_queries[0]["token"] == [session_token]
