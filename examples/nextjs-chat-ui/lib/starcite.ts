import { Starcite } from "@starcite/sdk";

/** One client for the whole server: lifecycle listeners and session mint must share this. */
export const starcite = new Starcite({
  apiKey: process.env.STARCITE_API_KEY!,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io",
});
