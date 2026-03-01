import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StarciteIdentity, type TailEvent } from "@starcite/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import starciteCliPackage from "../package.json";
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

function encodeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `test.${encoded}.sig`;
}

describe("starcite CLI", () => {
  const agent = vi.fn();
  const session = vi.fn();
  const listSessions = vi.fn();
  let configDir = "";
  const sessionToken = encodeJwt({
    session_id: "ses_123",
    tenant_id: "acme",
    principal_id: "agent:tester",
    principal_type: "agent",
  });

  const fakeSession: FakeSession = {
    id: "ses_123",
    record: { id: "ses_123", title: "Draft contract" },
    append: vi.fn(),
    appendRaw: vi.fn(),
    tail: vi.fn(),
  };

  function createFakeClient() {
    return { agent, session, listSessions } as never;
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "starcite-cli-test-"));
    agent.mockReset();
    session.mockReset();
    listSessions.mockReset();
    fakeSession.append.mockReset();
    fakeSession.appendRaw.mockReset();
    fakeSession.tail.mockReset();

    agent.mockImplementation(
      (options: { id: string }) =>
        new StarciteIdentity({
          tenantId: "acme",
          id: options.id,
          type: "agent",
        })
    );
    session.mockResolvedValue(fakeSession);
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
      seq: 1,
      last_seq: 1,
      deduped: false,
    });
    fakeSession.tail.mockImplementation(
      async (onEvent: (event: TailEvent) => void | Promise<void>) => {
        await onEvent({
          seq: 1,
          type: "content",
          payload: { text: "Drafting clause 4.2..." },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        });
      }
    );
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("creates sessions and prints the id", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "create",
        "--title",
        "Draft contract",
      ],
      {
        from: "user",
      }
    );

    const createdSessionInput = session.mock.calls[0]?.[0] as
      | { identity: StarciteIdentity; id?: string; title?: string }
      | undefined;
    expect(createdSessionInput?.identity.toActor()).toBe("agent:starcite-cli");
    expect(createdSessionInput?.id).toBeUndefined();
    expect(createdSessionInput?.title).toBe("Draft contract");
    expect(info).toEqual(["ses_123"]);
  });

  it("prints the CLI version", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({ logger });

    await program.parseAsync(["version"], {
      from: "user",
    });

    expect(info).toEqual([starciteCliPackage.version]);
  });

  it("supports -v / --version", async () => {
    const output: string[] = [];
    const program = buildProgram({
      logger: {
        info() {
          // Intentionally silent in this test.
        },
        error() {
          // Intentionally silent in this test.
        },
      },
    });

    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => output.push(text),
      writeErr: () => {
        // Intentionally silent in this test.
      },
    });

    await expect(
      program.parseAsync(["node", "starcite", "--version"], {
        from: "user",
      })
    ).rejects.toHaveProperty("code", "commander.version");

    expect(output.join("")).toContain(starciteCliPackage.version);
  });

  it("includes version command and --version option in help", async () => {
    const output: string[] = [];
    const program = buildProgram({
      logger: {
        info() {
          // Intentionally silent in this test.
        },
        error() {
          // Intentionally silent in this test.
        },
      },
    });

    program.exitOverride();
    program.configureOutput({
      writeOut: (text) => output.push(text),
      writeErr: () => {
        // Intentionally silent in this test.
      },
    });

    await expect(
      program.parseAsync(["node", "starcite", "--help"], {
        from: "user",
      })
    ).rejects.toHaveProperty("code", "commander.helpDisplayed");

    const help = output.join("");
    expect(help).toContain("version  ");
    expect(help).toContain("-v, --version");
  });

  it("appends in high-level mode", async () => {
    const { logger, info } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
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

    expect(session).toHaveBeenCalledWith({
      token: sessionToken,
      id: "ses_123",
    });
    expect(fakeSession.append).toHaveBeenCalledWith({
      type: "content",
      text: "Found 8 relevant cases...",
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(info).toContain("seq=1 last_seq=1 deduped=false");
  });

  it("auto-generates producer id when missing", async () => {
    const { logger } = makeLogger();
    const previousProducerId = process.env.STARCITE_PRODUCER_ID;
    Reflect.deleteProperty(process.env, "STARCITE_PRODUCER_ID");

    try {
      const program = buildProgram({
        logger,
        createClient: () => createFakeClient(),
      });

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--token",
          sessionToken,
          "append",
          "ses_123",
          "--actor",
          "agent:researcher",
          "--payload",
          '{"text":"Found 8 relevant cases..."}',
        ],
        {
          from: "user",
        }
      );

      const firstCall = fakeSession.appendRaw.mock.calls[0]?.[0] as
        | { producer_id?: string; producer_seq?: number }
        | undefined;
      expect(firstCall?.producer_id).toMatch(GENERATED_PRODUCER_ID_PATTERN);
      expect(firstCall?.producer_seq).toBe(1);
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
        createClient: () => createFakeClient(),
      });

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--token",
          sessionToken,
          "append",
          "ses_123",
          "--actor",
          "agent:researcher",
          "--payload",
          '{"text":"one"}',
        ],
        { from: "user" }
      );

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--token",
          sessionToken,
          "append",
          "ses_123",
          "--actor",
          "agent:researcher",
          "--payload",
          '{"text":"two"}',
        ],
        { from: "user" }
      );

      const firstCall = fakeSession.appendRaw.mock.calls[0]?.[0] as
        | { producer_id?: string; producer_seq?: number }
        | undefined;
      const secondCall = fakeSession.appendRaw.mock.calls[1]?.[0] as
        | { producer_id?: string; producer_seq?: number }
        | undefined;

      expect(firstCall?.producer_id).toMatch(GENERATED_PRODUCER_ID_PATTERN);
      expect(secondCall?.producer_id).toBe(firstCall?.producer_id);
      expect(firstCall?.producer_seq).toBe(1);
      expect(secondCall?.producer_seq).toBe(2);
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
      return createFakeClient();
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
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "create",
        "--title",
        "Draft contract",
      ],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith(
      "http://config.local:4100",
      sessionToken
    );
  });

  it("reads base URL from toml config file", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn((baseUrl: string) => {
      expect(baseUrl).toBe("http://config-toml.local:4200");
      return createFakeClient();
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
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "create",
        "--title",
        "Draft contract",
      ],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith(
      "http://config-toml.local:4200",
      sessionToken
    );
  });

  it("uses producer id from config file", async () => {
    const { logger } = makeLogger();

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ producerId: "producer:configured" }, null, 2)
    );

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "append",
        "ses_123",
        "--actor",
        "agent:researcher",
        "--payload",
        '{"text":"Found 8 relevant cases..."}',
      ],
      {
        from: "user",
      }
    );

    const firstCall = fakeSession.appendRaw.mock.calls[0]?.[0] as
      | { producer_id?: string; producer_seq?: number }
      | undefined;
    expect(firstCall?.producer_id).toBe("producer:configured");
    expect(firstCall?.producer_seq).toBe(1);
  });

  it("config set api-key persists saved API key", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", "sk_test_123"],
      {
        from: "user",
      }
    );

    const credentialsFile = JSON.parse(
      readFileSync(join(configDir, "credentials.json"), "utf8")
    ) as { apiKey?: string };

    expect(credentialsFile.apiKey).toBe("sk_test_123");
  });

  it("config set endpoint persists base URL", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
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

  it("config set api-key stores API key used by API commands", async () => {
    const { logger } = makeLogger();
    const authToken = encodeJwt({
      tenant_id: "acme",
      scopes: [
        "session:create",
        "session:read",
        "session:append",
        "auth:issue",
      ],
    });
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(authToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", authToken],
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
      authToken
    );
  });

  it("append uses SDK identity session binding when API key has auth:issue", async () => {
    const { logger, info } = makeLogger();
    const serviceToken = encodeJwt({
      tenant_id: "acme",
      scopes: ["session:create", "session:read", "auth:issue"],
    });
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", serviceToken],
      {
        from: "user",
      }
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
        "Found 8 relevant cases...",
      ],
      {
        from: "user",
      }
    );

    const appendSessionInput = session.mock.calls[0]?.[0] as
      | { identity: StarciteIdentity; id: string }
      | undefined;
    expect(appendSessionInput?.id).toBe("ses_123");
    expect(appendSessionInput?.identity.toActor()).toBe("agent:researcher");
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      serviceToken
    );
    expect(info).toContain("seq=1 last_seq=1 deduped=false");
  });

  it("append uses the configured API key when token scopes cannot be inferred", async () => {
    const { logger, info } = makeLogger();
    const opaqueToken = "sk_service_opaque_token";
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(opaqueToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", opaqueToken],
      {
        from: "user",
      }
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
        "Found 8 relevant cases...",
      ],
      {
        from: "user",
      }
    );

    expect(session).toHaveBeenCalledWith({
      token: opaqueToken,
      id: "ses_123",
    });
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      opaqueToken
    );
    expect(info).toContain("seq=1 last_seq=1 deduped=false");
  });

  it("tail uses SDK identity session binding when API key has auth:issue", async () => {
    const { logger, info } = makeLogger();
    const serviceToken = encodeJwt({
      tenant_id: "acme",
      scopes: ["session:create", "session:read", "auth:issue"],
    });
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", serviceToken],
      {
        from: "user",
      }
    );

    await program.parseAsync(
      ["--config-dir", configDir, "tail", "ses_123", "--limit", "1"],
      {
        from: "user",
      }
    );

    const tailSessionInput = session.mock.calls[0]?.[0] as
      | { identity: StarciteIdentity; id: string }
      | undefined;
    expect(tailSessionInput?.identity.toActor()).toBe("agent:starcite-cli");
    expect(tailSessionInput?.id).toBe("ses_123");
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      serviceToken
    );
    expect(info).toContain("[drafter] Drafting clause 4.2...");
  });

  it("global --token overrides stored API key", async () => {
    const { logger } = makeLogger();
    const overrideToken = encodeJwt({
      tenant_id: "override-tenant",
      scopes: [
        "session:create",
        "session:read",
        "session:append",
        "auth:issue",
      ],
    });
    const createClient = vi.fn((baseUrl: string, _apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", "sk_saved_123"],
      {
        from: "user",
      }
    );

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        overrideToken,
        "create",
        "--title",
        "Draft contract",
      ],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenLastCalledWith(
      "http://localhost:45187",
      overrideToken
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "tail",
        "ses_123",
        "--limit",
        "1",
      ],
      {
        from: "user",
      }
    );

    expect(session).toHaveBeenCalledWith({
      token: sessionToken,
      id: "ses_123",
    });
    expect(fakeSession.tail).toHaveBeenCalledWith(expect.any(Function), {
      cursor: 0,
      batchSize: 256,
      agent: undefined,
      follow: true,
      signal: expect.any(AbortSignal),
    });
    expect(info).toEqual(["[drafter] Drafting clause 4.2..."]);
  });

  it("tail --limit applies a hard cap even when multiple events arrive in one callback stream", async () => {
    const { logger, info } = makeLogger();

    fakeSession.tail.mockImplementation(
      async (onEvent: (event: TailEvent) => void | Promise<void>) => {
        await onEvent({
          seq: 1,
          type: "content",
          payload: { text: "first event" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 1,
        });
        await onEvent({
          seq: 2,
          type: "content",
          payload: { text: "second event" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 2,
        });
      }
    );

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        sessionToken,
        "tail",
        "ses_123",
        "--limit",
        "1",
      ],
      {
        from: "user",
      }
    );

    expect(info).toEqual(["[drafter] first event"]);
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
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
      createClient: () => createFakeClient(),
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
