# Multi-Agent Shared Session

Use this when multiple backend agents should stream into the same user-visible
session.

## Goal

All participating agents should:

- bind the same `sessionId`
- use distinct agent identities
- append their own output into the same Starcite session timeline

The frontend should render one shared session and observe all of them there.

## Required Behavior

The multi-agent model should still use the same primitives:

- `starcite.on("session.created", ...)`
- `starcite.session({ identity, id })`
- `session.on("event", ...)`
- `session.append(...)`

Coordinator patterns are allowed, but the coordinator should still use the
shared session as the system of record.

## Preserve

Preserve the app's existing:

- orchestration logic
- tool calls
- agent roles
- model choices
- UI presentation of multiple agents

## Change

Replace any custom transport fanout with shared-session fanout.

In practice that means:

- workers should not stream directly to the browser
- workers should append into the shared session
- the UI should not hold separate live streams per agent

## Anti-Patterns

Do not:

- build separate browser transport channels per agent
- parse natural-language coordinator output as orchestration state
- hide shared-session semantics behind extra runtime abstractions in the demo path

## References

- `docs/ai-sdk-migration.md`
- `examples/multi-agent-viewer/lib/agent.ts`
- `examples/multi-agent-viewer/app/page.tsx`
