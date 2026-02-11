import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  target: "es2022",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
