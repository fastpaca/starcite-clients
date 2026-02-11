#!/usr/bin/env node

import { execSync } from "node:child_process";

const bumpType = process.argv[2];

if (!(bumpType && ["patch", "minor", "major"].includes(bumpType))) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

const run = (command) => {
  console.log(`$ ${command}`);
  execSync(command, { stdio: "inherit" });
};

run("git diff --quiet");
run(`bun run version:${bumpType}`);
run("bun run lint");
run("bun run typecheck");
run("bun run test");
run("bun run build");
run("git add .");
run('git commit -m "release: bump versions"');
console.log("Release commit prepared. Create/tag/publish manually as needed.");
