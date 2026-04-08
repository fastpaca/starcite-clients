import { describe, expect, it } from "vitest";
import { getStarciteConfig } from "../src/config";

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
      publicBaseUrl: "https://tenant-a.starcite.io",
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
      publicBaseUrl: "https://tenant-a.starcite.io/v1",
    });
  });

  it("prefers public env vars for browser-facing base URLs", () => {
    expect(
      getStarciteConfig({
        NEXT_PUBLIC_STARCITE_BASE_URL: "https://public.starcite.io",
        STARCITE_BASE_URL: "https://server.starcite.io",
      }).publicBaseUrl
    ).toBe("https://public.starcite.io");

    expect(
      getStarciteConfig({
        VITE_STARCITE_API_URL: "https://vite.starcite.io/v1",
        STARCITE_API_URL: "https://server.starcite.io/v1",
      }).publicBaseUrl
    ).toBe("https://vite.starcite.io/v1");
  });
});
