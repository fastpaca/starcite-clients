import { StarciteError } from "./errors";
import type { StarciteIdentity } from "./identity";
import { errorMessage } from "./internal/primitives";
import { streamTailRawEventBatches } from "./tail/stream";
import type { TransportConfig } from "./transport";
import { flattenBatches, request } from "./transport";
import type {
  AppendEventRequest,
  AppendEventResponse,
  RequestOptions,
  SessionAppendInput,
  SessionConsumeOptions,
  SessionCursorStore,
  SessionRecord,
  SessionTailOptions,
  TailEvent,
} from "./types";
import {
  AppendEventResponseSchema,
  SessionAppendInputSchema,
} from "./types";

/**
 * Construction options for a `StarciteSession`.
 */
export interface StarciteSessionOptions {
  id: string;
  token: string;
  identity: StarciteIdentity;
  transport: TransportConfig;
  record?: SessionRecord;
}

/**
 * Session-scoped client bound to a specific identity and session token.
 *
 * All operations use the session token for auth — not the parent client's API key.
 */
export class StarciteSession {
  /** Session identifier. */
  readonly id: string;
  /** The session JWT used for auth. Extract this for frontend handoff. */
  readonly token: string;
  /** Identity bound to this session. */
  readonly identity: StarciteIdentity;
  /** Optional session record captured at creation time. */
  readonly record?: SessionRecord;

  private readonly transport: TransportConfig;

  constructor(options: StarciteSessionOptions) {
    this.id = options.id;
    this.token = options.token;
    this.identity = options.identity;
    this.transport = options.transport;
    this.record = options.record;
  }

  /**
   * Appends an event to this session.
   *
   * The `actor` is derived from the session's identity unless explicitly overridden.
   */
  append(
    input: SessionAppendInput,
    options?: RequestOptions
  ): Promise<AppendEventResponse> {
    const parsed = SessionAppendInputSchema.parse(input);

    return this.appendRaw(
      {
        type: parsed.type ?? "content",
        payload: parsed.payload ?? { text: parsed.text },
        actor: parsed.actor ?? this.identity.toActor(),
        producer_id: parsed.producerId,
        producer_seq: parsed.producerSeq,
        source: parsed.source ?? "agent",
        metadata: parsed.metadata,
        refs: parsed.refs,
        idempotency_key: parsed.idempotencyKey,
        expected_seq: parsed.expectedSeq,
      },
      options
    );
  }

  /**
   * Appends a raw event payload as-is.
   */
  appendRaw(
    input: AppendEventRequest,
    options?: RequestOptions
  ): Promise<AppendEventResponse> {
    return request(
      this.transport,
      `/sessions/${encodeURIComponent(this.id)}/append`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options?.signal,
      },
      AppendEventResponseSchema
    );
  }

  /**
   * Streams tail events one at a time.
   */
  async *tail(
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent> {
    yield* flattenBatches(this.tailBatches(options));
  }

  /**
   * Streams tail event batches grouped by incoming frame.
   */
  async *tailBatches(
    options: SessionTailOptions = {}
  ): AsyncGenerator<TailEvent[]> {
    yield* streamTailRawEventBatches({
      sessionId: this.id,
      options,
      websocketBaseUrl: this.transport.websocketBaseUrl,
      websocketFactory: this.transport.websocketFactory,
      authorization: this.transport.authorization,
      websocketAuthTransport: this.transport.websocketAuthTransport,
    });
  }

  /**
   * Durably consumes events and checkpoints `event.seq` after each successful handler invocation.
   */
  async consume(options: SessionConsumeOptions): Promise<void> {
    const {
      cursorStore,
      handler,
      cursor: requestedCursor,
      ...tailOptions
    } = options;

    let cursor: number;

    if (requestedCursor !== undefined) {
      cursor = requestedCursor;
    } else {
      try {
        cursor = (await cursorStore.load(this.id)) ?? 0;
      } catch (error) {
        throw new StarciteError(
          `consume() failed to load cursor for session '${this.id}': ${errorMessage(error)}`
        );
      }
    }

    for await (const event of this.tail({ ...tailOptions, cursor })) {
      await handler(event);

      try {
        await cursorStore.save(this.id, event.seq);
      } catch (error) {
        throw new StarciteError(
          `consume() failed to save cursor for session '${this.id}': ${errorMessage(error)}`
        );
      }
    }
  }
}
