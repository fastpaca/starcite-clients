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
