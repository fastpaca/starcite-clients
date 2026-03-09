import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  serverExternalPackages: ["better-sqlite3"],
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@starcite/sdk": path.resolve(
        __dirname,
        "../../packages/typescript-sdk/src/index.ts"
      ),
    };

    // Prevent SQLite cursor writes from triggering HMR
    if (!isServer) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ["**/.data/**", "**/node_modules/**"],
      };
    }

    return config;
  },
};

export default nextConfig;
