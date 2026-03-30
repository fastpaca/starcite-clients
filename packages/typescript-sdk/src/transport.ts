import type { z } from "zod";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import type { SocketManager } from "./socket-manager";

const TRAILING_SLASHES_RE = /\/+$/;

/**
 * Shared HTTP + WebSocket transport configuration.
 *
 * Both `Starcite` (API-key auth) and `StarciteSession` (session-token auth)
 * hold their own `TransportConfig` and pass it to the free functions below.
 */
export interface TransportConfig {
  readonly baseUrl: string;
  readonly socketManager: SocketManager;
  bearerToken: string | null;
  readonly fetchFn: typeof fetch;
}

/**
 * Validates a URL has an http/https protocol, strips trailing slashes, and returns the URL object.
 */
export function parseHttpUrl(value: string): URL {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StarciteError(`URL must use http:// or https://: ${value}`);
  }

  url.pathname = url.pathname.replace(TRAILING_SLASHES_RE, "");
  return url;
}

/**
 * Converts a Starcite base URL to the `/v1` API root used by this SDK.
 */
export function toApiBaseUrl(baseUrl: string): string {
  const value = stripTrailingSlashes(parseHttpUrl(baseUrl).toString());
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

/**
 * Converts HTTP API base URL to its websocket equivalent.
 */
export function toWebSocketBaseUrl(apiBaseUrl: string): string {
  const url = parseHttpUrl(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return stripTrailingSlashes(url.toString());
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(TRAILING_SLASHES_RE, "");
}

/**
 * Makes an HTTP request against the transport's base URL.
 */
export function request<T>(
  transport: TransportConfig,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  return requestWithBaseUrl(transport, transport.baseUrl, path, init, schema);
}

/**
 * Makes an HTTP request against an arbitrary base URL using the transport's shared config.
 */
export async function requestWithBaseUrl<T>(
  transport: TransportConfig,
  baseUrl: string,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  const headers = new Headers();

  if (transport.bearerToken) {
    headers.set("authorization", `Bearer ${transport.bearerToken}`);
  }

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  if (init.headers) {
    const perRequestHeaders = new Headers(init.headers);
    for (const [key, value] of perRequestHeaders.entries()) {
      headers.set(key, value);
    }
  }

  let response: Response;

  try {
    response = await transport.fetchFn(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    throw new StarciteConnectionError(
      `Failed to connect to Starcite at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error response — fall through with null payload.
    }

    const code =
      typeof payload?.error === "string"
        ? payload.error
        : `http_${response.status}`;
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : response.statusText;

    throw new StarciteApiError(message, response.status, code, payload);
  }

  if (response.status === 204) {
    return schema.parse(undefined);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new StarciteConnectionError(
      `Received invalid JSON from Starcite: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return schema.parse(body);
}
