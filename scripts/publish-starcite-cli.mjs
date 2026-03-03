#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const rootDir = process.cwd();
const cliPackageDir = join(rootDir, "packages", "starcite-cli");
const sdkPackageDir = join(rootDir, "packages", "typescript-sdk");
const aiSdkTransportPackageDir = join(rootDir, "packages", "ai-sdk-transport");

const binaryTargets = [
  {
    packageName: "@starcite/cli-darwin-arm64",
    packageDir: join(rootDir, "packages", "starcite-cli-darwin-arm64"),
    bunTarget: "bun-darwin-arm64",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-darwin-x64",
    packageDir: join(rootDir, "packages", "starcite-cli-darwin-x64"),
    bunTarget: "bun-darwin-x64",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-linux-x64-gnu",
    packageDir: join(rootDir, "packages", "starcite-cli-linux-x64-gnu"),
    bunTarget: "bun-linux-x64-baseline",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-linux-x64-musl",
    packageDir: join(rootDir, "packages", "starcite-cli-linux-x64-musl"),
    bunTarget: "bun-linux-x64-musl",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-linux-arm64-gnu",
    packageDir: join(rootDir, "packages", "starcite-cli-linux-arm64-gnu"),
    bunTarget: "bun-linux-arm64",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-linux-arm64-musl",
    packageDir: join(rootDir, "packages", "starcite-cli-linux-arm64-musl"),
    bunTarget: "bun-linux-arm64-musl",
    outputFile: "bin/starcite",
  },
  {
    packageName: "@starcite/cli-win32-x64",
    packageDir: join(rootDir, "packages", "starcite-cli-win32-x64"),
    bunTarget: "bun-windows-x64-baseline",
    outputFile: "bin/starcite.exe",
  },
];

const validBumpKinds = new Set(["patch", "minor", "major"]);

function run(command, options = {}) {
  console.log(`$ ${command}`);
  execSync(command, {
    stdio: "inherit",
    ...options,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseValueArg(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseVersionArg(argv, args, arg, index) {
  if (arg === "--bump") {
    const value = parseValueArg(argv, index, "--bump");

    if (!validBumpKinds.has(value)) {
      throw new Error("--bump must be patch, minor, or major");
    }

    args.bumpKind = value;
    return index + 1;
  }

  if (arg === "--set-version") {
    args.setVersion = parseValueArg(argv, index, "--set-version");
    return index + 1;
  }

  return index;
}

function parseArgs(argv) {
  const args = {
    bumpKind: undefined,
    setVersion: undefined,
    dryRun: false,
    skipChecks: false,
    skipPublish: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--skip-checks") {
      args.skipChecks = true;
      continue;
    }

    if (arg === "--skip-publish") {
      args.skipPublish = true;
      continue;
    }

    const nextIndex = parseVersionArg(argv, args, arg, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }

    throw new Error(
      `Unknown argument '${arg}'. Supported args: --bump, --set-version, --dry-run, --skip-checks, --skip-publish`
    );
  }

  if (args.bumpKind && args.setVersion) {
    throw new Error("Use either --bump or --set-version, not both");
  }

  return args;
}

function assertVersionConsistency() {
  const rootVersion = readJson(join(rootDir, "package.json")).version;
  const sdkManifest = readJson(join(sdkPackageDir, "package.json"));
  const aiSdkTransportManifest = readJson(
    join(aiSdkTransportPackageDir, "package.json")
  );
  const starciteManifest = readJson(join(cliPackageDir, "package.json"));

  if (sdkManifest.version !== rootVersion) {
    throw new Error(
      `Version mismatch: root=${rootVersion} @starcite/sdk=${sdkManifest.version}`
    );
  }

  if (aiSdkTransportManifest.version !== rootVersion) {
    throw new Error(
      `Version mismatch: root=${rootVersion} @starcite/ai-sdk-transport=${aiSdkTransportManifest.version}`
    );
  }

  if (starciteManifest.version !== rootVersion) {
    throw new Error(
      `Version mismatch: root=${rootVersion} starcite=${starciteManifest.version}`
    );
  }

  for (const target of binaryTargets) {
    const manifest = readJson(join(target.packageDir, "package.json"));
    if (manifest.version !== rootVersion) {
      throw new Error(
        `Version mismatch: ${target.packageName}=${manifest.version} root=${rootVersion}`
      );
    }
  }
}

function ensureOptionalDependencyCoverage() {
  const manifest = readJson(join(cliPackageDir, "package.json"));
  const optionalDeps = manifest.optionalDependencies ?? {};
  const sdkDependency = manifest.dependencies?.["@starcite/sdk"];

  if (typeof sdkDependency !== "string") {
    throw new Error(
      "packages/starcite-cli/package.json is missing dependency '@starcite/sdk'"
    );
  }

  for (const target of binaryTargets) {
    if (!(target.packageName in optionalDeps)) {
      throw new Error(
        `packages/starcite-cli/package.json is missing optional dependency '${target.packageName}'`
      );
    }
  }
}

function compileBinaries() {
  for (const target of binaryTargets) {
    const outputPath = join(target.packageDir, target.outputFile);
    mkdirSync(dirname(outputPath), { recursive: true });

    run(
      `bun build --compile --minify --target=${target.bunTarget} src/index.ts --outfile ${JSON.stringify(outputPath)}`,
      { cwd: cliPackageDir }
    );

    if (!outputPath.endsWith(".exe")) {
      chmodSync(outputPath, 0o755);
    }
  }
}

function publishPackage(directory, dryRun) {
  const dryFlag = dryRun ? " --dry-run" : "";
  run(`bun publish --access public${dryFlag}`, { cwd: directory });
}

function runVersionBump(args) {
  if (args.bumpKind) {
    run(`bun run version:${args.bumpKind}`, { cwd: rootDir });
    return;
  }

  if (args.setVersion) {
    run(`bun run version:set ${args.setVersion}`, { cwd: rootDir });
  }
}

function runChecks(args) {
  if (args.skipChecks) {
    return;
  }

  run("bun run --cwd packages/typescript-sdk check", { cwd: rootDir });
  run("bun run --cwd packages/ai-sdk-transport check", { cwd: rootDir });
  run("bun run --cwd packages/starcite-cli check", { cwd: rootDir });
}

function buildReleaseArtifacts() {
  run("bun run --cwd packages/typescript-sdk build", { cwd: rootDir });
  run("bun run --cwd packages/ai-sdk-transport build", { cwd: rootDir });
  run("bun run --cwd packages/starcite-cli build", { cwd: rootDir });
  compileBinaries();
}

function publishRelease(args) {
  if (args.skipPublish) {
    console.log("Skipping publish because --skip-publish is set.");
    return;
  }

  publishPackage(sdkPackageDir, args.dryRun);
  publishPackage(aiSdkTransportPackageDir, args.dryRun);

  for (const target of binaryTargets) {
    publishPackage(target.packageDir, args.dryRun);
  }

  publishPackage(cliPackageDir, args.dryRun);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  runVersionBump(args);
  assertVersionConsistency();
  ensureOptionalDependencyCoverage();
  runChecks(args);
  buildReleaseArtifacts();
  publishRelease(args);
}

main();
