import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@starcite/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli";

const GENERATED_PRODUCER_ID_PATTERN = /^cli:/;

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
  let configDir = "";

  const fakeSession: FakeSession = {
    id: "ses_123",
    record: { id: "ses_123", title: "Draft contract" },
    append: vi.fn(),
    appendRaw: vi.fn(),
    tail: vi.fn(),
  };

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "starcite-cli-test-"));
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
          producer_id: "producer:drafter",
          producer_seq: 1,
          agent: "drafter",
          text: "Drafting clause 4.2...",
        },
      ])
    );
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("creates sessions and prints the id", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "create", "--title", "Draft contract"],
      {
        from: "user",
      }
    );

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
        "--config-dir",
        configDir,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--producer-id",
        "producer:researcher",
        "--producer-seq",
        "1",
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
      producerId: "producer:researcher",
      producerSeq: 1,
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

  it("auto-generates producer id when missing", async () => {
    const { logger } = makeLogger();
    const previousProducerId = process.env.STARCITE_PRODUCER_ID;
    Reflect.deleteProperty(process.env, "STARCITE_PRODUCER_ID");

    try {
      const program = buildProgram({
        logger,
        createClient: () => ({ create, session }) as never,
      });

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
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

      const firstCall = fakeSession.append.mock.calls[0]?.[0] as
        | { producerId?: string; producerSeq?: number }
        | undefined;
      expect(firstCall?.producerId).toMatch(GENERATED_PRODUCER_ID_PATTERN);
      expect(firstCall?.producerSeq).toBe(1);
    } finally {
      if (previousProducerId === undefined) {
        Reflect.deleteProperty(process.env, "STARCITE_PRODUCER_ID");
      } else {
        process.env.STARCITE_PRODUCER_ID = previousProducerId;
      }
    }
  });

  it("rehydrates producer identity and sequence from ~/.starcite state", async () => {
    const { logger } = makeLogger();
    const previousProducerId = process.env.STARCITE_PRODUCER_ID;
    Reflect.deleteProperty(process.env, "STARCITE_PRODUCER_ID");

    try {
      const program = buildProgram({
        logger,
        createClient: () => ({ create, session }) as never,
      });

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "append",
          "ses_123",
          "--agent",
          "researcher",
          "--text",
          "one",
        ],
        { from: "user" }
      );

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "append",
          "ses_123",
          "--agent",
          "researcher",
          "--text",
          "two",
        ],
        { from: "user" }
      );

      const firstCall = fakeSession.append.mock.calls[0]?.[0] as
        | { producerId?: string; producerSeq?: number }
        | undefined;
      const secondCall = fakeSession.append.mock.calls[1]?.[0] as
        | { producerId?: string; producerSeq?: number }
        | undefined;

      expect(firstCall?.producerId).toMatch(GENERATED_PRODUCER_ID_PATTERN);
      expect(secondCall?.producerId).toBe(firstCall?.producerId);
      expect(firstCall?.producerSeq).toBe(1);
      expect(secondCall?.producerSeq).toBe(2);
    } finally {
      if (previousProducerId === undefined) {
        Reflect.deleteProperty(process.env, "STARCITE_PRODUCER_ID");
      } else {
        process.env.STARCITE_PRODUCER_ID = previousProducerId;
      }
    }
  });

  it("reads base URL from config file", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn((baseUrl: string) => {
      expect(baseUrl).toBe("http://config.local:4100");
      return { create, session } as never;
    });

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ baseUrl: "http://config.local:4100" }, null, 2)
    );

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "create", "--title", "Draft contract"],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith("http://config.local:4100");
  });

  it("reads base URL from toml config file", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn((baseUrl: string) => {
      expect(baseUrl).toBe("http://config-toml.local:4200");
      return { create, session } as never;
    });

    writeFileSync(
      join(configDir, "config.toml"),
      'base_url = "http://config-toml.local:4200"\n'
    );

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "create", "--title", "Draft contract"],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith("http://config-toml.local:4200");
  });

  it("uses producer id from config file", async () => {
    const { logger } = makeLogger();

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ producerId: "producer:configured" }, null, 2)
    );

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
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

    const firstCall = fakeSession.append.mock.calls[0]?.[0] as
      | { producerId?: string; producerSeq?: number }
      | undefined;
    expect(firstCall?.producerId).toBe("producer:configured");
    expect(firstCall?.producerSeq).toBe(1);
  });

  it("tails events and formats output", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session }) as never,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "tail", "ses_123", "--limit", "1"],
      {
        from: "user",
      }
    );

    expect(fakeSession.tail).toHaveBeenCalledWith({
      cursor: 0,
      agent: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(info).toEqual(["[drafter] Drafting clause 4.2..."]);
  });
});
