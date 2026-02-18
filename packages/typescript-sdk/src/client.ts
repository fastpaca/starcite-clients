import { z } from "zod";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import type {
  AppendEventRequest,
  AppendEventResponse,
  CreateSessionInput,
  SessionAppendInput,
  SessionCreatorPrincipal,
  SessionEvent,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
  StarciteWebSocketConnectOptions,
  TailEvent,
} from "./types";
import {
  AppendEventRequestSchema,
  AppendEventResponseSchema,
  CreateSessionInputSchema,
  SessionAppendInputSchema,
  SessionCreatorPrincipalSchema,
  SessionListPageSchema,
  SessionRecordSchema,
  StarciteErrorPayloadSchema,
  TailEventSchema,
} from "./types";

const DEFAULT_BASE_URL =
  typeof process !== "undefined" && process.env.STARCITE_BASE_URL
    ? process.env.STARCITE_BASE_URL
    : "http://localhost:4000";
const TRAILING_SLASHES_REGEX = /\/+$/;
const BEARER_PREFIX_REGEX = /^bearer\s+/i;
const DEFAULT_TAIL_RECONNECT_DELAY_MS = 3000;
const NORMAL_WEBSOCKET_CLOSE_CODE = 1000;
const SERVICE_TOKEN_SUB_ORG_PREFIX = "org:";
const SERVICE_TOKEN_SUB_AGENT_PREFIX = "agent:";
const SERVICE_TOKEN_SUB_USER_PREFIX = "user:";

const TailFrameSchema = z
  .string()
  .transform((frame, context): unknown => {
    try {
      return JSON.parse(frame) as unknown;
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tail frame was not valid JSON",
      });
      return z.NEVER;
    }
  })
  .pipe(TailEventSchema);

class AsyncQueue<T> {
  private readonly items: Array<
    | { type: "value"; value: T }
    | { type: "done" }
    | { type: "error"; error: Error }
  > = [];
  private readonly waiters: Array<
    (
      item:
        | { type: "value"; value: T }
        | { type: "done" }
        | { type: "error"; error: Error }
    ) => void
  > = [];
  private settled = false;

  push(value: T): void {
    if (this.settled) {
      return;
    }

    this.enqueue({ type: "value", value });
  }

  close(): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.enqueue({ type: "done" });
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.enqueue({ type: "error", error: toError(error) });
  }

  async next(): Promise<IteratorResult<T>> {
    const item =
      this.items.shift() ??
      (await new Promise<(typeof this.items)[number]>((resolve) => {
        this.waiters.push(resolve);
      }));

    if (item.type === "value") {
      return { value: item.value, done: false };
    }

    if (item.type === "done") {
      return { value: undefined, done: true };
    }

    throw item.error;
  }

  private enqueue(item: (typeof this.items)[number]): void {
    const waiter = this.waiters.shift();

    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
  }
}

