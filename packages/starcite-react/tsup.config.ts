import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/chat-protocol.ts"],
  clean: true,
  dts: true,
  format: ["esm", "cjs"],
  target: "es2022",
  sourcemap: true,
});
