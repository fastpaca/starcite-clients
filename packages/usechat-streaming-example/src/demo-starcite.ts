import {
  type AppendEventRequest,
  createStarciteClient,
  type StarciteClient,
  type StarciteWebSocket,
} from "@starcite/sdk";
import { z } from "zod";

const UserMessagePayloadSchema = z.object({
  text: z.string().min(1),
});

const UIChunkPayloadSchema = z
  .object({
    type: z.enum([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
      "error",
    ]),
  })
  .catchall(z.unknown());

export const DemoPayloadSchema = z.union([
  UserMessagePayloadSchema,
  UIChunkPayloadSchema,
]);

export type DemoPayload = z.infer<typeof DemoPayloadSchema>;

const APPEND_PATH_REGEX = /^\/v1\/sessions\/([^/]+)\/append$/;
const TAIL_PATH_REGEX = /^\/v1\/sessions\/([^/]+)\/tail$/;

interface SessionRecord {
  id: string;
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_seq: number;
  events: TailEventFrame[];
  subscribers: Set<InMemoryWebSocket>;
  nextAssistantProducerSeq: number;
}

interface TailEventFrame {
  seq: number;
  type: string;
  payload: DemoPayload;
  actor: string;
  producer_id: string;
  producer_seq: number;
  source?: string;
  metadata?: Record<string, unknown>;
  refs?: Record<string, unknown>;
  idempotency_key?: string | null;
  inserted_at: string;
}

class InMemoryWebSocket implements StarciteWebSocket {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private readonly onClose: () => void;
  private closed = false;

  constructor(onClose: () => void) {
    this.onClose = onClose;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    handlers.delete(listener);
    if (handlers.size === 0) {
      this.listeners.delete(type);
    }
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.emit("close", { code, reason });
    this.onClose();
  }

  sendTailEvent(frame: TailEventFrame): void {
    if (this.closed) {
      return;
    }

    this.emit("message", {
      data: JSON.stringify(frame),
    });
  }

  private emit(type: string, event: unknown): void {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(event);
    }
  }
}

class DemoStarciteBackend {
  private readonly sessions = new Map<string, SessionRecord>();

  readonly fetch: typeof fetch = (input, init = {}) => {
    const url = this.getUrl(input);
    const method = this.getMethod(input, init);

    if (method === "POST" && url.pathname === "/v1/sessions") {
      const body = this.parseBody(init.body);
      return Promise.resolve(this.handleCreateSession(body));
    }

    const appendMatch = url.pathname.match(APPEND_PATH_REGEX);
    if (method === "POST" && appendMatch?.[1]) {
      const sessionId = decodeURIComponent(appendMatch[1]);
      const body = this.parseBody(init.body) as AppendEventRequest<DemoPayload>;
      return Promise.resolve(this.handleAppend(sessionId, body));
    }

    return Promise.resolve(
      this.json(
        {
          error: "not_found",
          message: `No demo route for ${method} ${url.pathname}`,
        },
        404
      )
    );
  };

  readonly websocketFactory = (url: string): StarciteWebSocket =>
    this.openTailSocket(url);

  private getUrl(input: RequestInfo | URL): URL {
    if (typeof input === "string") {
      return new URL(input);
    }

    if (input instanceof URL) {
      return input;
    }

    return new URL(input.url);
  }

  private getMethod(input: RequestInfo | URL, init: RequestInit): string {
    if (init.method) {
      return init.method.toUpperCase();
    }

    if (
      typeof input === "object" &&
      input !== null &&
      !(input instanceof URL) &&
      "method" in input &&
      typeof input.method === "string" &&
      input.method.length > 0
    ) {
      return input.method.toUpperCase();
    }

    return "GET";
  }