/**
 * Normalizes a Starcite base URL to the `/v1` API root used by this SDK.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(TRAILING_SLASHES_REGEX, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toWebSocketBaseUrl(apiBaseUrl: string): string {
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

function defaultWebSocketFactory(
  url: string,
  options: StarciteWebSocketConnectOptions = {}
): StarciteWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new StarciteError(
      "WebSocket is not available in this runtime. Provide websocketFactory in StarciteClientOptions."
    );
  }

  const headers = new Headers(options.headers);

  if (!hasAnyHeaders(headers)) {
    return new WebSocket(url) as unknown as StarciteWebSocket;
  }

  const headerObject = Object.fromEntries(headers.entries());

  try {
    return new (
      WebSocket as unknown as {
        new (
          websocketUrl: string,
          options: { headers: Record<string, string> }
        ): StarciteWebSocket;
      }
    )(url, { headers: headerObject });
  } catch {
    throw new StarciteError(
      "This runtime cannot set WebSocket upgrade headers with the default factory. Provide websocketFactory in StarciteClientOptions."
    );
  }
}

function defaultFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (typeof fetch === "undefined") {
    throw new StarciteError(
      "fetch is not available in this runtime. Provide fetch in StarciteClientOptions."
    );
  }

  return fetch(input, init);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function hasAnyHeaders(headers: Headers): boolean {
  for (const _ of headers.keys()) {
    return true;
  }

  return false;
}

function formatAuthorizationHeader(apiKey: string): string {
  const normalized = apiKey.trim();

  if (normalized.length === 0) {
    throw new StarciteError("apiKey cannot be empty");
  }

  if (BEARER_PREFIX_REGEX.test(normalized)) {
    return normalized;
  }

  return `Bearer ${normalized}`;
}

function firstNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseJwtSegment(segment: string): string | undefined {
  const base64 = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");

  try {
    if (typeof atob === "function") {
      return atob(base64);
    }

    if (typeof Buffer !== "undefined") {
      return Buffer.from(base64, "base64").toString("utf8");
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseJwtClaims(apiKey: string): Record<string, unknown> | undefined {
  const token = apiKey.replace(BEARER_PREFIX_REGEX, "").trim();
  const parts = token.split(".");

  if (parts.length !== 3) {
    return undefined;
  }

  const [, payloadSegment] = parts;

  if (payloadSegment === undefined) {
    return undefined;
  }

  const payload = parseJwtSegment(payloadSegment);

  if (payload === undefined) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(payload) as unknown;
    return decoded !== null && typeof decoded === "object"
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseClaimStrings(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = firstNonEmptyString(source[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function parseActorIdentityFromSubject(
  subject: string
): { id: string; type: "agent" | "user" } | undefined {
  if (subject.startsWith(SERVICE_TOKEN_SUB_AGENT_PREFIX)) {
    return { id: subject, type: "agent" };
  }

  if (subject.startsWith(SERVICE_TOKEN_SUB_USER_PREFIX)) {
    return { id: subject, type: "user" };
  }

  return undefined;
}

function parseTenantIdFromSubject(subject: string): string {
  const actorIdentity = parseActorIdentityFromSubject(subject);
  if (actorIdentity !== undefined) {
    return "";
  }

  if (subject.startsWith(SERVICE_TOKEN_SUB_ORG_PREFIX)) {
    return subject.slice(SERVICE_TOKEN_SUB_ORG_PREFIX.length).trim();
  }

  return subject;
}

function parseCreatorPrincipalFromClaims(
  claims: Record<string, unknown>
): SessionCreatorPrincipal | undefined {
  const subject = firstNonEmptyString(claims.sub);
  const explicitPrincipal =
    claims.principal && typeof claims.principal === "object"
      ? (claims.principal as Record<string, unknown>)
      : undefined;
  const mergedClaims = explicitPrincipal
    ? { ...claims, ...explicitPrincipal }
    : claims;
  const actorFromSubject = subject
    ? parseActorIdentityFromSubject(subject)
    : undefined;
  const principalTypeFromClaims = parseClaimStrings(mergedClaims, [
    "principal_type",
    "principalType",
    "type",
  ]);
  const tenantId = parseClaimStrings(mergedClaims, ["tenant_id", "tenantId"]);
  const rawPrincipalId = parseClaimStrings(mergedClaims, [
    "principal_id",
    "principalId",
    "id",
    "sub",
  ]);
  const actorFromRawId = rawPrincipalId
    ? parseActorIdentityFromSubject(rawPrincipalId)
    : undefined;

  const principal = {
    tenant_id: tenantId ?? (subject ? parseTenantIdFromSubject(subject) : ""),
    id: rawPrincipalId ?? actorFromSubject?.id ?? "",
    type:
      principalTypeFromClaims === "agent" || principalTypeFromClaims === "user"
        ? principalTypeFromClaims
        : (actorFromSubject?.type ?? actorFromRawId?.type ?? "user"),
  };

  if (
    principal.tenant_id.length === 0 ||
    principal.id.length === 0 ||
    principal.type.length === 0
  ) {
    return undefined;
  }

  const result = SessionCreatorPrincipalSchema.safeParse(principal);

  return result.success ? result.data : undefined;
}

function parseCreatorPrincipalFromClaimsSafe(
  apiKey: string
): SessionCreatorPrincipal | undefined {
  const claims = parseJwtClaims(apiKey);
  return claims ? parseCreatorPrincipalFromClaims(claims) : undefined;
}

function parseEventFrame(data: unknown): TailEvent {
  const result = TailFrameSchema.safeParse(data);

  if (!result.success) {
    const reason =
      result.error.issues[0]?.message ?? "Tail frame did not match schema";
    throw new StarciteConnectionError(reason);
  }

  return result.data;
}

function getEventData(event: unknown): unknown {
  if (event && typeof event === "object" && "data" in event) {
    return (event as { data?: unknown }).data;
  }

  return undefined;
}

function getCloseCode(event: unknown): number | undefined {
  if (event && typeof event === "object" && "code" in event) {
    const code = (event as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }

  return undefined;
}

function getCloseReason(event: unknown): string | undefined {
  if (event && typeof event === "object" && "reason" in event) {
    const reason = (event as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.length > 0 ? reason : undefined;
  }

  return undefined;
}

function describeClose(
  code: number | undefined,
  reason: string | undefined
): string {
  const codeText = `code ${typeof code === "number" ? code : "unknown"}`;
  return reason ? `${codeText}, reason '${reason}'` : codeText;
}

async function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function agentFromActor(actor: string): string | undefined {
  if (actor.startsWith("agent:")) {
    return actor.slice("agent:".length);
  }

  return undefined;
}

function toSessionEvent(event: TailEvent): SessionEvent {
  const agent = agentFromActor(event.actor);
  const text =
    typeof event.payload.text === "string" ? event.payload.text : undefined;

  return {
    ...event,
    agent,
    text,
  };
}

/**
 * Session-scoped helper for append and tail operations.
 */
