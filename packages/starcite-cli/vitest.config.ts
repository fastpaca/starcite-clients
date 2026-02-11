import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
