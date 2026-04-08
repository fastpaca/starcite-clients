const DEFAULT_STARCITE_BASE_URL = "http://localhost:4000";

export interface StarciteConfig {
  readonly apiKey?: string;
  readonly authUrl?: string;
  readonly baseUrl?: string;
}

interface StarciteEnvSource {
  readonly [key: string]: string | undefined;
  readonly NEXT_PUBLIC_STARCITE_API_URL?: string;
  readonly NEXT_PUBLIC_STARCITE_BASE_URL?: string;
  readonly STARCITE_API_KEY?: string;
  readonly STARCITE_API_URL?: string;
  readonly STARCITE_AUTH_URL?: string;
  readonly STARCITE_BASE_URL?: string;
  readonly VITE_STARCITE_API_URL?: string;
  readonly VITE_STARCITE_BASE_URL?: string;
}

function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function firstEnvValue(
  ...values: readonly (string | undefined)[]
): string | undefined {
  for (const value of values) {
    const trimmed = trimEnvValue(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function readProcessEnv(): StarciteEnvSource | undefined {
  if (typeof process !== "undefined") {
    return process.env as StarciteEnvSource;
  }

  return globalThis.process?.env as StarciteEnvSource | undefined;
}

export function getStarciteConfig(
  env: StarciteEnvSource | undefined = readProcessEnv()
): StarciteConfig {
  return {
    apiKey: firstEnvValue(env?.STARCITE_API_KEY),
    authUrl: firstEnvValue(env?.STARCITE_AUTH_URL),
    baseUrl: firstEnvValue(
      env?.STARCITE_BASE_URL,
      env?.STARCITE_API_URL,
      env?.NEXT_PUBLIC_STARCITE_BASE_URL,
      env?.NEXT_PUBLIC_STARCITE_API_URL,
      env?.VITE_STARCITE_BASE_URL,
      env?.VITE_STARCITE_API_URL
    ),
  };
}

export function resolveStarciteConfig(
  input: StarciteConfig = {},
  env: StarciteEnvSource | undefined = readProcessEnv()
): StarciteConfig & { readonly baseUrl: string } {
  const envConfig = getStarciteConfig(env);

  return {
    apiKey: trimEnvValue(input.apiKey) ?? envConfig.apiKey,
    authUrl: trimEnvValue(input.authUrl) ?? envConfig.authUrl,
    baseUrl:
      trimEnvValue(input.baseUrl) ??
      envConfig.baseUrl ??
      DEFAULT_STARCITE_BASE_URL,
  };
}
