# Contributing

Thanks for contributing to Starcite clients.

## Prerequisites

- Bun `1.3.9`
- Node.js `22+`
- Docker (only needed for `starcite up/down` local runtime tests)

## Setup

```bash
bun install
```

## Development workflow

1. Create a branch from `main`.
2. Make focused changes with tests.
3. Run checks locally:

```bash
bun run check
```

4. Open a pull request describing behavior changes and migration impact.

## Package layout

- `packages/typescript-sdk`: `@starcite/sdk`
- `packages/starcite-cli`: `starcite` CLI

## Releasing

Release and publish are tag-driven from GitHub Actions.

```bash
bun run release:patch
# or: bun run release:minor / bun run release:major

git push origin main
git push origin vX.Y.Z
```

Then publish from a GitHub Release for that tag (`vX.Y.Z`).
