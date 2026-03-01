import type { z } from "zod";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import type { StarciteWebSocket } from "./types";

const TRAILING_SLASHES_REGEX = /\/+$/;

/**
 * Shared HTTP + WebSocket transport configuration.
 *
 * Both `Starcite` (API-key auth) and `StarciteSession` (session-token auth)
 * hold their own `TransportConfig` and pass it to the free functions below.
 */
export interface TransportConfig {
  readonly baseUrl: string;
  readonly websocketBaseUrl: string;
  readonly authorization: string | null;
  readonly fetchFn: typeof fetch;
  readonly headers: Headers;
  readonly websocketFactory: (url: string) => StarciteWebSocket;
}

/**
 * Validates and normalizes an absolute HTTP URL used for SDK endpoints.
 */
export function normalizeAbsoluteHttpUrl(
  value: string,
  context: string
): string {
  const parsed = new URL(value);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new StarciteError(`${context} must use http:// or https://`);
  }

  // Strip trailing slashes for consistent path joining.
  return parsed.toString().replace(TRAILING_SLASHES_REGEX, "");
}

/**
 * Converts a Starcite base URL to the `/v1` API root used by this SDK.
 */
export function toApiBaseUrl(baseUrl: string): string {
  const normalized = normalizeAbsoluteHttpUrl(baseUrl, "baseUrl");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

/**
 * Converts HTTP API base URL to its websocket equivalent.
 */
export function toWebSocketBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(TRAILING_SLASHES_REGEX, "");
}

/**
 * Default websocket connector used when no custom factory is provided.
 */
export function defaultWebSocketFactory(url: string): StarciteWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new StarciteError(
      "WebSocket is not available in this runtime. Provide websocketFactory in StarciteOptions."
    );
  }

  return new WebSocket(url);
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
  const headers = new Headers(transport.headers);

  if (transport.authorization) {
    headers.set("authorization", transport.authorization);
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
