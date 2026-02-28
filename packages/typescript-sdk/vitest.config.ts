import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/browser/**/*.browser.test.ts"],
  },
});
