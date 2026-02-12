#!/usr/bin/env node

import { execSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const RELEASE_SUBJECT_PREFIX = "release: v";
const CONVENTIONAL_COMMIT_REGEX = /^([a-z]+)(?:\([^)]+\))?(!)?:\s+/i;
const PATCH_TYPES = new Set(["fix", "chore"]);
const MINOR_TYPES = new Set(["feat"]);

function run(command) {
  console.log(`$ ${command}`);
  return execSync(command, { stdio: "inherit" });
}

function runQuiet(command) {
  return execSync(command, { stdio: "pipe", encoding: "utf8" }).trim();
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function getRootVersion() {
  const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));

  if (typeof rootPackage.version !== "string") {
    throw new Error("Root package.json version must be a string");
  }

  return rootPackage.version;
}

function getLatestTag() {
  try {
    const tag = runQuiet(
      "git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1"
    );
    return tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

function getCommitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = runQuiet(`git log --format=%H%x09%s ${range}`);

  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => {
      const [hash, subject] = line.split("\t");
      return { hash, subject: subject ?? "" };
    })
    .filter((commit) => commit.subject.length > 0);
}

function determineBump(commits) {
  let hasMinor = false;
  let hasPatch = false;

  for (const commit of commits) {
    if (commit.subject.startsWith(RELEASE_SUBJECT_PREFIX)) {
      continue;
    }

    const match = commit.subject.match(CONVENTIONAL_COMMIT_REGEX);
    if (!match) {
      continue;
    }

    const type = match[1].toLowerCase();

    if (MINOR_TYPES.has(type)) {
      hasMinor = true;
      continue;
    }

    if (PATCH_TYPES.has(type)) {
      hasPatch = true;
    }
  }

  if (hasMinor) {
    return "minor";
  }

  if (hasPatch) {
    return "patch";
  }

  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let forcedBump = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--bump") {
      const value = args[i + 1];
      if (!(value && ["patch", "minor"].includes(value))) {
        throw new Error("Usage: --bump <patch|minor>");
      }
      forcedBump = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument '${arg}'`);
  }

  return { dryRun, forcedBump };
}

function ensureCleanWorktree() {
  const status = runQuiet("git status --porcelain");

  if (status.length > 0) {
    throw new Error(
      "Working tree is not clean. Commit or stash changes first."
    );
  }
}

function main() {
  const { dryRun, forcedBump } = parseArgs();

  ensureCleanWorktree();

  const latestTag = getLatestTag();
  const commits = getCommitsSince(latestTag);
  const detectedBump = determineBump(commits);
  const bump = forcedBump ?? detectedBump;

  setOutput("latest_tag", latestTag ?? "");
  setOutput("detected_bump", detectedBump ?? "none");
  setOutput("selected_bump", bump ?? "none");

  if (!bump) {
    console.log(
      `No releasable commits found since ${latestTag ?? "repository start"}.`
    );
    setOutput("release_created", "false");
    return;
  }

  console.log(`Selected release bump: ${bump}`);
  console.log(`Commits analyzed: ${commits.length}`);
  console.log(`Latest tag: ${latestTag ?? "(none)"}`);

  if (dryRun) {
    console.log("Dry run: release was not created.");
    setOutput("release_created", "false");
    return;
  }

  run(`bun run release:${bump}`);
  const version = getRootVersion();
  const tag = `v${version}`;

  setOutput("release_created", "true");
  setOutput("release_version", version);
  setOutput("release_tag", tag);

  console.log(`Release prepared: ${tag}`);
}

main();