  private parseBody(
    body: BodyInit | null | undefined
  ): Record<string, unknown> {
    if (typeof body !== "string" || body.length === 0) {
      return {};
    }

    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private handleCreateSession(body: Record<string, unknown>): Response {
    const id =
      typeof body.id === "string" && body.id.trim().length > 0
        ? body.id.trim()
        : randomId("ses");

    if (this.sessions.has(id)) {
      return this.json(
        {
          error: "session_exists",
          message: `Session '${id}' already exists`,
        },
        409
      );
    }

    const now = nowIso();
    const record: SessionRecord = {
      id,
      title: typeof body.title === "string" ? body.title : null,
      metadata: asRecord(body.metadata),
      created_at: now,
      updated_at: now,
      last_seq: 0,
      events: [],
      subscribers: new Set(),
      nextAssistantProducerSeq: 1,
    };

    this.sessions.set(id, record);

    return this.json(
      {
        id: record.id,
        title: record.title,
        metadata: record.metadata,
        last_seq: record.last_seq,
        created_at: record.created_at,
        updated_at: record.updated_at,
      },
      201
    );
  }

  private handleAppend(
    sessionId: string,
    input: AppendEventRequest<DemoPayload>
  ): Response {
    const session = this.getOrCreateSession(sessionId);
    const event = this.pushEvent(session, input);

    if (
      input.type === "chat.user.message" &&
      input.actor === "agent:user" &&
      isUserPayload(input.payload)
    ) {
      this.scheduleAssistantResponse(session, input.payload.text);
    }

    return this.json(
      {
        seq: event.seq,
        last_seq: session.last_seq,
        deduped: false,
      },
      201
    );
  }

  private openTailSocket(url: string): InMemoryWebSocket {
    const parsed = new URL(url);
    const match = parsed.pathname.match(TAIL_PATH_REGEX);

    if (!match?.[1]) {
      throw new Error(`Invalid tail path: ${parsed.pathname}`);
    }

    const sessionId = decodeURIComponent(match[1]);
    const cursorValue = Number.parseInt(
      parsed.searchParams.get("cursor") ?? "0",
      10
    );
    const cursor =
      Number.isInteger(cursorValue) && cursorValue >= 0 ? cursorValue : 0;

    const session = this.getOrCreateSession(sessionId);

    let socket: InMemoryWebSocket | null = null;
    socket = new InMemoryWebSocket(() => {
      if (socket) {
        session.subscribers.delete(socket);
      }
    });

    session.subscribers.add(socket);

    queueMicrotask(() => {
      for (const event of session.events) {
        if (event.seq > cursor) {
          socket?.sendTailEvent(event);
        }
      }
    });

    return socket;
  }

  private getOrCreateSession(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const created: SessionRecord = {
      id: sessionId,
      title: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      last_seq: 0,
      events: [],
      subscribers: new Set(),
      nextAssistantProducerSeq: 1,
    };

    this.sessions.set(sessionId, created);
    return created;
  }

  private pushEvent(
    session: SessionRecord,
    input: AppendEventRequest<DemoPayload>
  ): TailEventFrame {
    const insertedAt = nowIso();
    const event: TailEventFrame = {
      seq: session.last_seq + 1,
      type: input.type,
      payload: input.payload,
      actor: input.actor,
      producer_id: input.producer_id,
      producer_seq: input.producer_seq,
      source: input.source,
      metadata: input.metadata,
      refs: input.refs,
      idempotency_key: input.idempotency_key ?? null,
      inserted_at: insertedAt,
    };

    session.events.push(event);
    session.last_seq = event.seq;
    session.updated_at = insertedAt;

    this.broadcast(session, event);
    return event;
  }

  private scheduleAssistantResponse(
    session: SessionRecord,
    prompt: string
  ): void {
    const messageId = randomId("assistant");
    const textId = randomId("text");
    const responseText = `Demo assistant streamed this from Starcite: ${prompt}`;

    const chunks: DemoPayload[] = [
      { type: "start", messageId },
      { type: "text-start", id: textId },
      { type: "text-delta", id: textId, delta: responseText },
      { type: "text-end", id: textId },
      { type: "finish", finishReason: "stop" },
    ];

    let producerSeq = session.nextAssistantProducerSeq;

    for (const [index, payload] of chunks.entries()) {
      const producer_seq = producerSeq;
      producerSeq += 1;

      window.setTimeout(
        () => {
          this.pushEvent(session, {
            type: "content",
            payload,
            actor: "agent:assistant",
            producer_id: "producer:demo-assistant",
            producer_seq,
            source: "demo-assistant",
          });
        },
        140 * (index + 1)
      );
    }

    session.nextAssistantProducerSeq = producerSeq;
  }

  private broadcast(session: SessionRecord, event: TailEventFrame): void {
    for (const socket of session.subscribers) {
      socket.sendTailEvent(event);
    }
  }

  private json(payload: unknown, status: number): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isUserPayload(
  value: unknown
): value is z.infer<typeof UserMessagePayloadSchema> {
  return UserMessagePayloadSchema.safeParse(value).success;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDemoStarciteClient(): StarciteClient<DemoPayload> {
  const backend = new DemoStarciteBackend();

  return createStarciteClient<DemoPayload>({
    baseUrl: "http://demo.starcite.local",
    fetch: backend.fetch,
    websocketFactory: backend.websocketFactory,
    payloadSchema: DemoPayloadSchema,
  });
}
