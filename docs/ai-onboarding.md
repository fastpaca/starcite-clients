# AI Onboarding

This is the AI-assisted entrypoint for onboarding or migrating an app onto
Starcite.

Use this doc to choose the right reference material. Do not treat any single
example in this repo as a template that must be copied verbatim.

## Purpose

A successful Starcite migration should:

- preserve the app's prompts, tools, models, UI, routing, and business logic
- replace only the chat transport and session orchestration substrate
- keep frontend and backend responsibilities explicit

## Required Reading

Start with:

- [AI SDK To Starcite Migration Spec](./ai-sdk-migration.md)

That file defines the architecture rules and anti-patterns.

## Task Docs

Then use only the task docs that match the app you are migrating:

- [Frontend Session Bootstrap](./tasks/frontend-session-bootstrap.md)
- [Frontend Chat State](./tasks/frontend-chat-state.md)
- [Backend Session Listener](./tasks/backend-session-listener.md)
- [Multi-Agent Shared Session](./tasks/multi-agent-shared-session.md)

## How To Use This Set

1. Read the architecture spec first.
2. Identify which parts of the target app map to session bootstrap, frontend
   chat state, backend response handling, and multi-agent orchestration.
3. Apply only the task docs that match those parts.
4. Use the examples in this repo to validate shape, not to force file layout.

## Non-Goals

These docs are not meant to:

- prescribe framework-specific file names
- force the app to look like `examples/nextjs-chat-ui`
- replace app-specific ownership, auth, or routing decisions

## Reference Implementations

- `examples/nextjs-chat-ui` is the clean happy-path reference for a basic chat
  app
- `examples/multi-agent-viewer` is the shared-session reference for concurrent
  agent streaming
