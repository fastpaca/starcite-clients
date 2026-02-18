import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const proxyTarget =
  process.env.STARCITE_PROXY_TARGET ?? "http://localhost:45187";
const proxyApiKey = process.env.STARCITE_PROXY_API_KEY?.trim();

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
    proxy: {
      "/v1": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
        headers: proxyApiKey
          ? {
              authorization: `Bearer ${proxyApiKey}`,
            }
          : undefined,
      },
    },
  },
});
