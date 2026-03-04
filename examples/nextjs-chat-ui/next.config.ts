import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@starcite/react": path.resolve(
        __dirname,
        "../../packages/starcite-react/src/index.ts"
      ),
      "@starcite/react/chat-protocol": path.resolve(
        __dirname,
        "../../packages/starcite-react/src/chat-protocol.ts"
      ),
      "@starcite/sdk": path.resolve(
        __dirname,
        "../../packages/typescript-sdk/src/index.ts"
      ),
    };

    return config;
  },
};

export default nextConfig;
