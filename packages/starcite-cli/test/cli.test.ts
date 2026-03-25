import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type SessionEvent,
  SessionLogConflictError,
  StarciteIdentity,
} from "@starcite/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli";
import { StarciteCliStore } from "../src/store";

interface FakeSession {
  readonly id: string;
  readonly token: string;
  readonly identity: StarciteIdentity;
  readonly record?: { id: string; title?: string };
  append: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  log: {
    hydrate: ReturnType<typeof vi.fn>;
  };
}

function createOnMock(input: {
  error?: Error;
  events?: SessionEvent[];
}): ReturnType<typeof vi.fn> {
  return vi.fn((eventName, listener, options) => {
    if (eventName === "event") {
      queueMicrotask(() => {
        if (input.error) {
          return;
        }

        for (const event of input.events ?? []) {
          if (
            options?.agent &&
            event.actor !== `agent:${options.agent as string}`
          ) {
            continue;
          }

          listener(event, { phase: "live", replayed: false });
        }
      });
    }

    if (eventName === "error" && input.error) {
      queueMicrotask(() => {
        listener(input.error);
      });
    }

    return () => undefined;
  });
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

function makeStdout() {
  const messages: string[] = [];

  return {
    messages,
    stdout: {
      write(message: string) {
        messages.push(message);
      },
    },
  };
}

function encodeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `test.${encoded}.sig`;
}

function writeCredentials(configDir: string, apiKey: string): void {
  writeFileSync(
    join(configDir, "credentials.json"),
    `${JSON.stringify({ apiKey }, null, 2)}\n`
  );
}