export class StarciteSession {
  /** Session identifier. */
  readonly id: string;
  /** Optional session record captured at creation time. */
  readonly record?: SessionRecord;

  private readonly client: StarciteClient;

  constructor(client: StarciteClient, id: string, record?: SessionRecord) {
    this.client = client;
    this.id = id;
    this.record = record;
  }

  /**
   * Appends a high-level agent event to this session.
   *
   * Automatically prefixes `agent` as `agent:<name>` when needed.
   */
  append(input: SessionAppendInput): Promise<AppendEventResponse> {
    const parsed = SessionAppendInputSchema.parse(input);
    const actor = parsed.agent.startsWith("agent:")
      ? parsed.agent
      : `agent:${parsed.agent}`;

    return this.client.appendEvent(this.id, {
      type: parsed.type ?? "content",
      payload: parsed.payload ?? { text: parsed.text },
      actor,
      producer_id: parsed.producerId,
      producer_seq: parsed.producerSeq,
      source: parsed.source ?? "agent",
      metadata: parsed.metadata,
      refs: parsed.refs,
      idempotency_key: parsed.idempotencyKey,
      expected_seq: parsed.expectedSeq,
    });
  }

  /**
   * Appends a raw event payload as-is.
   */
  appendRaw(input: AppendEventRequest): Promise<AppendEventResponse> {
    return this.client.appendEvent(this.id, input);
  }

  /**
   * Streams transformed session events with SDK convenience fields (`agent`, `text`).
   */
  tail(options: SessionTailOptions = {}): AsyncIterable<SessionEvent> {
    return this.client.tailEvents(this.id, options);
  }

  /**
   * Streams raw tail events returned by the API.
   */
  tailRaw(options: SessionTailOptions = {}): AsyncIterable<TailEvent> {
    return this.client.tailRawEvents(this.id, options);
  }
}

