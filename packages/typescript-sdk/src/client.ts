import type { z } from "zod";
import {
  formatAuthorizationHeader,
  inferCreatorPrincipalFromApiKey,
  inferIssuerAuthorityFromApiKey,
} from "./auth";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import { streamTailRawEventBatches } from "./tail/stream";
import type {
  AppendEventRequest,
  AppendEventResponse,
  CreateSessionInput,
  IssueSessionTokenInput,
  IssueSessionTokenResponse,
  SessionAppendInput,
  SessionConsumeOptions,
  SessionConsumeRawOptions,
  SessionCreatorPrincipal,
  SessionCursorStore,
  SessionEvent,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
  StarciteWebSocketAuthTransport,
  StarciteWebSocketConnectOptions,
  TailEvent,
} from "./types";
import {
  AppendEventRequestSchema,
  AppendEventResponseSchema,
  CreateSessionInputSchema,
  IssueSessionTokenInputSchema,
  IssueSessionTokenResponseSchema,
  SessionAppendInputSchema,
  SessionListOptionsSchema,
  SessionListPageSchema,
  SessionRecordSchema,
  StarciteErrorPayloadSchema,
} from "./types";

const DEFAULT_BASE_URL =
  typeof process !== "undefined" && process.env.STARCITE_BASE_URL
    ? process.env.STARCITE_BASE_URL
    : "http://localhost:4000";
const DEFAULT_AUTH_URL =
  typeof process !== "undefined" && process.env.STARCITE_AUTH_URL
    ? process.env.STARCITE_AUTH_URL
    : undefined;
const TRAILING_SLASHES_REGEX = /\/+$/;

/**
 * Stable error text extraction for transport and parsing failures.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "Unknown error";
}

/**
 * Trims a string and collapses empty values to `undefined`.
 */
function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates and normalizes an absolute HTTP URL used for SDK endpoints.
 */
function normalizeAbsoluteHttpUrl(value: string, context: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new StarciteError(
      `${context} must be a valid http:// or https:// URL`
    );
  }

  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new StarciteError(`${context} must use http:// or https://`);
  }

  return parsed.toString().replace(TRAILING_SLASHES_REGEX, "");
}

/**
 * Resolves auth issuer base URL in this order:
 * explicit option -> env -> API key JWT issuer authority.
 */
function resolveAuthBaseUrl(
  explicitAuthUrl: string | undefined,
  apiAuthorization: string | undefined
): string | undefined {
  const configured = trimString(explicitAuthUrl);
  if (configured) {
    return normalizeAbsoluteHttpUrl(configured, "authUrl");
  }

  const envConfigured = trimString(DEFAULT_AUTH_URL);
  if (envConfigured) {
    return normalizeAbsoluteHttpUrl(envConfigured, "STARCITE_AUTH_URL");
  }

  if (!apiAuthorization) {
    return undefined;
  }

  const inferred = inferIssuerAuthorityFromApiKey(apiAuthorization);
  return inferred
    ? normalizeAbsoluteHttpUrl(inferred, "API key issuer authority")
    : undefined;
}

/**
 * Chooses websocket auth transport mode.
 *
 * `auto` prefers access token query auth for the default browser-compatible
 * factory and falls back to header auth for custom transports.
 */
function resolveWebSocketAuthTransport(
  requested: StarciteWebSocketAuthTransport | undefined,
  hasCustomFactory: boolean
): "header" | "access_token" {
  if (requested === "header" || requested === "access_token") {
    return requested;
  }

  return hasCustomFactory ? "header" : "access_token";
}

/**
 * Converts HTTP API base URL to its websocket equivalent.
 */
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

/**
 * Default websocket connector used when no custom factory is provided.
 */
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

/**
 * Adds SDK convenience fields (`agent`, `text`) to raw tail events.
 */
function toSessionEvent(event: TailEvent): SessionEvent {
  const agent = event.actor.startsWith("agent:")
    ? event.actor.slice("agent:".length)
    : undefined;
  const text =
    typeof event.payload.text === "string" ? event.payload.text : undefined;

  return {
    ...event,
    agent,
    text,
  };
}

/**
 * Shared options for durable consume loops.
 */
interface ConsumeTailOptions<TEvent>
  extends Omit<SessionTailOptions, "cursor"> {
  cursor?: number;
  cursorStore: SessionCursorStore;
  handler: (event: TEvent) => void | Promise<void>;
}

/**
 * Converts a Starcite base URL to the `/v1` API root used by this SDK.
 */
