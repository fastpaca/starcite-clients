from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Self
from urllib.parse import urlencode

import httpx

from .auth import decode_api_key_context, decode_session_token
from .errors import StarciteApiError, StarciteError
from .identity import PrincipalType, StarciteIdentity
from .session import StarciteSession
from .session_store import SessionStore
from .transport import (
    AsyncRequester,
    TransportConfig,
    make_httpx_requester,
    request_json,
    request_with_base_url,
    to_api_base_url,
    to_phoenix_websocket_url,
)
from .types import (
    IssueSessionTokenInput,
    JsonValue,
    RequestOptions,
    SessionListPage,
    SessionRecord,
    parse_issue_session_token_response,
    parse_session_list_page,
    parse_session_record,
)


def _resolve_auth_base_url(
    explicit_auth_url: str | None,
    issuer_authority: str | None,
) -> str | None:
    value = explicit_auth_url or os.environ.get("STARCITE_AUTH_URL") or issuer_authority
    return value.rstrip("/") if value else None


class Starcite:
    """Async-first tenant-scoped Starcite client."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        auth_url: str | None = None,
        requester: AsyncRequester | None = None,
        store: SessionStore | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_base_url = (
            base_url or os.environ.get("STARCITE_BASE_URL") or "http://localhost:4000"
        )
        normalized_base_url = to_api_base_url(resolved_base_url)
        api_key_context = decode_api_key_context(api_key) if api_key else None

        self._owns_http_client = requester is None and http_client is None
        self._http_client = http_client or (
            httpx.AsyncClient() if self._owns_http_client else None
        )
        resolved_requester = requester or make_httpx_requester(
            self._http_client if self._http_client is not None else httpx.AsyncClient()
        )

        self._transport = TransportConfig(
            base_url=normalized_base_url,
            websocket_url=to_phoenix_websocket_url(normalized_base_url),
            requester=resolved_requester,
            bearer_token=api_key,
        )
        self.base_url = self._transport.base_url
        self._api_key = api_key
        self._store = store
        self._auth_base_url = _resolve_auth_base_url(
            auth_url,
            api_key_context.issuer_authority if api_key_context else None,
        )
        self._inferred_tenant_id = api_key_context.tenant_id if api_key_context else None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def close(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    def identity(self, id: str, *, type: PrincipalType) -> StarciteIdentity:
        return StarciteIdentity(
            tenant_id=self._require_tenant_id("identity()"),
            id=id,
            type=type,
        )

    def user(self, id: str) -> StarciteIdentity:
        return self.identity(id, type="user")

    def agent(self, id: str) -> StarciteIdentity:
        return self.identity(id, type="agent")

    async def create_session(
        self,
        identity: StarciteIdentity,
        *,
        session_id: str | None = None,
        title: str | None = None,
        metadata: Mapping[str, JsonValue] | None = None,
    ) -> StarciteSession:
        return await self._session_from_identity(
            identity=identity,
            session_id=session_id,
            title=title,
            metadata=dict(metadata) if metadata is not None else None,
        )

    def session_from_token(self, token: str) -> StarciteSession:
        decoded = decode_session_token(token)
        if decoded.session_id is None:
            raise StarciteError(
                "session_from_token() requires a token with a session_id claim."
            )
        return StarciteSession(
            session_id=decoded.session_id,
            token=token,
            identity=decoded.identity,
            transport=self._build_session_transport(token),
            store=self._store,
        )

    async def list_sessions(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        metadata: Mapping[str, str] | None = None,
        request_options: RequestOptions | None = None,
    ) -> SessionListPage:
        query: list[tuple[str, str]] = []
        if limit is not None:
            query.append(("limit", str(limit)))
        if cursor is not None:
            query.append(("cursor", cursor))
        if metadata is not None:
            for key, value in metadata.items():
                query.append((f"metadata.{key}", value))
        suffix = f"?{urlencode(query)}" if query else ""
        return await request_json(
            self._transport,
            path=f"/sessions{suffix}",
            method="GET",
            parser=parse_session_list_page,
            request_options=request_options,
        )

    async def _session_from_identity(
        self,
        *,
        identity: StarciteIdentity,
        session_id: str | None,
        title: str | None,
        metadata: dict[str, JsonValue] | None,
    ) -> StarciteSession:
        record: SessionRecord | None = None
        resolved_session_id = session_id

        if resolved_session_id is not None:
            try:
                record = await self._create_session(
                    session_id=resolved_session_id,
                    creator_principal=identity.to_creator_principal(),
                    title=title,
                    metadata=metadata,
                )
            except StarciteApiError as exc:
                if exc.status != 409:
                    raise
        else:
            record = await self._create_session(
                creator_principal=identity.to_creator_principal(),
                title=title,
                metadata=metadata,
            )
            resolved_session_id = record.id

        token_response = await self._issue_session_token(
            IssueSessionTokenInput(
                session_id=resolved_session_id,
                principal=identity.to_token_principal(),
                scopes=["session:read", "session:append"],
            )
        )

        return StarciteSession(
            session_id=resolved_session_id,
            token=token_response.token,
            identity=identity,
            transport=self._build_session_transport(token_response.token),
            store=self._store,
            record=record,
        )

    def _build_session_transport(self, token: str) -> TransportConfig:
        return TransportConfig(
            base_url=self._transport.base_url,
            websocket_url=self._transport.websocket_url,
            requester=self._transport.requester,
            bearer_token=token,
        )

    async def _create_session(
        self,
        *,
        session_id: str | None = None,
        creator_principal: dict[str, str] | None = None,
        title: str | None = None,
        metadata: dict[str, JsonValue] | None = None,
    ) -> SessionRecord:
        body: dict[str, object] = {}
        if session_id is not None:
            body["id"] = session_id
        if creator_principal is not None:
            body["creator_principal"] = creator_principal
        if title is not None:
            body["title"] = title
        if metadata is not None:
            body["metadata"] = metadata
        return await request_json(
            self._transport,
            path="/sessions",
            method="POST",
            parser=parse_session_record,
            body=body,
        )

    async def _issue_session_token(self, input: IssueSessionTokenInput):
        if self._api_key is None:
            raise StarciteError("create_session() requires api_key.")
        if self._auth_base_url is None:
            raise StarciteError(
                "create_session() could not resolve auth issuer URL. Set auth_url, STARCITE_AUTH_URL, or use an API key JWT with an 'iss' claim."
            )
        return await request_with_base_url(
            self._transport,
            base_url=self._auth_base_url,
            path="/api/v1/session-tokens",
            method="POST",
            parser=parse_issue_session_token_response,
            body=input.to_wire(),
            headers={"cache-control": "no-store"},
        )

    def _require_tenant_id(self, method: str) -> str:
        if self._inferred_tenant_id is None:
            raise StarciteError(f"{method} requires api_key to determine tenant.")
        return self._inferred_tenant_id