/**
 * Starcite API client for HTTP and WebSocket session operations.
 */
export class StarciteClient {
  /** Normalized API base URL ending with `/v1`. */
  readonly baseUrl: string;

  private readonly inferredCreatorPrincipal?: SessionCreatorPrincipal;
  private readonly websocketBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Headers;
  private readonly websocketFactory: (
    url: string,
    options?: StarciteWebSocketConnectOptions
  ) => StarciteWebSocket;

  /**
   * Creates a new client instance.
   */
  constructor(options: StarciteClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.websocketBaseUrl = toWebSocketBaseUrl(this.baseUrl);
    this.fetchFn = options.fetch ?? defaultFetch;
    this.headers = new Headers(options.headers);

    if (options.apiKey !== undefined) {
      const authorization = formatAuthorizationHeader(options.apiKey);
      this.headers.set("authorization", authorization);
      this.inferredCreatorPrincipal =
        parseCreatorPrincipalFromClaimsSafe(authorization);
    }

    this.websocketFactory = options.websocketFactory ?? defaultWebSocketFactory;
  }

  /**
   * Returns a session helper bound to an existing session id.
   */
  session(sessionId: string, record?: SessionRecord): StarciteSession {
    return new StarciteSession(this, sessionId, record);
  }

  /**
   * Creates a new session and returns a bound `StarciteSession` helper.
   */
  async create(input: CreateSessionInput = {}): Promise<StarciteSession> {
    const record = await this.createSession(input);
    return this.session(record.id, record);
  }

  /**
   * Creates a new session and returns the raw session record.
   */
  createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const payload = CreateSessionInputSchema.parse({
      ...input,
      creator_principal:
        input.creator_principal ?? this.inferredCreatorPrincipal,
    });

