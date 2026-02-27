import type { StarciteErrorPayload } from "./types";

/**
 * Base error type for SDK-level failures.
 */
export class StarciteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarciteError";
  }
}

/**
 * Thrown when the Starcite API responds with a non-2xx status code.
 */
export class StarciteApiError extends StarciteError {
  /** HTTP status code returned by the API. */
  readonly status: number;
  /** Stable API error code (or synthesized `http_<status>` fallback). */
  readonly code: string;
  /** Parsed API error payload when available. */
  readonly payload: StarciteErrorPayload | null;

  constructor(
    message: string,
    status: number,
    code: string,
    payload: StarciteErrorPayload | null
  ) {
    super(message);
    this.name = "StarciteApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

/**
 * Thrown when the SDK cannot reach Starcite or receives invalid transport payloads.
 */
export class StarciteConnectionError extends StarciteError {
  constructor(message: string) {
    super(message);
    this.name = "StarciteConnectionError";
  }
}

export type StarciteTailErrorStage =
  | "connect"
  | "stream"
  | "retry_limit"
  | "consumer_backpressure";

/**
 * Thrown for tail-stream failures with structured stage/context fields.
 */
export class StarciteTailError extends StarciteConnectionError {
  /** Session id tied to this tail stream. */
  readonly sessionId: string;
  /** Failure stage in the tail lifecycle. */
  readonly stage: StarciteTailErrorStage;
  /** Reconnect attempts observed before failing. */
  readonly attempts: number;
  /** WebSocket close code when available. */
  readonly closeCode?: number;
  /** WebSocket close reason when available. */
  readonly closeReason?: string;

  constructor(
    message: string,
    options: {
      sessionId: string;
      stage: StarciteTailErrorStage;
      attempts?: number;
      closeCode?: number;
      closeReason?: string;
    }
  ) {
    super(message);
    this.name = "StarciteTailError";
    this.sessionId = options.sessionId;
    this.stage = options.stage;
    this.attempts = options.attempts ?? 0;
    this.closeCode = options.closeCode;
    this.closeReason = options.closeReason;
  }
}
