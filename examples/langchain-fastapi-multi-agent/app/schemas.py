from pydantic import BaseModel, Field


class CreateSessionRequest(BaseModel):
    session_id: str | None = Field(
        default=None,
        description="Optional existing session id to bind instead of creating a new one.",
    )
    title: str = Field(default="LangChain Research Swarm")


class CreateSessionResponse(BaseModel):
    session_id: str
    token: str
    title: str
    api_base_url: str
    websocket_url: str


class SubmitMessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8_000)


class SubmitMessageResponse(BaseModel):
    session_id: str
    accepted: bool
    running: bool


class SessionStatusResponse(BaseModel):
    session_id: str
    running: bool
