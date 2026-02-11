#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeTagToVersion(tag) {
  if (!tag || typeof tag !== "string") {
    throw new Error("Release tag is required (for example: v0.1.0)");
  }

  const version = tag.startsWith("v") ? tag.slice(1) : tag;

  if (!SEMVER_REGEX.test(version)) {
    throw new Error(
      `Release tag '${tag}' is invalid. Expected format 'vX.Y.Z' or 'X.Y.Z'.`
    );
  }

  return version;
}

function getWorkspacePackagePaths(rootDir) {
  const packagesDir = join(rootDir, "packages");
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return dirs
    .map((name) => join(packagesDir, name, "package.json"))
    .filter((path) => existsSync(path));
}

function main() {
  const tagFromArgs = process.argv[2];
  const tag =
    tagFromArgs || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
  const expectedVersion = normalizeTagToVersion(tag);

  const rootDir = process.cwd();
  const rootPackage = readJson(join(rootDir, "package.json"));
  const packagePaths = getWorkspacePackagePaths(rootDir);

  const mismatches = [];

  if (rootPackage.version !== expectedVersion) {
    mismatches.push(
      `root package.json version ${rootPackage.version} does not match ${expectedVersion}`
    );
  }

  for (const packagePath of packagePaths) {
    const pkg = readJson(packagePath);

    if (pkg.private === true) {
      continue;
    }

    if (pkg.version !== expectedVersion) {
      mismatches.push(
        `${pkg.name} version ${pkg.version} does not match ${expectedVersion}`
      );
    }
  }

  if (mismatches.length > 0) {
    console.error(`Version check failed for release tag '${tag}':`);

    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }

    process.exit(1);
  }

  console.log(
    `Release tag '${tag}' matches root and workspace package versions (${expectedVersion}).`
  );
}

main();
