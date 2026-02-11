import type { StarciteErrorPayload } from "./types";

export class StarciteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarciteError";
  }
}

export class StarciteApiError extends StarciteError {
  readonly status: number;
  readonly code: string;
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

export class StarciteConnectionError extends StarciteError {
  constructor(message: string) {
    super(message);
    this.name = "StarciteConnectionError";
  }
}
