import { getStarciteConfig, Starcite } from "@starcite/sdk";

const config = getStarciteConfig();

/** One client for the whole server: lifecycle listeners and session mint must share this. */
export const starcite = new Starcite({
  apiKey: config.apiKey!,
  baseUrl: config.baseUrl ?? "https://api.starcite.io",
});
