import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      name: "chromium",
      provider: "playwright",
      headless: true,
      providerOptions: {},
    },
  },
});
