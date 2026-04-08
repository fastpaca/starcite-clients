from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from urllib.parse import urlsplit

from .errors import StarciteError
from .identity import PrincipalType, StarciteIdentity


@dataclass(frozen=True)
class ApiKeyContext:
    issuer_authority: str | None
    tenant_id: str | None


@dataclass(frozen=True)
class DecodedSessionToken:
    session_id: str | None
    identity: StarciteIdentity


def _decode_segment(segment: str) -> dict[str, object]:
    padding = "=" * ((4 - len(segment) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(f"{segment}{padding}".encode("ascii"))
    except Exception as exc:  # pragma: no cover - exact base64 failure message is not important
        raise StarciteError(f"Invalid JWT segment encoding: {exc}") from exc

    try:
        value = json.loads(decoded.decode("utf-8"))
    except Exception as exc:
        raise StarciteError(f"Invalid JWT JSON payload: {exc}") from exc

    if not isinstance(value, dict):
        raise StarciteError("JWT payload must decode to an object")

    return value


def _decode_claims(token: str) -> dict[str, object]:
    parts = token.split(".")
    if len(parts) < 2:
        raise StarciteError("JWT must contain at least header and payload segments")
    return _decode_segment(parts[1])


def _resolve_principal(raw_id: str, default_type: PrincipalType) -> tuple[str, PrincipalType]:
    if raw_id.startswith("agent:"):
        return raw_id[len("agent:") :], "agent"
    if raw_id.startswith("user:"):
        return raw_id[len("user:") :], "user"
    return raw_id, default_type


def decode_api_key_context(api_key: str) -> ApiKeyContext:
    claims = _decode_claims(api_key)
    issuer = claims.get("iss")
    issuer_authority: str | None = None
    if isinstance(issuer, str) and issuer:
        parts = urlsplit(issuer)
        if parts.scheme and parts.netloc:
            issuer_authority = f"{parts.scheme}://{parts.netloc}"
    tenant_id = claims.get("tenant_id")
    return ApiKeyContext(
        issuer_authority=issuer_authority,
        tenant_id=tenant_id if isinstance(tenant_id, str) and tenant_id else None,
    )


def decode_session_token(token: str) -> DecodedSessionToken:
    claims = _decode_claims(token)
    tenant_id = claims.get("tenant_id")
    if not isinstance(tenant_id, str) or tenant_id == "":
        raise StarciteError("Session token must include a non-empty tenant_id claim")

    session_id = claims.get("session_id")
    resolved_session_id = session_id if isinstance(session_id, str) and session_id else None

    raw_id = claims.get("principal_id")
    if not isinstance(raw_id, str) or raw_id == "":
        raw_id = claims.get("sub") if isinstance(claims.get("sub"), str) else "session-user"

    principal_type_value = claims.get("principal_type")
    default_type: PrincipalType = (
        principal_type_value
        if principal_type_value in {"user", "agent"}
        else "user"
    )
    principal_id, principal_type = _resolve_principal(raw_id, default_type)

    return DecodedSessionToken(
        session_id=resolved_session_id,
        identity=StarciteIdentity(
            tenant_id=tenant_id,
            id=principal_id,
            type=principal_type,
        ),
    )
