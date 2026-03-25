import path from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import type { NextConfig } from "next";

export default function nextConfig(phase: string): NextConfig {
  return {
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
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
}
