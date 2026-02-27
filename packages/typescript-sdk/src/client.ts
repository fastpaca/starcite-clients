import type { z } from "zod";
import {
  formatAuthorizationHeader,
  inferCreatorPrincipalFromApiKey,
} from "./auth";
import {
  StarciteApiError,
  StarciteConnectionError,
  StarciteError,
} from "./errors";
import {
  defaultFetch,
  defaultWebSocketFactory,
  toWebSocketBaseUrl,
} from "./runtime";
import { streamTailRawEventBatches } from "./tail/stream";
import { toSessionEvent } from "./tail/transform";
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
  SessionListPageSchema,
  SessionRecordSchema,
  StarciteErrorPayloadSchema,
} from "./types";

const DEFAULT_BASE_URL =
  typeof process !== "undefined" && process.env.STARCITE_BASE_URL
    ? process.env.STARCITE_BASE_URL
    : "http://localhost:4000";
const TRAILING_SLASHES_REGEX = /\/+$/;

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

/**
 * Normalizes a Starcite base URL to the `/v1` API root used by this SDK.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(TRAILING_SLASHES_REGEX, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
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
        inferCreatorPrincipalFromApiKey(authorization);
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
    });
  }

  /**
   * Opens a WebSocket tail stream and yields raw events.
   */
  async *tailRawEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent> {
    for await (const eventBatch of this.tailRawEventBatches(
      sessionId,
      options
    )) {
      for (const event of eventBatch) {
        yield event;
      }
    }
  }

  /**
   * Opens a WebSocket tail stream and yields transformed session event batches.
   */
  async *tailEventBatches(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<SessionEvent[]> {
    for await (const rawBatch of this.tailRawEventBatches(sessionId, options)) {
      yield rawBatch.map(toSessionEvent);
    }
  }

  /**
   * Opens a WebSocket tail stream and yields transformed session events.
   */
  async *tailEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<SessionEvent> {
    for await (const eventBatch of this.tailEventBatches(sessionId, options)) {
      for (const event of eventBatch) {
        yield event;
      }
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
