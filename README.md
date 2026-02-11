# Starcite Clients Monorepo

This repository contains Starcite client implementations.

Current packages:

- `@starcite/sdk` (TypeScript SDK)
- `starcite` (TypeScript CLI)

Planned:

- Python SDK (scaffolded at `packages/python-sdk`)

## Structure

- `packages/typescript-sdk` TypeScript SDK
- `packages/starcite-cli` TypeScript CLI package
- `packages/python-sdk` Python SDK placeholder for upcoming work

## Prerequisites

- Node.js 22+
- pnpm 10+
- A running Starcite API (default: `http://localhost:4000`)

You can run Starcite locally from the server repo:

```bash
cd ~/git/fastpaca/starcite
docker compose up -d
```

## Install

```bash
pnpm install
```

## Build, Lint, Test

```bash
pnpm build
pnpm lint
pnpm test
```

## Quick Local CLI Flow

Use the CLI package directly during development:

```bash
pnpm starcite create --title "Draft contract"
pnpm starcite append ses_demo --agent researcher --text "Found 8 relevant cases..."
pnpm starcite tail ses_demo --agent researcher --limit 1
```

Set `STARCITE_BASE_URL` if your API is not at `http://localhost:4000`.

## TypeScript SDK Example

```ts
import { starcite } from "@starcite/sdk";

const session = await starcite.create({ title: "Draft contract" });

await session.append({
  agent: "researcher",
  text: "Found 8 relevant cases..."
});

for await (const event of session.tail({ agent: "researcher" })) {
  console.log(event.text);
}
```
