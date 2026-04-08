import { Starcite } from "@starcite/sdk";

/** One server-side client for lifecycle listeners and session minting. */
export const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl:
    process.env.STARCITE_BASE_URL ??
    process.env.STARCITE_API_URL ??
    "https://api.starcite.io",
});
