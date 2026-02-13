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
  SessionRecord,
  SessionTailOptions,
  StarciteClientOptions,
  StarciteErrorPayload,
  StarciteWebSocket,
  TailEvent,
} from "./types";
import {
  AppendEventResponseSchema,
  JsonObjectSchema,
  SessionRecordSchema,
  StarciteErrorPayloadSchema,
  TailEventSchema,
} from "./types";

const DEFAULT_BASE_URL =
  typeof process !== "undefined" && process.env.STARCITE_BASE_URL
    ? process.env.STARCITE_BASE_URL
    : "http://localhost:4000";
const TRAILING_SLASHES_REGEX = /\/+$/;

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
  if (typeof data !== "string") {
    throw new StarciteConnectionError("Tail frame was not valid JSON text");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    throw new StarciteConnectionError("Tail frame was not valid JSON");
  }

  const result = TailEventSchema.safeParse(parsed);

  if (!result.success) {
    const reason = result.error.issues[0]?.message ?? "invalid event payload";
    throw new StarciteConnectionError(
      `Tail frame did not match expected schema: ${reason}`
    );
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

export class StarciteSession {
  readonly id: string;
  readonly record?: SessionRecord;

  private readonly client: StarciteClient;

  constructor(client: StarciteClient, id: string, record?: SessionRecord) {
    this.client = client;
    this.id = id;
    this.record = record;
  }

  append(input: SessionAppendInput): Promise<AppendEventResponse> {
    if (!input.agent || input.agent.trim().length === 0) {
      throw new StarciteError("append() requires a non-empty 'agent'");
    }

    const actor = input.agent.startsWith("agent:")
      ? input.agent
      : `agent:${input.agent}`;

    const payload =
      input.payload ?? (input.text ? { text: input.text } : undefined);

    if (!(payload && JsonObjectSchema.safeParse(payload).success)) {
      throw new StarciteError(
        "append() requires either 'text' or an object 'payload'"
      );
    }

    return this.client.appendEvent(this.id, {
      type: input.type ?? "content",
      payload,
      actor,
      source: input.source ?? "agent",
      metadata: input.metadata,
      refs: input.refs,
      idempotency_key: input.idempotencyKey,
      expected_seq: input.expectedSeq,
    });
  }

  appendRaw(input: AppendEventRequest): Promise<AppendEventResponse> {
    return this.client.appendEvent(this.id, input);
  }

  tail(options: SessionTailOptions = {}): AsyncIterable<SessionEvent> {
    return this.client.tailEvents(this.id, options);
  }

  tailRaw(options: SessionTailOptions = {}): AsyncIterable<TailEvent> {
    return this.client.tailRawEvents(this.id, options);
  }
}

export class StarciteClient {
  readonly baseUrl: string;

  private readonly websocketBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers: Headers;
  private readonly websocketFactory: (url: string) => StarciteWebSocket;

  constructor(options: StarciteClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.websocketBaseUrl = toWebSocketBaseUrl(this.baseUrl);
    this.fetchFn = options.fetch ?? defaultFetch;
    this.headers = new Headers(options.headers);
    this.websocketFactory = options.websocketFactory ?? defaultWebSocketFactory;
  }

  session(sessionId: string, record?: SessionRecord): StarciteSession {
    return new StarciteSession(this, sessionId, record);
  }

  async create(input: CreateSessionInput = {}): Promise<StarciteSession> {
    const record = await this.createSession(input);
    return this.session(record.id, record);
  }

  createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
    return this.request<SessionRecord>(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      (responseBody) => SessionRecordSchema.parse(responseBody)
    );
  }

  appendEvent(
    sessionId: string,
    input: AppendEventRequest
  ): Promise<AppendEventResponse> {
    return this.request<AppendEventResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/append`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      (responseBody) => AppendEventResponseSchema.parse(responseBody)
    );
  }

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
      const data = getEventData(event);

      try {
        const parsed = parseEventFrame(data);

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
    parser?: (value: unknown) => T
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

    let responseBody: unknown;

    try {
      responseBody = await response.json();
    } catch {
      throw new StarciteConnectionError(
        `Received invalid JSON response from Starcite at ${this.baseUrl}${path}`
      );
    }

    if (!parser) {
      return responseBody as T;
    }

    try {
      return parser(responseBody);
    } catch (error) {
      throw new StarciteConnectionError(
        `Received unexpected response payload from Starcite: ${toError(error).message}`
      );
    }
  }
}

async function tryParseJson(
  response: Response
): Promise<StarciteErrorPayload | null> {
  try {
    const parsed = (await response.json()) as unknown;
    const result = StarciteErrorPayloadSchema.safeParse(parsed);

    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}
