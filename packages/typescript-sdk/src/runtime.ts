import { StarciteError } from "./errors";
import type {
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
} from "./types";

export function toWebSocketBaseUrl(apiBaseUrl: string): string {
  if (apiBaseUrl.startsWith("https://")) {
    return `wss://${apiBaseUrl.slice("https://".length)}`;
  }

  if (apiBaseUrl.startsWith("http://")) {
    return `ws://${apiBaseUrl.slice("http://".length)}`;
  }

  throw new StarciteError(
    `Invalid Starcite base URL '${apiBaseUrl}'. Use http:// or https://.`
  );
}

export function defaultWebSocketFactory(
  url: string,
  options: StarciteWebSocketConnectOptions = {}
): StarciteWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new StarciteError(
      "WebSocket is not available in this runtime. Provide websocketFactory in StarciteClientOptions."
    );
  }

  const headers = new Headers(options.headers);
  let hasHeaders = false;

  for (const _ of headers.keys()) {
    hasHeaders = true;
    break;
  }

  if (!hasHeaders) {
    return new WebSocket(url);
  }

  const headerObject = Object.fromEntries(headers.entries());

  return Reflect.construct(WebSocket, [
    url,
    { headers: headerObject },
  ]) as StarciteWebSocket;
}

export function defaultFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return fetch(input, init);
}
