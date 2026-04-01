from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import cast

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from starcite_sdk import Starcite, StarciteError
from starcite_sdk.transport import to_websocket_base_url

from .schemas import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionStatusResponse,
    SubmitMessageRequest,
    SubmitMessageResponse,
)
from .swarm import (
    DEFAULT_TITLE,
    RUNTIME_NAME,
    ResearchSwarm,
    RuntimeSessionMismatchError,
)

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if value:
        return value
    raise RuntimeError(f"Set the {name} environment variable before starting the app.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _require_env("OPENAI_API_KEY")

    async with Starcite(
        base_url=os.environ.get("STARCITE_BASE_URL", "https://api.starcite.io"),
        api_key=_require_env("STARCITE_API_KEY"),
    ) as starcite:
        app.state.api_base_url = starcite.base_url
        app.state.websocket_url = f"{to_websocket_base_url(starcite.base_url)}/socket"
        app.state.swarm = ResearchSwarm(
            starcite=starcite,
            coordinator_model=(
                os.environ.get("OPENAI_COORDINATOR_MODEL")
                or os.environ.get("OPENAI_MODEL")
                or "gpt-4.1-mini"
            ),
            worker_model=(
                os.environ.get("OPENAI_WORKER_MODEL")
                or os.environ.get("OPENAI_MODEL")
                or "gpt-4.1-nano"
            ),
        )
        yield
        await app.state.swarm.close()


app = FastAPI(
    title="Starcite LangChain FastAPI Example",
    summary="Async multi-agent FastAPI example backed by Starcite.",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _swarm(request: Request) -> ResearchSwarm:
    return cast(ResearchSwarm, request.app.state.swarm)


@app.get("/", include_in_schema=False)
async def ui() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(status_code=204)


@app.get("/api")
async def root() -> dict[str, str]:
    return {
        "name": "starcite-langchain-fastapi-example",
        "docs": "/docs",
        "create_session": "/sessions",
        "messages": "/sessions/{session_id}/messages",
    }


@app.post("/sessions", response_model=CreateSessionResponse)
async def create_session(
    payload: CreateSessionRequest,
    request: Request,
) -> CreateSessionResponse:
    session_id = payload.session_id.strip() or None if payload.session_id else None
    try:
        session = await _swarm(request).create_user_session(
            session_id=session_id,
            title=payload.title or DEFAULT_TITLE,
        )
    except RuntimeSessionMismatchError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except StarciteError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return CreateSessionResponse(
        session_id=session.id,
        token=session.token,
        title=payload.title or DEFAULT_TITLE,
        api_base_url=cast(str, request.app.state.api_base_url),
        websocket_url=cast(str, request.app.state.websocket_url),
    )


@app.get("/sessions/{session_id}", response_model=SessionStatusResponse)
async def session_status(session_id: str, request: Request) -> SessionStatusResponse:
    if not await _swarm(request).is_runtime_session(session_id):
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' is not available in the {RUNTIME_NAME} runtime.",
        )
    return SessionStatusResponse(
        session_id=session_id,
        running=_swarm(request).is_running(session_id),
    )


@app.post("/sessions/{session_id}/messages", response_model=SubmitMessageResponse)
async def submit_message(
    session_id: str,
    payload: SubmitMessageRequest,
    request: Request,
) -> SubmitMessageResponse:
    try:
        accepted = await _swarm(request).start_turn(session_id, payload.text)
    except RuntimeSessionMismatchError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except StarciteError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not accepted:
        raise HTTPException(
            status_code=409,
            detail="A research swarm run is already active for this session.",
        )
    return SubmitMessageResponse(session_id=session_id, accepted=True, running=True)
