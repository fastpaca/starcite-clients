import type { SessionEvent } from "@starcite/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli";

interface FakeSession {
  readonly id: string;
  readonly record?: { id: string; title?: string };
  append: ReturnType<typeof vi.fn>;
  appendRaw: ReturnType<typeof vi.fn>;
  tail: ReturnType<typeof vi.fn>;
}

function makeLogger() {
  const info: string[] = [];
  const error: string[] = [];

  return {
    info,
    error,
    logger: {
      info(message: string) {
        info.push(message);
      },
      error(message: string) {
        error.push(message);
      },
    },
  };
}

function streamEvents(events: SessionEvent[]): AsyncIterable<SessionEvent> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = events[Symbol.iterator]();
      return {
        next() {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

describe("starcite CLI", () => {
  const create = vi.fn();
  const session = vi.fn();

  const fakeSession: FakeSession = {
    id: "ses_123",
    record: { id: "ses_123", title: "Draft contract" },
    append: vi.fn(),
    appendRaw: vi.fn(),
    tail: vi.fn(),
  };

  beforeEach(() => {
    create.mockReset();
    session.mockReset();
    fakeSession.append.mockReset();
    fakeSession.appendRaw.mockReset();
    fakeSession.tail.mockReset();

    create.mockResolvedValue(fakeSession);
    session.mockReturnValue(fakeSession);
    fakeSession.append.mockResolvedValue({
      seq: 1,
      last_seq: 1,
      deduped: false,
    });
    fakeSession.appendRaw.mockResolvedValue({
      seq: 2,
      last_seq: 2,
      deduped: false,
    });
    fakeSession.tail.mockReturnValue(
      streamEvents([
        {
          seq: 1,
          type: "content",
          payload: { text: "Drafting clause 4.2..." },
          actor: "agent:drafter",
          agent: "drafter",
          text: "Drafting clause 4.2...",
        },
      ])
    );
  });

  it("creates sessions and prints the id", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(["create", "--title", "Draft contract"], {
      from: "user",
    });

    expect(create).toHaveBeenCalledWith({
      id: undefined,
      title: "Draft contract",
      metadata: undefined,
    });
    expect(info).toEqual(["ses_123"]);
  });

  it("appends in high-level mode", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(
      [
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--text",
        "Found 8 relevant cases...",
      ],
      {
        from: "user",
      }
    );

    expect(session).toHaveBeenCalledWith("ses_123");
    expect(fakeSession.append).toHaveBeenCalledWith({
      agent: "researcher",
      text: "Found 8 relevant cases...",
      type: "content",
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(info).toEqual(["seq=1 last_seq=1 deduped=false"]);
  });

  it("tails events and formats output", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(["tail", "ses_123", "--limit", "1"], {
      from: "user",
    });

    expect(fakeSession.tail).toHaveBeenCalledWith({
      cursor: 0,
      agent: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(info).toEqual(["[drafter] Drafting clause 4.2..."]);
  });
});
