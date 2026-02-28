import type { z } from "zod";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import { errorMessage } from "./internal/primitives";
import type {
  StarciteWebSocket,
  StarciteWebSocketAuthTransport,
  StarciteWebSocketConnectOptions,
} from "./types";

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
  readonly websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;
  readonly websocketAuthTransport: "header" | "access_token";
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
  return parsed.toString().replace(/\/+$/, "");
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
  return url.toString().replace(/\/+$/, "");
}

/**
 * Chooses websocket auth transport mode.
 */
export function resolveWebSocketAuthTransport(
  requested: StarciteWebSocketAuthTransport | undefined,
  hasCustomFactory: boolean
): "header" | "access_token" {
  if (requested === "header" || requested === "access_token") {
    return requested;
  }

  return hasCustomFactory ? "header" : "access_token";
}

/**
 * Default websocket connector used when no custom factory is provided.
 */
export function defaultWebSocketFactory(
  url: string,
  options: StarciteWebSocketConnectOptions = {}
): StarciteWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new StarciteError(
      "WebSocket is not available in this runtime. Provide websocketFactory in StarciteOptions."
    );
  }

  const headers = new Headers(options.headers);
  const headerObject = Object.fromEntries(headers.entries());

  if (Object.keys(headerObject).length === 0) {
    return new WebSocket(url);
  }

  // Reflect.construct bypasses the DOM `WebSocket(url, protocols?)` type
  // signature so we can pass the `{ headers }` options bag accepted by
  // Node.js and some edge runtimes.
  return Reflect.construct(WebSocket, [
    url,
    { headers: headerObject },
  ]) as StarciteWebSocket;
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
      `Failed to connect to Starcite at ${baseUrl}: ${errorMessage(error)}`
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
      `Received invalid JSON from Starcite: ${errorMessage(error)}`
    );
  }

  return schema.parse(body);
}

/**
 * Flattens batched iterables into item-by-item iteration.
 */
export async function* flattenBatches<T>(
  source: AsyncIterable<T[]>
): AsyncGenerator<T> {
  for await (const batch of source) {
    for (const item of batch) {
      yield item;
    }
  }
}
