# Reliability Failure-Mode Coverage

This matrix maps the six failure modes from:
`https://starcite.ai/blog/why-agent-uis-lose-messages-on-refresh`

## Automated coverage

| Failure mode | SDK coverage | React hook coverage |
| --- | --- | --- |
| 1. Messages disappear after reconnect | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`catches reconnect gaps...`) | `packages/starcite-react/test/use-starcite-chat.test.tsx` (`catches up replayed assistant chunks...`) |
| 2. Duplicate messages after reconnect | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`deduplicates replayed events...`) | `packages/starcite-react/test/chat-protocol.test.ts` (`deduplicates replayed chat messages...`) and `packages/starcite-react/test/use-starcite-chat.test.tsx` (`keeps replay duplicates...`) |
| 3. Tool results appear without tool calls | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`prevents tool-result drift...`) | Covered by ordered event projection from session log (`use-starcite-chat` consumes canonical `session.events()`) |
| 4. Multi-agent messages arrive out of order | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`preserves one global order...`) | Covered by hook projection from canonical ordered events |
| 5. Different tabs show different messages | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`replays identical history to multiple subscribers...`) | `packages/starcite-react/test/use-starcite-chat.test.tsx` (`keeps two hook subscribers converged...`) |
| 6. Deploy breaks active sessions | `packages/typescript-sdk/test/reliability.failure-modes.test.ts` (`reconnects across deploy-style drops...`) | Hook relies on resumed ordered session log and reconnection behavior from SDK session tailing |

## Overhead / impact benchmarks

- SDK:
  - `packages/typescript-sdk/test/session-log.bench.ts`
  - Measures contiguous apply, replay dedup cost, and websocket frame parse cost.
  - `packages/typescript-sdk/test/network-rtt.bench.ts`
  - Measures loopback transport RTT overhead for:
    - append HTTP roundtrip
    - tail replay catch-up from cursor
    - append-to-observed event delivery over HTTP + WebSocket
- React:
  - `packages/starcite-react/test/chat-protocol.bench.ts`
  - Measures projection cost from durable events to `UIMessage[]`, including duplicate replay pressure.

## Commands

```bash
bun run bench
bun run perf:check
bun run --cwd packages/typescript-sdk test
bun run --cwd packages/starcite-react test
```
