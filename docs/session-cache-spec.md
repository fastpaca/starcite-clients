# Session Cache And Session Log Spec

This document defines how the SDK should model session persistence going
forward.

The current code works, but the terminology and data shape imply that the
persisted blob is durable session state. That is the wrong model.

The server is the source of truth.

The client-side persisted blob is a cache.

`SessionLog` is the canonical in-memory materialized view built from
server-derived data.

## 1. Goals

- make the server-truth model explicit in names and contracts
- treat persisted session data as disposable cache, not authoritative state
- keep `SessionLog` as the canonical materialized view for one session
- preserve append outbox restore behavior without conflating it with committed
  session history
- make cache schema changes cheap by preferring invalidation over migration

## 2. Current Mismatch

Today the SDK uses these names:

- `SessionStore`
- `SessionStoreState`
- `SessionStoreMetadata`
- `MemoryStore`
- `WebStorageSessionStore`
- `LocalStorageSessionStore`
- `StarciteOptions.store`

Those names suggest the local blob is a durable source of state. In practice,
the runtime already behaves more like a cache:

- `SessionLog` is the in-memory ordered event view
- same-seq server events overwrite local copies unconditionally
- attach resumes from the cached cursor when available, else from `0`
- invalid cached payloads are dropped and the live stream recovers
- local appends are not inserted into the committed log until the server emits
  the committed event

The main issue is not behavior. The issue is that the API and the persisted
shape teach the wrong mental model.

## 3. Target Model

The SDK should model three different concerns explicitly.

### 3.1 Server Truth

Server truth is everything the backend emits or returns:

- committed session events
- resume cursor / gap cursor
- session records

Only server truth may advance the committed session timeline.

### 3.2 Session Log

`SessionLog` is the canonical in-memory materialized view for one session.

It is built from server-derived inputs:

- a cached checkpoint written from prior server truth
- live tail batches from the server
- gap cursor updates from the server

It is not an optimistic local log.

Local `append()` calls affect the outbox immediately, but they do not mutate
`SessionLog` until the server later commits and emits the corresponding event.

### 3.3 Session Cache

The persisted client blob is a `SessionCache`.

It is a warm-start checkpoint for:

- the materialized session log
- the append outbox

It is optional, disposable, and recoverable.

Deleting it must never change correctness. It may only affect startup replay
cost, time-to-first-render, and whether the append outbox survives process
restart.

## 4. Proposed Names

Rename the public and internal persistence surface like this.

| Current | Proposed | Notes |
| --- | --- | --- |
| `SessionStore` | `SessionCache` | Public interface |
| `SessionStoreState` | `SessionCacheEntry` | Persisted cache payload |
| `SessionStoreMetadata` | `SessionCacheMetadata` | Persisted metadata |
| `MemoryStore` | `MemorySessionCache` | In-memory adapter |
| `WebStorageSessionStore` | `WebStorageSessionCache` | Browser/adapter-backed cache |
| `LocalStorageSessionStore` | `LocalStorageSessionCache` | Browser local cache |
| `SessionStorageSessionStore` | `SessionStorageSessionCache` | Browser session cache |
| `StarciteOptions.store` | `StarciteOptions.cache` | Client option |
| `StarciteSessionOptions.store` | `StarciteSessionOptions.cache` | Internal session option |
| `session-store.ts` | `session-cache.ts` | Source file rename |
| persisted field `append` | persisted field `outbox` | Distinguish uncommitted queue from committed log |
| `load` / `save` | `read` / `write` | Cache semantics |

Names that do not need to change in this pass:

- `SessionLog`
- `SessionSnapshot`
- `session.state()`

`session.state()` describes the current in-memory snapshot, not persisted
storage authority. It is slightly overloaded terminology, but it is not the
main source of confusion.

## 5. Data Model

The cache entry should stop pretending to be the session log itself.

The log owns its checkpoint shape, and the cache stores that checkpoint.

```ts
interface SessionLogCheckpoint<TEvent extends TailEvent = TailEvent> {
  lastSeq: number;
  cursor?: TailCursor;
  events: TEvent[];
}

interface SessionCacheMetadata {
  schemaVersion: 5;
  cachedAtMs: number;
}

interface SessionCacheEntry<TEvent extends TailEvent = TailEvent> {
  log?: SessionLogCheckpoint<TEvent>;
  outbox?: SessionAppendStoreState;
  metadata?: SessionCacheMetadata;
}

interface SessionCache<TEvent extends TailEvent = TailEvent> {
  read(sessionId: string): SessionCacheEntry<TEvent> | undefined;
  write(sessionId: string, entry: SessionCacheEntry<TEvent>): void;
  clear?(sessionId: string): void;
}
```

Notes:

- `log` is optional so the cache can still persist only the outbox when needed.
- `outbox` is optional when append persistence is disabled or empty.
- `metadata` is operational metadata about the cache entry, not session
  metadata.

## 6. Log API Changes

