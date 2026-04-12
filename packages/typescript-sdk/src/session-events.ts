import { z } from "zod";
import { StarciteError } from "./errors";
import {
  type SessionEventSlice,
  TailCursorSchema,
  type TailEvent,
  TailEventSchema,
} from "./types";

const SessionEventsResponseSchema = z.object({
  events: z.array(TailEventSchema),
  next_cursor: TailCursorSchema,
  last_seq: z.number().int().nonnegative(),
  has_more: z.boolean().optional(),
});

export type SessionEventsResponse = z.infer<typeof SessionEventsResponseSchema>;

export type SessionEventsRead =
  | {
      kind: "latest";
      limit: number;
    }
  | {
      kind: "before";
      limit: number;
      seq: number;
    }
  | {
      kind: "after";
      limit: number;
      seq: number;
    };

export function sessionEventsResponseSchema(): z.ZodType<SessionEventsResponse> {
  return SessionEventsResponseSchema;
}

export function appendSessionEventsQuery(
  query: URLSearchParams,
  read: SessionEventsRead
): void {
  if (!Number.isInteger(read.limit) || read.limit <= 0) {
    throw new StarciteError("Session event reads require limit > 0.");
  }

  query.set("limit", `${read.limit}`);

  if (read.kind === "latest") {
    query.set("direction", "tail");
    return;
  }

  if (!Number.isInteger(read.seq) || read.seq < 0) {
    throw new StarciteError("Session event reads require seq >= 0.");
  }

  query.set("from_seq", `${read.seq}`);
  query.set("direction", read.kind === "before" ? "tail" : "head");
}

export function toSessionEventsQuerySuffix(read: SessionEventsRead): string {
  const query = new URLSearchParams();
  appendSessionEventsQuery(query, read);
  return `?${query.toString()}`;
}

export function toSessionEventSlice(
  read: SessionEventsRead,
  response: SessionEventsResponse
): SessionEventSlice {
  return {
    events: response.events,
    hasMore: readHasMore(read, response),
  };
}

function readHasMore(
  read: SessionEventsRead,
  response: SessionEventsResponse
): boolean {
  if (response.has_more !== undefined) {
    return response.has_more;
  }

  if (read.kind === "after") {
    const lastSeq = response.events.at(-1)?.seq;
    return (lastSeq ?? read.seq) < response.last_seq;
  }

  const firstSeq = response.events[0]?.seq;
  return firstSeq !== undefined && firstSeq > 1;
}

export function concatSessionEvents(
  current: readonly TailEvent[],
  incoming: readonly TailEvent[]
): TailEvent[] {
  if (incoming.length === 0) {
    return [...current];
  }

  const bySeq = new Map<number, TailEvent>();
  for (const event of current) {
    bySeq.set(event.seq, event);
  }
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}
