import { getStarciteConfig, Starcite } from "@starcite/sdk";

const config = getStarciteConfig();

/** One server-side client for lifecycle listeners and session minting. */
export const starcite = new Starcite({
  apiKey: config.apiKey!,
  baseUrl: config.baseUrl ?? "https://api.starcite.io",
});