`SessionLog` should stop depending on storage-named types.

Add or rename methods like this:

```ts
class SessionLog {
  restore(checkpoint: SessionLogCheckpoint): void;
  checkpoint(): SessionLogCheckpoint;
}
```

Behavior rules:

- `restore()` may only accept a log checkpoint
- same-seq entries in later server batches overwrite restored cached events
- sparse history remains valid
- invalid checkpoints fail fast and are treated as cache corruption, not
  session corruption

This removes the current `SessionLog.hydrate(state: SessionStoreState)`
coupling.

## 7. Runtime Flow

The runtime should behave like this.

1. Construct an empty `SessionLog`.
2. Construct an empty `AppendQueue`.
3. Read `SessionCacheEntry` for `sessionId`.
4. If the cache payload is unreadable or invalid, clear it and continue.
5. If `entry.log` exists, restore `SessionLog` from `entry.log`.
6. If `entry.outbox` exists, restore the append queue from `entry.outbox`.
7. Reconcile the restored outbox against the restored log before auto-flush.
8. Attach the tail with `cursor = session.log.cursor ?? 0`.
9. On every server batch:
   apply events to `SessionLog`, reconcile the outbox, then rewrite the cache.
10. On every server gap:
    advance the log cursor, then rewrite the cache.
11. On every outbox state change:
    rewrite the cache entry with the latest log checkpoint and outbox snapshot.

The important ordering is:

- server event application updates the log first
- outbox reconciliation runs second
- cache write runs last

That preserves the invariant that the cache is always derived from the current
materialized view plus the current outbox.

## 8. Cache Invariants

These rules should be documented and tested.

- Cache data is best-effort and may be deleted at any time.
- Cache data never wins over server data.
- Same seq from the server overwrites cached event content unconditionally.
- A missing cache entry is a cold start, not an error.
- A corrupt cache entry is cleared and ignored.
- Cache write failures surface as operational errors but do not stop the live
  session.
- The committed log and the uncommitted outbox are separate concerns even when
  stored in one JSON blob.
- The cache must never store session tokens.

## 9. Migration Strategy

This change should prefer invalidation, not migration.

Rationale:

- the cache is not authoritative
- field-by-field migration code adds complexity and false durability
- clearing the cache is safe because the server can rebuild the log

Migration rules:

- bump the entry schema version from `4` to `5`
- rename the default browser key suffix from `sessionStore` to `sessionCache`
- bump the CLI wrapper version from `2` to `3`
- on old schema or old wrapper version, clear the cache entry and continue

Do not write a compatibility translator from `SessionStoreState` to the new
shape unless a concrete migration requirement appears.

## 10. Compatibility Plan

This should roll out in two public phases.

### Phase 1

- add the new `SessionCache` names and types
- add `cache` alongside `store` in `StarciteOptions`
- keep `store` as a deprecated alias
- keep old class exports as deprecated aliases of the renamed cache classes
- switch internal implementation to the new cache entry shape
- switch docs and examples to `cache`

### Phase 2

- remove deprecated `store` aliases in the next major release
- remove deprecated `SessionStore*` export names
- remove deprecated `*Store` class export names

Because this is a cache, compatibility should be focused on API aliases, not on
persisted blob migration.

## 11. Files To Change

Primary SDK files:

- `packages/typescript-sdk/src/types.ts`
- `packages/typescript-sdk/src/session-cache.ts` from current
  `packages/typescript-sdk/src/session-store.ts`
- `packages/typescript-sdk/src/session-log.ts`
- `packages/typescript-sdk/src/session.ts`
- `packages/typescript-sdk/src/client.ts`
- `packages/typescript-sdk/src/index.ts`

Consumers and adapters:

- `packages/starcite-cli/src/store.ts`
- `packages/typescript-sdk/README.md`
- `packages/starcite-cli/README.md`
- `packages/starcite-react/README.md` if it mentions session stores

Tests to update or add:

- `packages/typescript-sdk/test/session-log.test.ts`
- `packages/typescript-sdk/test/client.test.ts`
- `packages/starcite-cli/test/cli.test.ts`

## 12. Test Requirements

The refactor should preserve these behaviors.

- restored cached log replays immediately before live traffic arrives
- same-seq server events overwrite restored cached events
- sparse cached checkpoints remain valid
- corrupt cache is cleared and ignored
- restored outbox flushes when allowed
- paused outbox remains paused after restart
- cache write failures do not kill the live session
- CLI version mismatch clears old persisted cache once

## 13. Non-Goals

This spec does not introduce:

- optimistic local event insertion into `SessionLog`
- TTL or cache eviction policy options
- multi-layer cache abstractions
- a special migrator for old cache payloads
- any change to server authority over committed session history

## 14. Summary

The intended model is simple:

- `SessionLog` is the materialized session view
- `SessionCache` is a warm-start checkpoint of that view plus outbox state
- the server always wins
- cache schema changes should invalidate old entries instead of teaching the SDK
  to trust stale client data
