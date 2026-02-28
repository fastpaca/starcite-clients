import { z } from "zod";
import { StarciteConnectionError } from "../errors";
import type { TailEvent } from "../types";
import { TailEventSchema } from "../types";

/**
 * Minimum allowed replay batch size accepted by the API.
 */
export const MIN_TAIL_BATCH_SIZE = 1;
/**
 * Maximum allowed replay batch size accepted by the API.
 */
export const MAX_TAIL_BATCH_SIZE = 1000;

const TailFramePayloadSchema = z.union([
  TailEventSchema,
  z.array(TailEventSchema).min(MIN_TAIL_BATCH_SIZE),
]);

/**
 * Converts websocket message payloads to UTF-8 text for JSON parsing.
 */
function toFrameText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return undefined;
}

/**
 * Parses one websocket tail frame into a normalized event batch.
 */
export function parseTailFrame(data: unknown): TailEvent[] {
  const frameText = toFrameText(data);

  if (!frameText) {
    throw new StarciteConnectionError(
      "Tail frame payload must be a UTF-8 string or binary buffer"
    );
  }

  let framePayload: unknown;

  try {
    framePayload = JSON.parse(frameText) as unknown;
  } catch {
    throw new StarciteConnectionError("Tail frame was not valid JSON");
  }

  const result = TailFramePayloadSchema.safeParse(framePayload);

  if (!result.success) {
    const reason =
      result.error.issues[0]?.message ?? "Tail frame did not match schema";
    throw new StarciteConnectionError(reason);
  }

  return Array.isArray(result.data) ? result.data : [result.data];
}
