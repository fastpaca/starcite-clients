import { describe, expect, it } from "vitest";
import { getStarciteConfig, resolveStarciteConfig } from "../src/config";

describe("getStarciteConfig", () => {
  it("reads canonical server env vars", () => {
    expect(
      getStarciteConfig({
        STARCITE_API_KEY: "service-token",
        STARCITE_AUTH_URL: "https://auth.starcite.io",
        STARCITE_BASE_URL: "https://tenant-a.starcite.io",
      })
    ).toEqual({
      apiKey: "service-token",
      authUrl: "https://auth.starcite.io",
      baseUrl: "https://tenant-a.starcite.io",
    });
  });

  it("falls back to API URL aliases and trims whitespace", () => {
    expect(
      getStarciteConfig({
        STARCITE_API_KEY: "  service-token  ",
        STARCITE_AUTH_URL: "  https://auth.starcite.io  ",
        STARCITE_API_URL: "  https://tenant-a.starcite.io/v1  ",
      })
    ).toEqual({
      apiKey: "service-token",
      authUrl: "https://auth.starcite.io",
      baseUrl: "https://tenant-a.starcite.io/v1",
    });
  });

  it("falls back to public env vars for base URL resolution", () => {
    expect(
      getStarciteConfig({
        NEXT_PUBLIC_STARCITE_BASE_URL: "https://public.starcite.io",
        STARCITE_BASE_URL: "https://server.starcite.io",
      }).baseUrl
    ).toBe("https://server.starcite.io");

    expect(
      getStarciteConfig({
        VITE_STARCITE_API_URL: "https://vite.starcite.io/v1",
      }).baseUrl
    ).toBe("https://vite.starcite.io/v1");
  });
});

describe("resolveStarciteConfig", () => {
  it("fills in the default base URL", () => {
    expect(resolveStarciteConfig({})).toEqual({
      apiKey: undefined,
      authUrl: undefined,
      baseUrl: "http://localhost:4000",
    });
  });
});
