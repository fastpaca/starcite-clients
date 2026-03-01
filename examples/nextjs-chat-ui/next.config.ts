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
      "@starcite/ai-sdk-transport": path.resolve(
        __dirname,
        "../../packages/ai-sdk-transport/src/index.ts"
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