describe("starcite CLI", () => {
  const agent = vi.fn();
  const user = vi.fn();
  const session = vi.fn();
  const listSessions = vi.fn();
  let configDir = "";
  let previousApiKey: string | undefined;
  const serviceToken = encodeJwt({
    tenant_id: "acme",
    scopes: ["session:create", "session:read", "session:append"],
  });
  const sessionToken = encodeJwt({
    session_id: "ses_123",
    tenant_id: "acme",
    principal_id: "researcher",
    principal_type: "agent",
  });

  const fakeSession: FakeSession = {
    id: "ses_123",
    token: sessionToken,
    identity: new StarciteIdentity({
      tenantId: "acme",
      id: "researcher",
      type: "agent",
    }),
    record: { id: "ses_123", title: "Draft contract" },
    append: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
    log: {
      hydrate: vi.fn(),
    },
  };

  function createFakeClient() {
    return { agent, user, session, listSessions } as never;
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "starcite-cli-test-"));
    previousApiKey = process.env.STARCITE_API_KEY;
    Reflect.deleteProperty(process.env, "STARCITE_API_KEY");
    agent.mockReset();
    user.mockReset();
    session.mockReset();
    listSessions.mockReset();
    fakeSession.append.mockReset();
    fakeSession.on.mockReset();
    fakeSession.disconnect.mockReset();
    fakeSession.log.hydrate.mockReset();

    agent.mockImplementation(
      (options: { id: string }) =>
        new StarciteIdentity({
          tenantId: "acme",
          id: options.id,
          type: "agent",
        })
    );
    user.mockImplementation(
      (options: { id: string }) =>
        new StarciteIdentity({
          tenantId: "acme",
          id: options.id,
          type: "user",
        })
    );
    session.mockImplementation(
      (
        input:
          | { token: string }
          | { identity: StarciteIdentity; id?: string; title?: string }
      ) =>
        ({
          ...fakeSession,
          token: "token" in input ? input.token : fakeSession.token,
          identity: "identity" in input ? input.identity : fakeSession.identity,
        }) as never
    );
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
    fakeSession.on.mockImplementation(
      createOnMock({
        events: [
          {
            seq: 1,
            type: "content",
            payload: { text: "Drafting clause 4.2..." },
            actor: "agent:drafter",
            producer_id: "producer:drafter",
            producer_seq: 1,
          },
        ],
      })
    );
  });

  afterEach(() => {
    if (previousApiKey === undefined) {
      Reflect.deleteProperty(process.env, "STARCITE_API_KEY");
    } else {
      process.env.STARCITE_API_KEY = previousApiKey;
    }
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
        serviceToken,
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

  it("create --json writes JSON directly to stdout", async () => {
    const { logger, info } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "--json",
        "create",
        "--title",
        "Draft contract",
      ],
      {
        from: "user",
      }
    );

    const created = JSON.parse(messages.join("")) as { id?: string };
    expect(created.id).toBe("ses_123");
    expect(info).toEqual([]);
  });

  it("create --id persists an explicit session id", async () => {
    const { logger, info } = makeLogger();
    session.mockImplementationOnce(
      (input: { id?: string }) =>
        ({
          ...fakeSession,
          id: input.id ?? fakeSession.id,
          record:
            input.id === undefined
              ? fakeSession.record
              : {
                  id: input.id,
                  title: "Draft contract",
                },
        }) as never
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
        serviceToken,
        "create",
        "--id",
        "ses_demo",
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
    expect(createdSessionInput).toEqual({
      id: "ses_demo",
      title: "Draft contract",
      metadata: undefined,
      identity: expect.any(StarciteIdentity),
    });
    expect(createdSessionInput?.identity.toActor()).toBe("agent:starcite-cli");
    expect(info).toEqual(["ses_demo"]);
  });

  it("--version prints the CLI version", async () => {
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
      program.parseAsync(["--version"], {
        from: "user",
      })
    ).rejects.toHaveProperty("code", "cli.versionDisplayed");

    const version = output.join("").trim();
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    const expectedVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    expect(version).toBe(expectedVersion);
  });

  it("help only exposes the supported commands", async () => {
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
    ).rejects.toHaveProperty("code", "cli.helpDisplayed");

    const help = output.join("");
    expect(help).toContain("create");
    expect(help).toContain("append");
    expect(help).toContain("tail");
    expect(help).toContain("sessions");
    expect(help).toContain("config");
    expect(help).not.toContain("\n  up ");
    expect(help).not.toContain("\n  down ");
    expect(help).not.toContain("\n  version ");
  });

  it("appends with --agent and --text shorthands", async () => {
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
        serviceToken,
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
      id: "ses_123",
      identity: expect.any(StarciteIdentity),
    });
    expect(fakeSession.append).toHaveBeenCalledWith({
      type: "content",
      payload: { text: "Found 8 relevant cases..." },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(info).toContain("seq=1 deduped=false");
  });

  it("append --json writes JSON directly to stdout", async () => {
    const { logger, info } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "--json",
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

    const appendResult = JSON.parse(messages.join("")) as { seq?: number };
    expect(appendResult.seq).toBe(1);
    expect(info).toEqual([]);
  });

  it("appends with --agent and --payload", async () => {
    const { logger } = makeLogger();
    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--payload",
        '{"text":"Found 8 relevant cases...","section":"4.2"}',
      ],
      {
        from: "user",
      }
    );

    expect(fakeSession.append).toHaveBeenCalledWith({
      type: "content",
      payload: { text: "Found 8 relevant cases...", section: "4.2" },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
  });

  it("normalizes mixed append shorthands through session.append", async () => {
    const { logger } = makeLogger();
    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--payload",
        '{"text":"one","section":"4.2"}',
      ],
      { from: "user" }
    );

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--text",
        "two",
      ],
      { from: "user" }
    );

    expect(fakeSession.append).toHaveBeenNthCalledWith(1, {
      type: "content",
      payload: { text: "one", section: "4.2" },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(fakeSession.append).toHaveBeenNthCalledWith(2, {
      type: "content",
      payload: { text: "two" },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
  });

  it("passes the CLI store into the SDK client for high-level appends", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn(
      (_baseUrl: string, _apiKey?: string, store?: StarciteCliStore) => {
        expect(store).toBeDefined();
        const sessionStore = store?.sessionStore("http://localhost:45187/v1");
        expect(typeof sessionStore?.load).toBe("function");
        expect(typeof sessionStore?.save).toBe("function");
        return createFakeClient();
      }
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
        serviceToken,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--text",
        "same text",
      ],
      { from: "user" }
    );

    expect(createClient).toHaveBeenCalled();
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
        serviceToken,
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
      serviceToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
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
        serviceToken,
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
      serviceToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
  });

  it("stored credentials are used by API commands", async () => {
    const { logger } = makeLogger();
    const authToken = encodeJwt({
      tenant_id: "acme",
      scopes: ["session:create", "session:read", "session:append"],
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

    writeCredentials(configDir, authToken);

    await program.parseAsync(
      ["--config-dir", configDir, "create", "--title", "Draft contract"],
      {
        from: "user",
      }
    );

    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      authToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
  });

  it("append binds an agent identity through client.session", async () => {
    const { logger, info } = makeLogger();
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    writeCredentials(configDir, serviceToken);

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
    expect(fakeSession.append).toHaveBeenCalledWith({
      type: "content",
      payload: { text: "Found 8 relevant cases..." },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      serviceToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
    expect(info).toContain("seq=1 deduped=false");
  });

  it("append binds user identities through client.session", async () => {
    const { logger, info } = makeLogger();
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    writeCredentials(configDir, serviceToken);

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "append",
        "ses_123",
        "--user",
        "alice",
        "--payload",
        '{"text":"Found 8 relevant cases...","reviewer":"alice"}',
      ],
      {
        from: "user",
      }
    );

    const appendSessionInput = session.mock.calls[0]?.[0] as
      | { identity: StarciteIdentity; id: string }
      | undefined;
    expect(appendSessionInput?.id).toBe("ses_123");
    expect(appendSessionInput?.identity.toActor()).toBe("user:alice");
    expect(fakeSession.append).toHaveBeenCalledWith({
      type: "content",
      payload: { text: "Found 8 relevant cases...", reviewer: "alice" },
      source: undefined,
      metadata: undefined,
      refs: undefined,
      idempotencyKey: undefined,
      expectedSeq: undefined,
    });
    expect(info).toContain("seq=1 deduped=false");
  });

  it("rejects both identity flags at once", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await expect(
      program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--token",
          serviceToken,
          "append",
          "ses_123",
          "--agent",
          "researcher",
          "--user",
          "alice",
          "--text",
          "Found 8 relevant cases...",
        ],
        {
          from: "user",
        }
      )
    ).rejects.toThrow("Choose either --agent or --user, not both");
  });

  it("rejects both payload shorthands at once", async () => {
    const { logger } = makeLogger();

    const program = buildProgram({
      logger,
      createClient: () => createFakeClient(),
    });

    await expect(
      program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--token",
          serviceToken,
          "append",
          "ses_123",
          "--agent",
          "researcher",
          "--text",
          "Found 8 relevant cases...",
          "--payload",
          '{"text":"duplicate"}',
        ],
        {
          from: "user",
        }
      )
    ).rejects.toThrow("Choose either --text or --payload, not both");
  });

  it("append always binds the same agent identity through client.session", async () => {
    const { logger } = makeLogger();
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    writeCredentials(configDir, serviceToken);

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "append",
        "ses_123",
        "--agent",
        "researcher",
        "--text",
        "first",
      ],
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
        "second",
      ],
      {
        from: "user",
      }
    );

    expect(session).toHaveBeenNthCalledWith(1, {
      identity: expect.any(StarciteIdentity),
      id: "ses_123",
    });
    expect(session).toHaveBeenNthCalledWith(2, {
      identity: expect.any(StarciteIdentity),
      id: "ses_123",
    });
  });

  it("append does not inspect token shape before binding a session", async () => {
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

    writeCredentials(configDir, opaqueToken);

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
      id: "ses_123",
      identity: expect.any(StarciteIdentity),
    });
    expect(createClient).toHaveBeenCalledWith(
      "http://localhost:45187",
      opaqueToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
    expect(info).toContain("seq=1 deduped=false");
  });

  it("tail binds the default CLI identity through client.session", async () => {
    const { logger, info } = makeLogger();
    const createClient = vi.fn((baseUrl: string, apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      expect(apiKey).toBe(serviceToken);
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    writeCredentials(configDir, serviceToken);

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
      serviceToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
    expect(info).toContain("[drafter] Drafting clause 4.2...");
  });

  it("global --token overrides stored API key", async () => {
    const { logger } = makeLogger();
    const overrideToken = encodeJwt({
      tenant_id: "override-tenant",
      scopes: ["session:create", "session:read", "session:append"],
    });
    const createClient = vi.fn((baseUrl: string, _apiKey?: string) => {
      expect(baseUrl).toBe("http://localhost:45187");
      return createFakeClient();
    });

    const program = buildProgram({
      logger,
      createClient,
    });

    writeCredentials(configDir, "sk_saved_123");

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
      overrideToken,
      expect.objectContaining({
        load: expect.any(Function),
        save: expect.any(Function),
      })
    );
  });

  it("sessions list supports limit/cursor/metadata filters", async () => {
    const { logger, info, error } = makeLogger();

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
    expect(error).toEqual([
      "Warning: `sessions list` is a bad call to use in production.",
    ]);
    expect(info).toEqual([
      "id\ttitle\tcreated_at",
      "ses_101\tAlpha\t2026-02-13T01:00:00Z",
      "ses_102\t\t2026-02-13T01:05:00Z",
      "next_cursor=ses_102",
    ]);
  });

  it("sessions list outputs JSON with --json", async () => {
    const { logger, info, error } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      ["--config-dir", configDir, "--json", "sessions", "list"],
      {
        from: "user",
      }
    );

    const output = JSON.parse(messages.join("")) as {
      sessions?: Array<{ id?: string }>;
      next_cursor?: string | null;
    };

    expect(output.sessions?.[0]?.id).toBe("ses_123");
    expect(output.next_cursor).toBeNull();
    expect(info).toEqual([]);
    expect(error).toEqual([
      "Warning: `sessions list` is a bad call to use in production.",
    ]);
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
        serviceToken,
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
      id: "ses_123",
      identity: expect.any(StarciteIdentity),
    });
    expect(fakeSession.on).toHaveBeenCalledWith("event", expect.any(Function), {
      agent: undefined,
    });
    expect(info).toEqual(["[drafter] Drafting clause 4.2..."]);
  });

  it("tail clears stale local session cache and retries once", async () => {
    const { logger, info, error } = makeLogger();
    let capturedStore: StarciteCliStore | undefined;
    let sessionCalls = 0;

    const staleSession: FakeSession = {
      ...fakeSession,
      append: vi.fn(),
      on: createOnMock({
        error: new SessionLogConflictError(
          "Session log conflict for seq 1: received different payload for an already-applied event"
        ),
      }),
    };

    const recoveredSession: FakeSession = {
      ...fakeSession,
      append: vi.fn(),
      on: createOnMock({
        events: [
          {
            seq: 1,
            type: "content",
            payload: { text: "recovered event" },
            actor: "agent:drafter",
            producer_id: "producer:drafter",
            producer_seq: 1,
          },
        ],
      }),
    };

    const program = buildProgram({
      logger,
      createClient: (_baseUrl, _apiKey, store) => {
        capturedStore = store;
        store.sessionStore("http://localhost:45187").save("ses_123", {
          cursor: { epoch: 1, seq: 1 },
          lastSeq: 1,
          events: [
            {
              seq: 1,
              type: "content",
              payload: { text: "stale event" },
              actor: "agent:drafter",
              producer_id: "producer:drafter",
              producer_seq: 1,
            },
          ],
          metadata: {
            schemaVersion: 4,
            updatedAtMs: Date.now(),
          },
        });

        return {
          agent,
          user,
          listSessions,
          session: vi.fn(
            () =>
              (sessionCalls++ === 0 ? staleSession : recoveredSession) as never
          ),
        } as never;
      },
    });

    writeCredentials(configDir, serviceToken);

    await program.parseAsync(
      ["--config-dir", configDir, "tail", "ses_123", "--limit", "1"],
      {
        from: "user",
      }
    );

    expect(info).toEqual(["[drafter] recovered event"]);
    expect(error).toEqual([
      "Warning: cleared stale local session cache for 'ses_123' and retried tail.",
    ]);
    expect(
      capturedStore?.sessionStore("http://localhost:45187").load("ses_123")
    ).toBeUndefined();
  });

  it("tail --limit applies a hard cap even when multiple events arrive in one callback stream", async () => {
    const { logger, info } = makeLogger();

    fakeSession.on.mockImplementation(
      createOnMock({
        events: [
          {
            seq: 1,
            type: "content",
            payload: { text: "first event" },
            actor: "agent:drafter",
            producer_id: "producer:drafter",
            producer_seq: 1,
          },
          {
            seq: 2,
            type: "content",
            payload: { text: "second event" },
            actor: "agent:drafter",
            producer_id: "producer:drafter",
            producer_seq: 2,
          },
        ],
      })
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
        serviceToken,
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

  it("tail --json writes JSON directly to stdout", async () => {
    const { logger, info } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      [
        "--config-dir",
        configDir,
        "--token",
        serviceToken,
        "--json",
        "tail",
        "ses_123",
        "--limit",
        "1",
      ],
      {
        from: "user",
      }
    );

    const event = JSON.parse(messages.join("").trim()) as {
      actor?: string;
      seq?: number;
    };
    expect(event.actor).toBe("agent:drafter");
    expect(event.seq).toBe(1);
    expect(info).toEqual([]);
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

  it("clears existing local session cache on store version mismatch", () => {
    writeFileSync(
      join(configDir, "state.json"),
      `${JSON.stringify(
        {
          __starciteCliStoreVersion: "1",
          "https://anor-ai.starcite.io/v1::ses_123":
            '{"cursor":1,"events":[],"metadata":{"schemaVersion":2,"updatedAtMs":1}}',
        },
        null,
        2
      )}\n`
    );

    new StarciteCliStore(configDir);

    const stateFile = JSON.parse(
      readFileSync(join(configDir, "state.json"), "utf8")
    ) as Record<string, unknown>;

    expect(
      stateFile["https://anor-ai.starcite.io/v1::ses_123"]
    ).toBeUndefined();
    expect(stateFile.__starciteCliStoreVersion).toBe("2");
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

  it("config show --json writes JSON directly to stdout", async () => {
    const { logger, info } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => createFakeClient(),
    });

    await program.parseAsync(
      ["--config-dir", configDir, "--json", "config", "show"],
      {
        from: "user",
      }
    );

    const output = JSON.parse(messages.join("")) as {
      endpoint?: string;
      configDir?: string;
    };

    expect(output.endpoint).toBe("http://localhost:45187");
    expect(output.configDir).toBe(configDir);
    expect(info).toEqual([]);
  });

  it("config show works with a stored placeholder API key", async () => {
    const { logger, info } = makeLogger();
    const { stdout, messages } = makeStdout();

    const program = buildProgram({
      logger,
      stdout,
      createClient: () => {
        throw new Error("config commands should not create a client");
      },
    });

    await program.parseAsync(
      ["--config-dir", configDir, "config", "set", "api-key", "sk_test_123"],
      {
        from: "user",
      }
    );

    await program.parseAsync(
      ["--config-dir", configDir, "--json", "config", "show"],
      {
        from: "user",
      }
    );

    const output = JSON.parse(messages.join("")) as {
      apiKey?: string | null;
      apiKeySource?: string;
    };

    expect(output.apiKey).toBe("***");
    expect(output.apiKeySource).toBe("stored");
    expect(info).toEqual(["API key saved."]);
  });
});
