#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const rootPackageJsonPath = join(rootDir, "package.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function getWorkspacePackages() {
  const packagesDir = join(rootDir, "packages");
  const dirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return dirs
    .map((name) => join(packagesDir, name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, pkg: readJson(path) }));
}

function syncInternalDeps(pkg, dependencyNames, version) {
  let updates = 0;
  const fields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  for (const field of fields) {
    const deps = pkg[field];

    if (!deps) {
      continue;
    }

    for (const depName of Object.keys(deps)) {
      if (!dependencyNames.has(depName)) {
        continue;
      }

      const desired = `workspace:^${version}`;
      if (deps[depName] !== desired) {
        deps[depName] = desired;
        updates += 1;
      }
    }
  }

  return updates;
}

function main() {
  const rootPkg = readJson(rootPackageJsonPath);

  if (!rootPkg.version || typeof rootPkg.version !== "string") {
    throw new Error("Root package.json must define a string version");
  }

  const workspacePackages = getWorkspacePackages();
  const workspaceNames = new Set(workspacePackages.map(({ pkg }) => pkg.name));

  let versionUpdates = 0;
  let dependencyUpdates = 0;

  for (const entry of workspacePackages) {
    if (entry.pkg.version !== rootPkg.version) {
      entry.pkg.version = rootPkg.version;
      versionUpdates += 1;
    }

    dependencyUpdates += syncInternalDeps(
      entry.pkg,
      workspaceNames,
      rootPkg.version
    );

    writeJson(entry.path, entry.pkg);
  }

  writeJson(rootPackageJsonPath, rootPkg);

  console.log(
    `Synchronized versions to ${rootPkg.version} across ${workspacePackages.length} packages`
  );
  console.log(
    `Updated ${versionUpdates} package version fields and ${dependencyUpdates} internal dependency ranges`
  );
}

main();
