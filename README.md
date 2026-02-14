# [Starcite](https://starcite.ai) Clients

Built for multi-agent systems.

`@starcite/sdk` and `starcite` give multiple producers a shared, append-only session feed you can trust for:

- live monitoring of each agent’s work,
- consistent ordering and replay for frontend/UX stability,
- auditable session history you can stream and inspect.

- `@starcite/sdk` (`packages/typescript-sdk`) for app-level integration in TypeScript.
- `starcite` (`packages/starcite-cli`) for terminal-driven workflows and quick experiments.

## Why this exists

Modern AI products often have many agents producing events at the same time. Starcite gives you:

- a single stream that captures everything in order,
- a simple way to **a) listen/monitor** what every agent is doing,
- UI/UX **b) consistency guarantees** so frontend views stay in sync with the same ordered event stream.

## Pick your path

- Start with the TypeScript SDK if you are building an app: `packages/typescript-sdk/README.md`
- Start with the CLI if you are scripting or testing from terminal: `packages/starcite-cli/README.md`

## Get started in minutes

1. Install the CLI

```bash
npm install -g starcite
```

1. Set your customer instance URL and API key

```bash
export STARCITE_BASE_URL=https://<your-instance>.starcite.io
export STARCITE_API_KEY=<YOUR_API_KEY>
```

1. Run a tiny end-to-end flow

```bash
starcite config set endpoint "$STARCITE_BASE_URL"
starcite auth login --api-key "$STARCITE_API_KEY"
starcite create --id ses_demo --title "Draft contract"
starcite sessions list --limit 5
starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
starcite tail ses_demo --cursor 0 --limit 1
```

## Development commands (if you work in this repo)

```bash
bun run build
bun run lint
bun run typecheck
bun run test
```

Build a standalone CLI binary when needed:

```bash
bun run starcite:compile
./packages/starcite-cli/dist/starcite --help
```

## Release process

This repo intentionally uses manual releases.

1. Choose a bump and create the release commit + tag:

```bash
bun run release:patch
bun run release:minor
bun run release:major
```

1. Push the release commit and tag:

```bash
git push origin main
git push origin vX.Y.Z
```

1. Publish through GitHub Releases:

- Create GitHub release `vX.Y.Z`.
- `publish-npm.yml` publishes `@starcite/sdk` and `starcite` when `release.published` runs.

Required secret:

- `NPM_TOKEN` (`Settings -> Secrets and variables -> Actions`)
