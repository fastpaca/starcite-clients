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
  SessionEvent,
  SessionListOptions,
  SessionListPage,
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
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
  TailEventSchema,
} from "./types";

const DEFAULT_BASE_URL =
  typeof process !== "undefined" && process.env.STARCITE_BASE_URL
    ? process.env.STARCITE_BASE_URL
    : "http://localhost:4000";
const TRAILING_SLASHES_REGEX = /\/+$/;

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

function defaultWebSocketFactory(url: string): StarciteWebSocket {
  if (typeof WebSocket === "undefined") {
    throw new StarciteError(
      "WebSocket is not available in this runtime. Provide websocketFactory in StarciteClientOptions."
    );
  }

  return new WebSocket(url) as unknown as StarciteWebSocket;
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

  private readonly websocketBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Headers;
  private readonly websocketFactory: (url: string) => StarciteWebSocket;

  /**
   * Creates a new client instance.
   */
  constructor(options: StarciteClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.websocketBaseUrl = toWebSocketBaseUrl(this.baseUrl);
    this.fetchFn = options.fetch ?? defaultFetch;
    this.headers = new Headers(options.headers);
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
    const payload = CreateSessionInputSchema.parse(input);

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
  async *tailRawEvents(
    sessionId: string,
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent> {
    const queue = new AsyncQueue<TailEvent>();
    const cursor = options.cursor ?? 0;

    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new StarciteError("tail() cursor must be a non-negative integer");
    }

    const wsUrl = `${this.websocketBaseUrl}/sessions/${encodeURIComponent(
      sessionId
    )}/tail?cursor=${cursor}`;

    const socket = this.websocketFactory(wsUrl);

    const onMessage = (event: unknown): void => {
      try {
        const parsed = parseEventFrame(getEventData(event));

        if (options.agent && agentFromActor(parsed.actor) !== options.agent) {
          return;
        }

        queue.push(parsed);
      } catch (error) {
        queue.fail(error);
      }
    };

    const onError = (): void => {
      queue.fail(
        new StarciteConnectionError(
          `Tail connection failed for session '${sessionId}'`
        )
      );
    };

    const onClose = (): void => {
      queue.close();
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    const onAbort = (): void => {
      queue.close();
      socket.close(1000, "aborted");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      while (true) {
        const next = await queue.next();

        if (next.done) {
          break;
        }

        yield next.value;
      }
    } finally {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);

      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }

      socket.close(1000, "finished");
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
