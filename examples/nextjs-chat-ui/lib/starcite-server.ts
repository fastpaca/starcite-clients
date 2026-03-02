import { Starcite } from "@starcite/sdk";

export const defaultBaseUrl = "https://anor-ai.starcite.io";

export function getApiKey(): string {
  return process.env.STARCITE_API_KEY ?? process.env.STARCITE_API_TOKEN ?? "";
}

export function getBaseUrl(): string {
  return process.env.STARCITE_BASE_URL || defaultBaseUrl;
}

let serverStarcite: Starcite | undefined;

export function getServerStarcite(): Starcite {
  if (!serverStarcite) {
    serverStarcite = new Starcite({
      apiKey: getApiKey(),
      baseUrl: getBaseUrl(),
    });
  }

  return serverStarcite;
}