export function toApiBaseUrl(baseUrl: string): string {
  const normalized = normalizeAbsoluteHttpUrl(baseUrl, "baseUrl");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
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
   */
  append(input: SessionAppendInput): Promise<AppendEventResponse> {
    const parsed = SessionAppendInputSchema.parse(input);

    return this.client.appendEvent(this.id, {
      type: parsed.type ?? "content",
      payload: parsed.payload ?? { text: parsed.text },
      actor: parsed.actor ?? toAgentActor(parsed.agent),
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
   * Streams transformed session event batches grouped by incoming frame.
   */
  tailBatches(options: SessionTailOptions = {}): AsyncIterable<SessionEvent[]> {
    return this.client.tailEventBatches(this.id, options);
  }

  /**
   * Streams raw tail events returned by the API.
   */
  tailRaw(options: SessionTailOptions = {}): AsyncIterable<TailEvent> {
    return this.client.tailRawEvents(this.id, options);
  }

  /**
   * Streams raw tail event batches grouped by incoming frame.
   */
  tailRawBatches(options: SessionTailOptions = {}): AsyncIterable<TailEvent[]> {
    return this.client.tailRawEventBatches(this.id, options);
  }

  /**
   * Durably consumes transformed events and checkpoints `event.seq` after each successful handler invocation.
   */
  consume(options: SessionConsumeOptions): Promise<void> {
    return this.client.consumeEvents(this.id, options);
  }

  /**
   * Durably consumes raw events and checkpoints `event.seq` after each successful handler invocation.
   */
  consumeRaw(options: SessionConsumeRawOptions): Promise<void> {
    return this.client.consumeRawEvents(this.id, options);
  }
}

/**
 * Starcite API client for HTTP and WebSocket session operations.
 */
export class StarciteClient {
  /** Normalized API base URL ending with `/v1`. */
  readonly baseUrl: string;

  private readonly inferredCreatorPrincipal?: SessionCreatorPrincipal;
  private readonly authBaseUrl?: string;
  private readonly websocketBaseUrl: string;
  private readonly websocketAuthTransport: "header" | "access_token";
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
    this.baseUrl = toApiBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.websocketBaseUrl = toWebSocketBaseUrl(this.baseUrl);
    this.fetchFn = options.fetch ?? fetch;
    this.headers = new Headers(options.headers);
    let apiAuthorization: string | undefined;

    if (options.apiKey !== undefined) {
      apiAuthorization = formatAuthorizationHeader(options.apiKey);
      this.headers.set("authorization", apiAuthorization);
      this.inferredCreatorPrincipal =
        inferCreatorPrincipalFromApiKey(apiAuthorization);
    }

    this.authBaseUrl = resolveAuthBaseUrl(options.authUrl, apiAuthorization);
    this.websocketAuthTransport = resolveWebSocketAuthTransport(
      options.websocketAuthTransport,
      options.websocketFactory !== undefined
    );
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
    const parsed = SessionListOptionsSchema.parse(options);
    const query = new URLSearchParams();

    if (parsed.limit !== undefined) {
      query.set("limit", `${parsed.limit}`);
    }

    if (parsed.cursor !== undefined) {
      query.set("cursor", parsed.cursor);
    }

    if (parsed.metadata !== undefined) {
      for (const [key, value] of Object.entries(parsed.metadata)) {
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
   * Mints a short-lived session token using the configured auth issuer service.
   */
  issueSessionToken(
    input: IssueSessionTokenInput
  ): Promise<IssueSessionTokenResponse> {
    const authorization = this.headers.get("authorization");
    if (!authorization) {
      throw new StarciteError(
        "issueSessionToken() requires apiKey. Set StarciteClientOptions.apiKey."
      );
    }

    if (!this.authBaseUrl) {
      throw new StarciteError(
        "issueSessionToken() could not resolve auth issuer URL. Set StarciteClientOptions.authUrl, STARCITE_AUTH_URL, or use an API key JWT with an 'iss' claim."
      );
    }

    const payload = IssueSessionTokenInputSchema.parse(input);

    return this.requestWithBaseUrl(
      this.authBaseUrl,
      "/api/v1/session-tokens",
      {
        method: "POST",
        headers: {
          authorization,
          "cache-control": "no-store",
        },
        body: JSON.stringify(payload),
      },
      IssueSessionTokenResponseSchema
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
   * Opens a WebSocket tail stream and yields raw event batches grouped by frame.
   */
  async *tailRawEventBatches(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent[]> {
    yield* streamTailRawEventBatches({
      sessionId,
      options,
      websocketBaseUrl: this.websocketBaseUrl,
      websocketFactory: this.websocketFactory,
      authorization: this.headers.get("authorization"),
      websocketAuthTransport: this.websocketAuthTransport,
    });
  }

  /**
   * Opens a WebSocket tail stream and yields raw events.
   */
  async *tailRawEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent> {
    yield* flattenBatches(this.tailRawEventBatches(sessionId, options));
  }

  /**
   * Opens a WebSocket tail stream and yields transformed session event batches.
   */
  async *tailEventBatches(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<SessionEvent[]> {
    yield* mapBatches(
      this.tailRawEventBatches(sessionId, options),
      toSessionEvent
    );
  }

  /**
   * Opens a WebSocket tail stream and yields transformed session events.
   */
  async *tailEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<SessionEvent> {
    yield* flattenBatches(this.tailEventBatches(sessionId, options));
  }

  /**
   * Durably consumes transformed session events using a cursor store for resume-safe processing.
   */
  consumeEvents(
    sessionId: string,
    options: SessionConsumeOptions
  ): Promise<void> {
    return this.consumeFromTail(sessionId, options, (cursor, tailOptions) =>
      this.tailEvents(sessionId, { ...tailOptions, cursor })
    );
  }

  /**
   * Durably consumes raw session events using a cursor store for resume-safe processing.
   */
  consumeRawEvents(
    sessionId: string,
    options: SessionConsumeRawOptions
  ): Promise<void> {
    return this.consumeFromTail(sessionId, options, (cursor, tailOptions) =>
      this.tailRawEvents(sessionId, { ...tailOptions, cursor })
    );
  }

  private request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>
  ): Promise<T> {
    return this.requestWithBaseUrl(this.baseUrl, path, init, schema);
  }

  private async requestWithBaseUrl<T>(
    baseUrl: string,
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>
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
      response = await this.fetchFn(`${baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      const rootCause = errorMessage(error);
      throw new StarciteConnectionError(
        `Failed to connect to Starcite at ${baseUrl}: ${rootCause}`
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
      return parseResponseWithSchema(undefined, schema);
    }

    const responseBody = await parseSuccessfulJson(response);
    return parseResponseWithSchema(responseBody, schema);
  }

  private async consumeFromTail<TEvent extends { seq: number }>(
    sessionId: string,
    options: ConsumeTailOptions<TEvent>,
    streamFactory: (
      cursor: number,
      options: Omit<SessionTailOptions, "cursor">
    ) => AsyncIterable<TEvent>
  ): Promise<void> {
    const {
      cursorStore,
      handler,
      cursor: requestedCursor,
      ...tailOptions
    } = options;
    const cursor = await resolveConsumeCursor(
      sessionId,
      requestedCursor,
      cursorStore
    );

    for await (const event of streamFactory(cursor, tailOptions)) {
      await handler(event);
      await saveConsumeCursor(sessionId, cursorStore, event.seq);
    }
  }
}

/**
 * Best-effort parse for structured API error payloads.
 */
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

/**
 * Parses successful JSON responses and wraps malformed payloads as
 * connection-level protocol errors.
 */
async function parseSuccessfulJson(response: Response): Promise<unknown> {
  const body = await response.text();

  if (body.trim().length === 0) {
    throw new StarciteConnectionError(
      "Received empty response payload from Starcite"
    );
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    const rootCause = errorMessage(error);
    throw new StarciteConnectionError(
      `Received invalid JSON payload from Starcite: ${rootCause}`
    );
  }
}

function parseResponseWithSchema<T>(body: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "invalid response";
    throw new StarciteConnectionError(
      `Received unexpected response payload from Starcite: ${issue}`
    );
  }

  return parsed.data;
}

function toAgentActor(agent: string): string {
  const normalized = agent.trim();
  return normalized.startsWith("agent:") ? normalized : `agent:${normalized}`;
}

/**
 * Resolves starting cursor for consume loops (explicit cursor wins).
 */
async function resolveConsumeCursor(
  sessionId: string,
  requestedCursor: number | undefined,
  cursorStore: SessionCursorStore
): Promise<number> {
  if (requestedCursor !== undefined) {
    return requestedCursor;
  }

  const storedCursor = await withCursorStoreError(sessionId, "load", () =>
    cursorStore.load(sessionId)
  );

  return storedCursor ?? 0;
}

/**
 * Persists the latest processed cursor with wrapped store errors.
 */
async function saveConsumeCursor(
  sessionId: string,
  cursorStore: SessionCursorStore,
  cursor: number
): Promise<void> {
  await withCursorStoreError(sessionId, "save", () =>
    cursorStore.save(sessionId, cursor)
  );
}

/**
 * Adds session/action context to cursor-store adapter errors.
 */
async function withCursorStoreError<T>(
  sessionId: string,
  action: "load" | "save",
  execute: () => Promise<T> | T
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    const rootCause = errorMessage(error);
    throw new StarciteError(
      `consume() failed to ${action} cursor for session '${sessionId}': ${rootCause}`
    );
  }
}

/**
 * Maps each batch item while preserving frame-sized batching.
 */
async function* mapBatches<TIn, TOut>(
  source: AsyncIterable<TIn[]>,
  mapper: (value: TIn) => TOut
): AsyncGenerator<TOut[]> {
  for await (const batch of source) {
    yield batch.map(mapper);
  }
}

/**
 * Flattens batched iterables into item-by-item iteration.
 */
async function* flattenBatches<T>(
  source: AsyncIterable<T[]>
): AsyncGenerator<T> {
  for await (const batch of source) {
    for (const item of batch) {
      yield item;
    }
  }
}
