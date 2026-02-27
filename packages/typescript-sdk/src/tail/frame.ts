import { z } from "zod";
import { StarciteConnectionError } from "../errors";
import type { TailEvent } from "../types";
import { TailEventSchema } from "../types";

export const MIN_TAIL_BATCH_SIZE = 1;
export const MAX_TAIL_BATCH_SIZE = 1000;

const TailFramePayloadSchema = z.union([
  TailEventSchema,
  z.array(TailEventSchema).min(MIN_TAIL_BATCH_SIZE),
]);

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
  .pipe(TailFramePayloadSchema);

export function parseTailFrame(data: unknown): TailEvent[] {
  const result = TailFrameSchema.safeParse(data);

  if (!result.success) {
    const reason =
      result.error.issues[0]?.message ?? "Tail frame did not match schema";
    throw new StarciteConnectionError(reason);
  }

  return Array.isArray(result.data) ? result.data : [result.data];
}
