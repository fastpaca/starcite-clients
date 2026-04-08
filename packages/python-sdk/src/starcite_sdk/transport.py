from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar
from urllib.parse import urljoin, urlparse

import httpx

from .errors import StarciteApiError, StarciteConnectionError, StarciteError
from .types import RequestOptions

T = TypeVar("T")
Parser = Callable[[object], T]


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None = None
    timeout_seconds: float | None = None


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    body: bytes
    headers: dict[str, str]
    reason: str = ""


AsyncRequester = Callable[[HttpRequest], Awaitable[HttpResponse]]


@dataclass(frozen=True)
class TransportConfig:
    base_url: str
    websocket_url: str
    requester: AsyncRequester
    bearer_token: str | None = None


def strip_trailing_slashes(value: str) -> str:
    return value.rstrip("/")


def parse_http_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise StarciteError(f"URL must use http:// or https://: {value}")
    if parsed.netloc == "":
        raise StarciteError(f"URL must include a host: {value}")
    path = strip_trailing_slashes(parsed.path)
    return parsed._replace(path=path).geturl()


def to_api_base_url(base_url: str) -> str:
    normalized = strip_trailing_slashes(parse_http_url(base_url))
    return normalized if normalized.endswith("/v1") else f"{normalized}/v1"


def to_websocket_base_url(api_base_url: str) -> str:
    parsed = urlparse(parse_http_url(api_base_url))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return strip_trailing_slashes(parsed._replace(scheme=scheme).geturl())


def to_phoenix_websocket_url(api_base_url: str) -> str:
    return f"{to_websocket_base_url(api_base_url)}/socket/websocket"


def make_httpx_requester(client: httpx.AsyncClient) -> AsyncRequester:
    async def requester(request: HttpRequest) -> HttpResponse:
        response = await client.request(
            method=request.method,
            url=request.url,
            headers=request.headers,
            content=request.body,
            timeout=request.timeout_seconds,
        )
        return HttpResponse(
            status_code=response.status_code,
            body=response.content,
            headers=dict(response.headers.items()),
            reason=response.reason_phrase,
        )

    return requester


async def request_with_base_url(
    transport: TransportConfig,
    *,
    base_url: str,
    path: str,
    method: str,
    parser: Parser[T],
    body: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    request_options: RequestOptions | None = None,
) -> T:
    request_headers: dict[str, str] = {}
    if transport.bearer_token:
        request_headers["authorization"] = f"Bearer {transport.bearer_token}"
    if body is not None:
        request_headers["content-type"] = "application/json"
    if headers:
        request_headers.update(headers)

    request_body = json.dumps(body).encode("utf-8") if body is not None else None
    url = urljoin(f"{strip_trailing_slashes(base_url)}/", path.lstrip("/"))

    try:
        response = await transport.requester(
            HttpRequest(
                method=method,
                url=url,
                headers=request_headers,
                body=request_body,
                timeout_seconds=request_options.timeout_seconds if request_options else None,
            )
        )
    except StarciteError:
        raise
    except httpx.HTTPError as exc:
        raise StarciteConnectionError(
            f"Failed to connect to Starcite at {base_url}: {exc}"
        ) from exc
    except Exception as exc:
        raise StarciteConnectionError(
            f"Failed to connect to Starcite at {base_url}: {exc}"
        ) from exc

    payload: dict[str, object] | None = None
    if response.body:
        try:
            decoded = json.loads(response.body.decode("utf-8"))
            if isinstance(decoded, dict):
                payload = decoded
        except Exception as exc:
            if 200 <= response.status_code < 300:
                raise StarciteConnectionError(
                    f"Received invalid JSON from Starcite: {exc}"
                ) from exc

    if not 200 <= response.status_code < 300:
        code = (
            payload.get("error")
            if isinstance(payload, dict) and isinstance(payload.get("error"), str)
            else f"http_{response.status_code}"
        )
        message = (
            payload.get("message")
            if isinstance(payload, dict) and isinstance(payload.get("message"), str)
            else response.reason
            or f"HTTP {response.status_code}"
        )
        raise StarciteApiError(message, response.status_code, code, payload)

    if response.status_code == 204:
        return parser(None)

    try:
        return parser(payload)
    except (TypeError, ValueError) as exc:
        raise StarciteConnectionError(
            f"Received invalid JSON from Starcite: {exc}"
        ) from exc


async def request_json(
    transport: TransportConfig,
    *,
    path: str,
    method: str,
    parser: Parser[T],
    body: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    request_options: RequestOptions | None = None,
) -> T:
    return await request_with_base_url(
        transport,
        base_url=transport.base_url,
        path=path,
        method=method,
        parser=parser,
        body=body,
        headers=headers,
        request_options=request_options,
    )
