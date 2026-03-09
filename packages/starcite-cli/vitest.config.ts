import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@starcite/sdk": resolve(
        currentDirectory,
        "../typescript-sdk/src/index.ts"
      ),
    },
  },
  test: {
    environment: "node",
  },
});
