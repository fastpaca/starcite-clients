export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export interface EventRefs {
  [key: string]: JsonValue | undefined;
  to_seq?: number;
  request_id?: string;
  sequence_id?: string;
  step?: number;
}

export interface CreateSessionInput {
  id?: string;
  title?: string;
  metadata?: JsonObject;
}

export interface SessionRecord {
  id: string;
  title?: string | null;
  metadata: JsonObject;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

export interface AppendEventRequest {
  type: string;
  payload: JsonObject;
  actor: string;
  source?: string;
  metadata?: JsonObject;
  refs?: EventRefs;
  idempotency_key?: string;
  expected_seq?: number;
}

export interface AppendEventResponse {
  seq: number;
  last_seq: number;
  deduped: boolean;
}

export interface TailEvent {
  seq: number;
  type: string;
  payload: JsonObject;
  actor: string;
  source?: string;
  metadata?: JsonObject;
  refs?: EventRefs;
  idempotency_key?: string;
  inserted_at?: string;
}

export interface SessionEvent extends TailEvent {
  agent?: string;
  text?: string;
}

export interface SessionAppendInput {
  agent: string;
  text?: string;
  payload?: JsonObject;
  type?: string;
  source?: string;
  metadata?: JsonObject;
  refs?: EventRefs;
  idempotencyKey?: string;
  expectedSeq?: number;
}

export interface SessionTailOptions {
  cursor?: number;
  agent?: string;
  signal?: AbortSignal;
}

export interface StarciteWebSocket {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
}

export type StarciteWebSocketFactory = (url: string) => StarciteWebSocket;

export interface StarciteClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  websocketFactory?: StarciteWebSocketFactory;
}

export interface StarciteErrorPayload {
  error?: string;
  message?: string;
  [key: string]: JsonValue | undefined;
}
