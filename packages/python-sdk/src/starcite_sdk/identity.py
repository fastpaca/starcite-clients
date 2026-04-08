from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PrincipalType = Literal["user", "agent"]


@dataclass(frozen=True)
class StarciteIdentity:
    """Resolved caller identity scoped to one tenant."""

    tenant_id: str
    id: str
    type: PrincipalType

    def __post_init__(self) -> None:
        if self.id.startswith("agent:") or self.id.startswith("user:"):
            raise ValueError(
                f"StarciteIdentity id must not include a principal prefix; received '{self.id}'"
            )

    def to_creator_principal(self) -> dict[str, str]:
        return {"tenant_id": self.tenant_id, "id": self.id, "type": self.type}

    def to_token_principal(self) -> dict[str, str]:
        return {"id": self.id, "type": self.type}

    def to_actor(self) -> str:
        return f"{self.type}:{self.id}"
