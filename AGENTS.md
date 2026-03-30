# Starcite Code Standards

## Quick Reference

```bash
# Repository-wide
bun run format
bun run lint
bun run typecheck
bun run test
bun run check

# Workspace-focused
bun run --cwd packages/typescript-sdk check
bun run --cwd packages/starcite-cli check

# Ultracite diagnostics
bunx ultracite doctor
```

Commits: prefer Conventional Commits (`type(scope): subject`).

---

## TypeScript

Type safety at boundaries, trust internally:
- Use `unknown` at trust boundaries (I/O, JSON, env, network payloads), never `any`.
- Validate external inputs once at boundaries (typically zod), then trust refined types downstream.
- Do not re-implement the type system with redundant runtime checks in trusted internal layers.
- Prefer concrete domain types over broad `Record<string, unknown>` or `object` when possible.

Prefer the type system over runtime guards:
- Use explicit parameter and return types where they improve clarity.
- Favor control-flow narrowing and discriminated unions over assertions.
- Handle discriminated unions exhaustively (`switch` + `assertNever` style when helpful).
- Avoid `as` and non-null assertions when a better type design can prove safety.

Immutability and clarity:
- Default to `const`; use `let` only when mutation is required.
- Avoid mutating function inputs.
- Use meaningful names and extracted constants for business rules and thresholds.

## Starcite-Specific

- Treat SDK/CLI internals as a closed system: enforce invariants with types + tests.
- Runtime validation belongs at external boundaries, not on typed internal arguments.
- No silent failure paths for business logic; throw structured errors when failing.
- Keep contracts explicit: pass dependencies and context as parameters.
- Use shared package types directly; avoid wrapper interface churn without clear need.
- Avoid over-abstraction:
  - No extra "normalize" layers for controlled typed inputs.
  - No one-off helper wrappers that hide straightforward logic.
  - No speculative extensibility hooks without a concrete use case.

## YAGNI & Simplification Rules

These rules codify recurring anti-patterns found during cleanup. Follow them when writing new code and when reviewing existing code.

### Validation placement

- **Zod at wire boundaries only.** Keep `.parse()` / `.safeParse()` where untrusted data enters: server HTTP responses, WebSocket payloads, persisted state loaded from storage, user-supplied config at the public API surface. Never zod-parse typed internal function parameters.
- **Trust internal types.** Once data has been validated at entry, pass it through internal layers with plain TypeScript types. Do not re-validate.

### No speculative features

- **Delete unused options and code paths.** If no consumer exercises a feature today (e.g., `maxEvents` retention, `setMaxEvents`, lifecycle `token_expired` handling for service tokens), remove it. Re-add when a real use case arrives.
- **No configurability for one behavior.** If every caller passes the same value or the default is the only sensible choice, hard-code it. Don't expose an option.

### Server is source of truth

- **Same seq = overwrite unconditionally.** When the server sends an event whose sequence already exists locally, replace without content comparison. No deep-equality helpers (`eventsEqual`, `shallowEqual`, `JSON.stringify` comparison) needed.
- **Don't second-guess server data.** Avoid defensive checks that re-verify server-provided values (e.g., `Math.max(0, serverValue)` when the schema already guarantees non-negative).

### Eliminate unnecessary cloning

- **No defensive `structuredClone` on internal plain data.** If the SDK constructed the object and passes it through internal layers, cloning adds cost with no safety benefit.
- **Return internal arrays as `readonly` instead of `.slice()`.** Only copy at actual public snapshot boundaries where callers might mutate the array.
- **Rely on `JSON.stringify` for copy-on-persist.** Serialization to storage already creates an independent copy; don't pre-clone before serializing.

### Flatten indirection

- **Inline single-use helpers.** If a function is called exactly once and its body is ≤3 lines, inline it at the call site. Examples: `toError(e)` → `e instanceof Error ? e : new StarciteError(String(e))`, `observeListenerResult(r)` → `Promise.resolve(r).catch(...)`.
- **Fold single-consumer modules.** If a class or module is only imported by one parent and just adds a forwarding layer (e.g., `LifecycleRuntime` used only by `Starcite`), fold it into the parent.
- **No double-EventEmitter proxying.** If module A's emitter just re-emits events from module B's emitter, eliminate one layer. The consumer should listen directly on the source.
- **No intermediate variables for naming alone.** If the expression is clear, use it directly instead of assigning to a local just to give it a name.

### Deduplicate state and types

- **One canonical data structure per concern.** If a `Map` provides `.has()`, don't maintain a parallel `Set` of the same keys. If `phase` is `"replay" | "live"`, don't add a redundant `replayed: boolean`.
- **Collapse synonymous type aliases.** If two types/interfaces describe the same shape (e.g., `SessionEvent` vs `TailEvent`), keep one and delete the other.
- **Prune dead exports.** Types, schemas, and constants with zero consumers must be deleted, not left around "in case."

### Error hierarchy integrity

- **Inheritance must reflect actual relationships.** `StarciteTailError` (stream failure) must not extend `StarciteConnectionError` (HTTP transport failure) — they are distinct failure modes. Only subclass when the child genuinely *is-a* instance of the parent.
- **Remove defensive `try/catch` that swallows or re-throws without context.** If failure should propagate, let it. If failure is ignorable (e.g., best-effort cache clear), use a bare `catch {}` with a comment explaining why.

### Overload simplification

- **Single `as any` in implementation body.** For `on`/`off` method overloads, maintain strict public signatures for callers but use one `as any` cast in the internal implementation rather than duplicating logic per overload branch.

### JWT / auth economy

- **Decode only what you use.** If the SDK only needs `tenant_id` and `session_id` from a JWT, don't extract and store unused claims (`sub`, `principal_id`, `identity`).

## Patterns

Functions and flow:
- Prefer pure helpers with effects at the edges.
- Use early returns to flatten control flow.
- Keep functions focused and reduce branching in hot paths.
- Prefer simple conditionals over nested ternaries.

Modern JS/TS:
- Use `for...of` for readable iteration.
- Use `?.` and `??` where they improve intent and safety.
- Prefer template literals over string concatenation.

Async:
- Use `async/await` over promise chains when readability improves.
- Always await promise-returning calls unless intentionally fire-and-forget.
- Handle async errors at meaningful boundaries.

## Error Handling

- Throw `Error` objects with descriptive messages.
- Use typed error classes for boundary/context mapping.
- Avoid catch-and-rethrow with no added context.
- Remove debug leftovers (`console.log`, `debugger`, `alert`) from committed code.

## Performance

- Avoid repeated spreads in hot loops.
- Avoid creating regex literals inside loops.
- Prefer specific imports.
- Keep internal data flow direct and local.

## Testing

- Test behavior and failure states, especially reconnect and durability paths.
- Keep tests deterministic and focused.
- Assertions belong in `it()` / `test()` blocks.
- No `.only` in committed tests.
- Avoid excessive `describe` nesting.

---

## Review Focus

Use tooling for style and linting. Spend review effort on:
1. Business logic correctness
2. Failure-state behavior and recoverability
3. API clarity and type contracts
4. Complexity and unnecessary indirection
5. Naming and maintainability
