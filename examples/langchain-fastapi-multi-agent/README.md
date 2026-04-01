# LangChain + FastAPI Multi-Agent Example

Async Python example that runs a small LangChain research swarm on top of one
shared Starcite session.

The app does three things:

- creates a Starcite session for a demo user
- appends each user prompt to that session as `message.user`
- launches a coordinator plus several specialist agents that stream
  `agent.streaming.chunk` and `agent.done` events back into the same timeline
- serves a small browser UI that mints a session token through FastAPI and then
  tails Starcite directly over Phoenix from the browser

It uses the same event protocol as the existing
`examples/multi-agent-viewer` app, so the session log stays easy to inspect and
the output shape is compatible with the current viewer conventions.

Sessions created by this example are tagged with runtime metadata, and the app
only re-binds to sessions that carry that tag. That keeps this UI isolated from
other Starcite sessions that do not follow the same event protocol.

## Requirements

- `uv`
- `OPENAI_API_KEY`
- `STARCITE_API_KEY`
- optional `STARCITE_BASE_URL` (defaults to `https://api.starcite.io`)
- optional `OPENAI_MODEL`
- optional `OPENAI_COORDINATOR_MODEL`
- optional `OPENAI_WORKER_MODEL`

## Run It

```bash
cd examples/langchain-fastapi-multi-agent
uv sync
uv run uvicorn app.main:app --reload
```

The API will be available at `http://127.0.0.1:8000`, with interactive docs at
`http://127.0.0.1:8000/docs`.

Open `http://127.0.0.1:8000/` to use the UI.

The page does not consume a FastAPI event stream. It uses the session token
from the create-session response and attaches directly to Starcite.

## Example Flow

Create or bind a session:

```bash
curl -sS -X POST http://127.0.0.1:8000/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"LangChain Research Swarm"}'
```

Submit a prompt through the orchestration API:

```bash
curl -sS -X POST http://127.0.0.1:8000/sessions/ses_123/messages \
  -H 'content-type: application/json' \
  -d '{"text":"What are the tradeoffs between SSE and WebSockets for agent UIs?"}'
```

The create-session response includes a Starcite session token. Use that token to
bind a real Starcite client and stream the timeline directly from Starcite
instead of proxying events through FastAPI.

For example, with the Python SDK:

```bash
uv run python - <<'PY'
import asyncio
from starcite_sdk import Starcite

token = "<session-token-from-create-session>"

async def main():
    async with Starcite(base_url="https://api.starcite.io") as starcite:
        session = starcite.session_from_token(token)
        async for event in session.stream_events():
            print(event.type, event.payload)

asyncio.run(main())
PY
```

You will see `message.user`, `agent.plan`, `agent.streaming.chunk`,
`agent.done`, and `agent.error` events from the canonical Starcite event
stream.

## Notes

- This example is async by default all the way through: FastAPI, LangChain
  streaming, and Starcite tailing.
- The browser UI is deliberately not backed by a FastAPI event proxy. It mints
  a session token through FastAPI, then opens a direct Starcite socket from the
  browser.
- The demo keeps one active swarm run per session. A second prompt on the same
  session returns HTTP `409` until the current run finishes.
- Sessions are tagged with `runtime=langchain-fastapi-multi-agent` and
  `protocol=starcite-swarm-v1`, and the API rejects session ids outside that
  runtime.
