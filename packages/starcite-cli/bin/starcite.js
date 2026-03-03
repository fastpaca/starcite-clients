#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);

function detectLinuxLibc() {
  if (process.platform !== "linux") {
    return undefined;
  }

  const report = process.report?.getReport?.();
  const glibcVersion = report?.header?.glibcVersionRuntime;
  return typeof glibcVersion === "string" && glibcVersion.length > 0
    ? "gnu"
    : "musl";
}

function resolveBinaryPackage() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return {
        packageName: "@starcite/cli-darwin-arm64",
        binaryPath: "bin/starcite",
      };
    }

    if (process.arch === "x64") {
      return {
        packageName: "@starcite/cli-darwin-x64",
        binaryPath: "bin/starcite",
      };
    }
  }

  if (process.platform === "linux") {
    const libc = detectLinuxLibc();

    if (process.arch === "x64") {
      return libc === "musl"
        ? {
            packageName: "@starcite/cli-linux-x64-musl",
            binaryPath: "bin/starcite",
          }
        : {
            packageName: "@starcite/cli-linux-x64-gnu",
            binaryPath: "bin/starcite",
          };
    }

    if (process.arch === "arm64") {
      return libc === "musl"
        ? {
            packageName: "@starcite/cli-linux-arm64-musl",
            binaryPath: "bin/starcite",
          }
        : {
            packageName: "@starcite/cli-linux-arm64-gnu",
            binaryPath: "bin/starcite",
          };
    }
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return {
      packageName: "@starcite/cli-win32-x64",
      binaryPath: "bin/starcite.exe",
    };
  }

  return undefined;
}

function resolveBinaryExecutable() {
  const descriptor = resolveBinaryPackage();
  if (!descriptor) {
    return undefined;
  }

  try {
    return require.resolve(`${descriptor.packageName}/${descriptor.binaryPath}`);
  } catch {
    return undefined;
  }
}

function fallbackEntryPath() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "../dist/index.js");
}

function exec(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`Failed to start '${command}': ${String(error)}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

if (process.env.STARCITE_CLI_FORCE_JS === "1") {
  exec(process.execPath, [fallbackEntryPath(), ...argv]);
} else {
  const binary = resolveBinaryExecutable();
  if (binary) {
    exec(binary, argv);
  } else {
    exec(process.execPath, [fallbackEntryPath(), ...argv]);
  }
}
