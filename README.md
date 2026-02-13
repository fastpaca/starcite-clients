# Starcite Clients Monorepo

Client SDKs and CLI tooling for [Starcite](https://starcite.ai).

This workspace ships in lockstep with shared versioning and release automation.

## What to read first

- `@starcite/sdk` (`packages/typescript-sdk`): TypeScript SDK
- `starcite` (`packages/starcite-cli`): Terminal client for sessions and events

Package READMEs are the canonical docs for their respective tools:

- `packages/typescript-sdk/README.md`
- `packages/starcite-cli/README.md`

## Prerequisites

- Node.js 22+
- Bun 1.3+
- Running Starcite API (default: `http://localhost:4000` or set `STARCITE_BASE_URL`)

## Quick Start

1. Install dependencies in this monorepo

```bash
bun install
```

2. Point the clients at your API (optional if `http://localhost:4000` is your target):

```bash
export STARCITE_BASE_URL=https://api.your-domain.example
```

3. Run an end-to-end flow

```bash
bun run starcite create --id ses_demo --title "Draft contract"
bun run starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
bun run starcite tail ses_demo --cursor 0 --limit 1
```

## Workspace Commands (Dev)

```bash
bun run build
bun run lint
bun run typecheck
bun run test
```

## Compile CLI Binary

```bash
bun run starcite:compile
./packages/starcite-cli/dist/starcite --help
```

## Versioning and Release

This repo uses a shared pre-1.0 policy and lockstep versioning for publishable packages.

Use these commands for version updates:

```bash
bun run version:patch
bun run version:minor
bun run version:major
bun run version:set -- 0.2.0
```

Use `major` only for intentional major-version shifts. Setting `version:set` to `>=1.0.0` without `STARCITE_ALLOW_MAJOR=1` is blocked.

### Manual Release Flow

1. Bump versions and create release commit + tag

```bash
bun run release:patch
bun run release:minor
bun run release:major
```

2. Push commits and tag

```bash
git push origin main
git push origin vX.Y.Z
```

3. Publish using GitHub Releases (required by your repo automation)

- Create release `vX.Y.Z` in GitHub
- Workflow `.github/workflows/publish-npm.yml` publishes on `release.published`
- CI verifies versions and publishes packages to npm

Required secret: `NPM_TOKEN` (`Settings -> Secrets and variables -> Actions`).
