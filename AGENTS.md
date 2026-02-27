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
