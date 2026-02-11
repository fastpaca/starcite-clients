#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rootPackageJsonPath = join(process.cwd(), "package.json");
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

function readRootPackage() {
  return JSON.parse(readFileSync(rootPackageJsonPath, "utf8"));
}

function writeRootPackage(pkg) {
  writeFileSync(rootPackageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function bump(version, type) {
  const parts = version
    .split(".")
    .map((segment) => Number.parseInt(segment, 10));

  if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid semver '${version}'`);
  }

  const [major, minor, patch] = parts;

  if (type === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }

  if (type === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  if (type === "major") {
    return `${major + 1}.0.0`;
  }

  throw new Error(`Unsupported bump type '${type}'`);
}

function main() {
  const type = process.argv[2];
  const explicitVersion = process.argv[3];

  if (!(type && ["patch", "minor", "major", "set"].includes(type))) {
    throw new Error(
      "Usage: node scripts/version.mjs <patch|minor|major|set> [version]"
    );
  }

  const rootPackage = readRootPackage();
  const currentVersion = rootPackage.version;

  if (typeof currentVersion !== "string") {
    throw new Error("Root package.json version must be a string");
  }

  const nextVersion =
    type === "set" ? explicitVersion : bump(currentVersion, type);

  if (typeof nextVersion !== "string" || !SEMVER_REGEX.test(nextVersion)) {
    throw new Error(`Invalid target version '${nextVersion ?? ""}'`);
  }

  rootPackage.version = nextVersion;
  writeRootPackage(rootPackage);

  execSync("node scripts/sync-versions.mjs", { stdio: "inherit" });
  execSync("pnpm install", { stdio: "inherit" });

  console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);
}

main();
