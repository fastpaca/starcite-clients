#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bumpType = process.argv[2];

if (!(bumpType && ["patch", "minor", "major"].includes(bumpType))) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major>");
  process.exit(1);
}

function run(command, options = {}) {
  console.log(`$ ${command}`);
  return execSync(command, { stdio: "inherit", ...options });
}

function runQuiet(command) {
  return execSync(command, { stdio: "pipe" }).toString().trim();
}

function getVersion() {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
  if (typeof rootPackage.version !== "string") {
    throw new Error("Root package.json version must be a string");
  }
  return rootPackage.version;
}

function main() {
  // Require a clean git worktree before any release mutations.
  const status = runQuiet("git status --porcelain");
  if (status.length > 0) {
    console.error("Working tree is not clean. Commit or stash changes first.");
    process.exit(1);
  }

  run(`bun run version:${bumpType}`);
  const version = getVersion();
  const tag = `v${version}`;

  // Keep release quality gate aligned with the local workflow.
  run("bun run lint");
  run("bun run typecheck");
  run("bun run test");
  run("bun run build");

  // Guard against accidental duplicate tags.
  const tagExists = runQuiet(`git tag -l ${tag}`) === tag;
  if (tagExists) {
    console.error(`Tag ${tag} already exists locally. Aborting release.`);
    process.exit(1);
  }

  run("git add .");
  run(`git commit -m "release: ${tag}"`);
  run(`git tag ${tag}`);

  console.log("");
  console.log(`Release commit and tag created for ${tag}.`);
  console.log("Next steps:");
  console.log("1. git push origin main");
  console.log(`2. git push origin ${tag}`);
  console.log(
    `3. Create a GitHub Release for ${tag} (this triggers npm publish).`
  );
}

main();
