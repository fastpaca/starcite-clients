# starcite-sdk

Async Python SDK for [Starcite](https://starcite.ai), built around the native Python shape instead of mirroring the TypeScript surface.

The package is async by default:

- `async with Starcite(...)` manages the underlying HTTP client lifecycle
- `await create_session(...)` creates or binds a session and mints a session token
- `session_from_token(...)` binds directly from an existing session token
- `await append_text(...)` / `await append_event(...)` handle append writes
- `async for event in session.stream_events()` is the canonical session read interface

Live streaming uses the Phoenix Python client under the hood, with Starcite-specific token auth and cursor-based resume handling layered on top.

## Install

```bash
uv add starcite-sdk
```

For local development in this monorepo:

```bash
uv sync --directory packages/python-sdk --dev
```

## Usage

```python
import asyncio

from starcite_sdk import MemoryStore, Starcite

async def main() -> None:
    async with Starcite(
        base_url="https://your-instance.starcite.io",
        api_key="...",
        store=MemoryStore(),
    ) as starcite:
        planner = starcite.agent("planner")
        session = await starcite.create_session(
            planner,
            title="Planning session",
            metadata={"workflow": "planner"},
        )

        await session.append_text("Planning started")

        async for event in session.stream_events():
            print(event.seq, event.type, event.payload)


asyncio.run(main())
```

If you already have a session token, bind directly:

```python
import asyncio

from starcite_sdk import Starcite

async def main() -> None:
    async with Starcite(base_url="https://your-instance.starcite.io") as starcite:
        session = starcite.session_from_token("...")
        await session.append_event(
            type="tool_result",
            payload={"name": "search", "status": "ok"},
        )


asyncio.run(main())
```

## Development

```bash
uv sync --directory packages/python-sdk --dev
uv run --directory packages/python-sdk pytest
uv build --directory packages/python-sdk
```
