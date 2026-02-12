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

Lockstep versioning (same model as `pi-mono`): root and all publishable workspace packages share one version.
Pre-1.0 policy: this repo blocks crossing to `>=1.0.0` by default.

Version-only commands:

```bash
bun run version:patch
bun run version:minor
bun run version:major
bun run version:set -- 0.2.0
```

Notes:

- Use `patch`/`minor` while you want to stay pre-1.0.0.
- `major` (or `version:set` to `>=1.0.0`) is blocked unless you explicitly set `STARCITE_ALLOW_MAJOR=1`.

### Semantic Release (Recommended)

Workflow: `.github/workflows/semantic-release.yml`

Trigger:

- `push` to `main`
- manual `workflow_dispatch` (with optional bump override)

Bump rules from commits since latest tag:

- `feat(...)` -> `minor`
- `fix(...)` or `chore(...)` -> `patch`
- anything else -> no release

Local preview:

```bash
bun run release:auto:dry
```

Local release cut using the same analyzer:

```bash
bun run release:auto
```

When a release is cut, CI will:

1. create release commit + tag (`release: vX.Y.Z`)
2. push `main` and `vX.Y.Z`
3. publish `@starcite/sdk` and `starcite` with Bun
4. create GitHub Release `vX.Y.Z`

### Manual Release Flow

Create a release commit and tag manually (runs version bump + lint/typecheck/test/build):

```bash
bun run release:patch
```

That command creates:

- a commit: `release: vX.Y.Z`
- a git tag: `vX.Y.Z`

Then push and publish via GitHub Release workflow:

```bash
git push origin main
git push origin vX.Y.Z
```

1. Create a GitHub Release for that tag (`vX.Y.Z`).
2. Workflow `.github/workflows/publish-npm.yml` triggers on `release.published`.
3. CI verifies tag/version alignment, runs `bun run check` + `bun run build`, then publishes:
   - `@starcite/sdk`
   - `starcite`

Required secret:

- `NPM_TOKEN` in GitHub repo secrets (`Settings -> Secrets and variables -> Actions`)

Optional dry run before tagging:

```bash
bun run publish:dry
```
