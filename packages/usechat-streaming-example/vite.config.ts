import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@starcite/sdk": fileURLToPath(
        new URL("../typescript-sdk/src/index.ts", import.meta.url)
      ),
      "@starcite/ai-sdk-transport": fileURLToPath(
        new URL("../ai-sdk-transport/src/index.ts", import.meta.url)
      ),
    },
  },
  server: {
    port: 4176,
  },
});
