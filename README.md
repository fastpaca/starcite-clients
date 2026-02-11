# Starcite Clients Monorepo

Client SDKs and tooling for [Starcite](https://starcite.ai).

This repo is structured so TypeScript packages work today and Python (plus other languages) can be added without changing release/version workflows.

## Packages

- `@starcite/sdk` (`packages/typescript-sdk`): TypeScript SDK
- `starcite` (`packages/starcite-cli`): CLI
- `packages/python-sdk`: Python SDK scaffold (not published yet)

Package-level READMEs are the canonical docs for npm users:

- `packages/typescript-sdk/README.md`
- `packages/starcite-cli/README.md`

## Prerequisites

- Node.js 22+
- Bun 1.3+
- Starcite API running at `http://localhost:4000` (or set `STARCITE_BASE_URL`)

Run Starcite locally:

```bash
cd ~/git/fastpaca/starcite
docker compose up -d
```

## Workspace Commands

```bash
bun install
bun run build
bun run lint
bun run typecheck
bun run test
```

## Local CLI Flow

```bash
bun run starcite create --id ses_demo --title "Draft contract"
bun run starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
bun run starcite tail ses_demo --cursor 0 --limit 1
```

## Compile CLI Binary

```bash
bun run starcite:compile
./packages/starcite-cli/dist/starcite --help
```

## Versioning and Release

Version commands (sync root and package versions):

```bash
bun run version:patch
bun run version:minor
bun run version:major
bun run version:set -- 0.2.0
```

Prepare release commit (runs lint/typecheck/test/build):

```bash
bun run release:patch
```

Dry-run package publish:

```bash
bun run publish:dry
```