    return this.request(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      SessionRecordSchema
    );
  }

  /**
   * Lists sessions from the archive-backed catalog.
   */
  listSessions(options: SessionListOptions = {}): Promise<SessionListPage> {
    const query = new URLSearchParams();

    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        throw new StarciteError(
          "listSessions() limit must be a positive integer"
        );
      }

      query.set("limit", `${options.limit}`);
    }

    if (options.cursor !== undefined) {
      if (options.cursor.trim().length === 0) {
        throw new StarciteError("listSessions() cursor cannot be empty");
      }

      query.set("cursor", options.cursor);
    }

    if (options.metadata !== undefined) {
      for (const [key, value] of Object.entries(options.metadata)) {
        if (key.trim().length === 0 || value.trim().length === 0) {
          throw new StarciteError(
            "listSessions() metadata filters must be non-empty strings"
          );
        }

        query.set(`metadata.${key}`, value);
      }
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    return this.request(
      `/sessions${suffix}`,
      {
        method: "GET",
      },
      SessionListPageSchema
    );
  }

  /**
   * Appends a raw event payload to a specific session.
   */
  appendEvent(
    sessionId: string,
    input: AppendEventRequest
  ): Promise<AppendEventResponse> {
    const payload = AppendEventRequestSchema.parse(input);

    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/append`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      AppendEventResponseSchema
    );
  }

  /**
   * Opens a WebSocket tail stream and yields raw events.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single-loop reconnect state machine is intentionally explicit for stream correctness.
  async *tailRawEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent> {
    const initialCursor = options.cursor ?? 0;
    const reconnectEnabled = options.reconnect ?? true;
    const reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_TAIL_RECONNECT_DELAY_MS;

    if (!Number.isInteger(initialCursor) || initialCursor < 0) {
      throw new StarciteError("tail() cursor must be a non-negative integer");
    }

    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new StarciteError(
        "tail() reconnectDelayMs must be a non-negative number"
      );
    }

    let cursor = initialCursor;

    while (true) {
      if (options.signal?.aborted) {
        return;
      }

      const wsUrl = `${this.websocketBaseUrl}/sessions/${encodeURIComponent(
        sessionId
      )}/tail?cursor=${cursor}`;

      const websocketHeaders = new Headers();
      const authorization = this.headers.get("authorization");

      if (authorization) {
        websocketHeaders.set("authorization", authorization);
      }

      let socket: StarciteWebSocket;

      try {
        socket = this.websocketFactory(
          wsUrl,
          hasAnyHeaders(websocketHeaders)
            ? {
                headers: websocketHeaders,
              }
            : undefined
        );
      } catch (error) {
        const rootCause = toError(error).message;

        if (!reconnectEnabled || options.signal?.aborted) {
          throw new StarciteConnectionError(
            `Tail connection failed for session '${sessionId}': ${rootCause}`
          );
        }

        await waitForDelay(reconnectDelayMs, options.signal);
        continue;
      }

      const queue = new AsyncQueue<TailEvent>();
      let sawTransportError = false;
      let closeCode: number | undefined;
      let closeReason: string | undefined;
      let abortRequested = false;

      const onMessage = (event: unknown): void => {
        try {
          const parsed = parseEventFrame(getEventData(event));
          cursor = Math.max(cursor, parsed.seq);

          if (options.agent && agentFromActor(parsed.actor) !== options.agent) {
            return;
          }

          queue.push(parsed);
        } catch (error) {
          queue.fail(error);
        }
      };

      const onError = (): void => {
        sawTransportError = true;
        queue.close();
      };

      const onClose = (event: unknown): void => {
        closeCode = getCloseCode(event);
        closeReason = getCloseReason(event);
        queue.close();
      };

      const onAbort = (): void => {
        abortRequested = true;
        queue.close();
        socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "aborted");
      };

      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      let iterationError: Error | null = null;

      try {
        while (true) {
          const next = await queue.next();

          if (next.done) {
            break;
          }

          yield next.value;
        }
      } catch (error) {
        iterationError = toError(error);
      } finally {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);

        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }

        socket.close(NORMAL_WEBSOCKET_CLOSE_CODE, "finished");
      }

      if (iterationError) {
        throw iterationError;
      }

      if (abortRequested || options.signal?.aborted) {
        return;
      }

      const gracefullyClosed =
        !sawTransportError && closeCode === NORMAL_WEBSOCKET_CLOSE_CODE;

      if (gracefullyClosed) {
        return;
      }

      if (!reconnectEnabled) {
        throw new StarciteConnectionError(
          `Tail connection dropped for session '${sessionId}' (${describeClose(
            closeCode,
            closeReason
          )})`
        );
      }

      await waitForDelay(reconnectDelayMs, options.signal);
    }
  }

  /**
   * Opens a WebSocket tail stream and yields transformed session events.
   */
  async *tailEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<SessionEvent> {
    for await (const rawEvent of this.tailRawEvents(sessionId, options)) {
      yield toSessionEvent(rawEvent);
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema?: z.ZodType<T>
  ): Promise<T> {
    const headers = new Headers(this.headers);

    if (!headers.has("content-type")) {
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
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      const rootCause = toError(error).message;
      throw new StarciteConnectionError(
        `Failed to connect to Starcite at ${this.baseUrl}: ${rootCause}`
      );
    }

    if (!response.ok) {
      const payload = await tryParseJson(response);
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
      return undefined as T;
    }

    const responseBody = (await response.json()) as unknown;

    if (!schema) {
      return responseBody as T;
    }

    const parsed = schema.safeParse(responseBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid response";
      throw new StarciteConnectionError(
        `Received unexpected response payload from Starcite: ${issue}`
      );
    }

    return parsed.data;
  }
}

async function tryParseJson(
  response: Response
): Promise<StarciteErrorPayload | null> {
  try {
    const parsed = (await response.json()) as unknown;
    const result = StarciteErrorPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
