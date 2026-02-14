import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@starcite/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli";
import type { CommandResult, PromptAdapter } from "../src/up";

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
  const listSessions = vi.fn();
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
    listSessions.mockReset();
    fakeSession.append.mockReset();
    fakeSession.appendRaw.mockReset();
    fakeSession.tail.mockReset();

    create.mockResolvedValue(fakeSession);
    session.mockReturnValue(fakeSession);
    listSessions.mockResolvedValue({
      sessions: [
        {
          id: "ses_123",
          title: "Draft contract",
          metadata: { tenant_id: "acme" },
          created_at: "2026-02-13T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
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
      createClient: () => ({ create, session, listSessions }) as never,
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
      createClient: () => ({ create, session, listSessions }) as never,
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
        createClient: () => ({ create, session, listSessions }) as never,
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
        createClient: () => ({ create, session, listSessions }) as never,
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
      createClient: () => ({ create, session, listSessions }) as never,
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

  it("init writes endpoint config and saved API key", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "init",
        "--yes",
        "--endpoint",
        "https://cust-a.starcite.io",
        "--api-key",
        "sk_test_123",
      ],
      {
        from: "user",
      }
    );

    const configFile = JSON.parse(
      readFileSync(join(configDir, "config.json"), "utf8")
    ) as { baseUrl?: string };
    const credentialsFile = JSON.parse(
      readFileSync(join(configDir, "credentials.json"), "utf8")
    ) as { apiKey?: string };

    expect(configFile.baseUrl).toBe("https://cust-a.starcite.io");
    expect(credentialsFile.apiKey).toBe("sk_test_123");
  });

  it("config set endpoint persists base URL", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "config",
        "set",
        "endpoint",
        "https://tenant-a.starcite.io/",
      ],
      {
        from: "user",
      }
    );

    const configFile = JSON.parse(
      readFileSync(join(configDir, "config.json"), "utf8")
    ) as { baseUrl?: string };

    expect(configFile.baseUrl).toBe("https://tenant-a.starcite.io");
  });

  it("auth login stores API key used by API commands", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe("sk_auth_123");
      return { create, session } as never;
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "auth", "login", "--api-key", "sk_auth_123"],
      {
        from: "user",
      }
    );

    await program.parseAsync(
      ["--config-dir", configDir, "create", "--title", "Draft contract"],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      "sk_auth_123"
    );
  });

  it("sessions list supports limit/cursor/metadata filters", async () => {
    const { logger, info } = makeLogger();

    listSessions.mockResolvedValue({
      sessions: [
        {
          id: "ses_101",
          title: "Alpha",
          metadata: { tenant_id: "acme" },
          created_at: "2026-02-13T01:00:00Z",
        },
        {
          id: "ses_102",
          title: null,
          metadata: { tenant_id: "acme" },
          created_at: "2026-02-13T01:05:00Z",
        },
      ],
      next_cursor: "ses_102",
    });

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "sessions",
        "list",
        "--limit",
        "2",
        "--cursor",
        "ses_100",
        "--metadata",
        '{"tenant_id":"acme"}',
      ],
      {
        from: "user",
      }
    );

    expect(listSessions).toHaveBeenCalledWith({
      limit: 2,
      cursor: "ses_100",
      metadata: { tenant_id: "acme" },
    });
    expect(info).toEqual([
      "id\ttitle\tcreated_at",
      "ses_101\tAlpha\t2026-02-13T01:00:00Z",
      "ses_102\t\t2026-02-13T01:05:00Z",
      "next_cursor=ses_102",
    ]);
  });

  it("sessions list outputs JSON with --json", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "--json", "sessions", "list"],
      {
        from: "user",
      }
    );

    const output = JSON.parse(info[0] ?? "{}") as {
      sessions?: Array<{ id?: string }>;
      next_cursor?: string | null;
    };

    expect(output.sessions?.[0]?.id).toBe("ses_123");
    expect(output.next_cursor).toBeNull();
  });

  it("tails events and formats output", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => ({ create, session, listSessions }) as never,
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

  it("up fails with install guidance when docker is missing", async () => {
    const { logger, error } = makeLogger();
    const runCommand = vi
      .fn<(command: string, args: string[]) => Promise<CommandResult>>()
      .mockResolvedValue({
        code: 127,
        stdout: "",
        stderr: "docker: command not found",
      });
    const prompt: PromptAdapter = {
      confirm: vi.fn(),
      input: vi.fn(),
    };

    const program = buildProgram({
      logger,
      runCommand,
      prompt,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await expect(
      program.parseAsync(["--config-dir", configDir, "up"], {
        from: "user",
      })
    ).rejects.toThrow("Docker is required");
    expect(error).toContain(
      "You don't have Docker installed, please install it."
    );
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it("up can be cancelled after confirmation", async () => {
    const { logger, info } = makeLogger();
    const runCommand = vi
      .fn<(command: string, args: string[]) => Promise<CommandResult>>()
      .mockImplementation((_command, args) => {
        if (
          args.join(" ") === "--version" ||
          args.join(" ") === "compose version" ||
          args.join(" ") === "info"
        ) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }

        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "unexpected command",
        });
      });
    const prompt: PromptAdapter = {
      confirm: vi.fn().mockResolvedValue(false),
      input: vi.fn(),
    };

    const program = buildProgram({
      logger,
      runCommand,
      prompt,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(["--config-dir", configDir, "up"], {
      from: "user",
    });

    expect(info).toContain("Cancelled.");
    expect(runCommand).not.toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "-d"],
      expect.anything()
    );
  });

  it("up runs compose with prompted port", async () => {
    const { logger, info } = makeLogger();
    const runCommand = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { cwd?: string }
        ) => Promise<CommandResult>
      >()
      .mockImplementation((_command, args) => {
        if (
          args.join(" ") === "--version" ||
          args.join(" ") === "compose version" ||
          args.join(" ") === "info"
        ) {
          return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
        }

        if (args.join(" ") === "compose up -d") {
          return Promise.resolve({ code: 0, stdout: "started", stderr: "" });
        }

        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "unexpected command",
        });
      });
    const prompt: PromptAdapter = {
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn().mockResolvedValue("4510"),
    };

    const program = buildProgram({
      logger,
      runCommand,
      prompt,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(["--config-dir", configDir, "up"], {
      from: "user",
    });

    const runtimeDirectory = join(configDir, "runtime");
    const envFile = readFileSync(join(runtimeDirectory, ".env"), "utf8");
    const composeFile = readFileSync(
      join(runtimeDirectory, "docker-compose.yml"),
      "utf8"
    );

    expect(envFile).toContain("STARCITE_API_PORT=4510");
    expect(composeFile).toContain("services:");
    expect(prompt.confirm).toHaveBeenCalledWith(
      "Are you sure you want to create the docker containers?",
      true
    );
    expect(prompt.input).toHaveBeenCalledWith(
      "What port do you want it on?",
      "45187"
    );
    expect(runCommand).toHaveBeenCalledWith("docker", ["compose", "up", "-d"], {
      cwd: runtimeDirectory,
    });
    expect(info).toContain("Starcite is starting on http://localhost:4510");
  });

  it("down can be cancelled at confirmation", async () => {
    const { logger, info } = makeLogger();
    const runtimeDirectory = join(configDir, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(runtimeDirectory, ".keep"), "1");

    const runCommand = vi
      .fn<(command: string, args: string[]) => Promise<CommandResult>>()
      .mockImplementation((_command, args) => {
        if (
          args.join(" ") === "--version" ||
          args.join(" ") === "compose version" ||
          args.join(" ") === "info"
        ) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }

        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "unexpected command",
        });
      });
    const prompt: PromptAdapter = {
      confirm: vi.fn().mockResolvedValue(false),
      input: vi.fn(),
    };

    const program = buildProgram({
      logger,
      runCommand,
      prompt,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(["--config-dir", configDir, "down"], {
      from: "user",
    });

    expect(prompt.confirm).toHaveBeenCalledWith(
      "Are you sure you want to stop and delete Starcite containers and volumes?",
      false
    );
    expect(info).toContain("Cancelled.");
    expect(runCommand).not.toHaveBeenCalledWith(
      "docker",
      ["compose", "down", "--remove-orphans", "-v"],
      expect.anything()
    );
  });

  it("down nukes containers and volumes by default", async () => {
    const { logger, info } = makeLogger();
    const runtimeDirectory = join(configDir, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(runtimeDirectory, ".keep"), "1");

    const runCommand = vi
      .fn<
        (
          command: string,
          args: string[],
          options?: { cwd?: string }
        ) => Promise<CommandResult>
      >()
      .mockImplementation((_command, args) => {
        if (
          args.join(" ") === "--version" ||
          args.join(" ") === "compose version" ||
          args.join(" ") === "info"
        ) {
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }

        if (args.join(" ") === "compose down --remove-orphans -v") {
          return Promise.resolve({ code: 0, stdout: "down", stderr: "" });
        }

        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "unexpected command",
        });
      });
    const prompt: PromptAdapter = {
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn(),
    };

    const program = buildProgram({
      logger,
      runCommand,
      prompt,
      createClient: () => ({ create, session, listSessions }) as never,
    });

    await program.parseAsync(["--config-dir", configDir, "down"], {
      from: "user",
    });

    expect(runCommand).toHaveBeenCalledWith(
      "docker",
      ["compose", "down", "--remove-orphans", "-v"],
      { cwd: runtimeDirectory }
    );
    expect(info).toContain("Starcite containers stopped.");
    expect(info).toContain("Starcite volumes removed.");
  });
});
