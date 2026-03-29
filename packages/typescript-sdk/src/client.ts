import EventEmitter from "eventemitter3";
import { decodeApiKeyContext, decodeSessionToken } from "./auth";
import { StarciteApiError, StarciteError } from "./errors";
import { StarciteIdentity } from "./identity";
import { LifecycleRuntime } from "./lifecycle-runtime";
import { StarciteSession } from "./session";
import { SocketManager } from "./socket-manager";
import type { TransportConfig } from "./transport";
import {
  parseHttpUrl,
  request,
  requestWithBaseUrl,
  toApiBaseUrl,
  toWebSocketBaseUrl,
} from "./transport";
import {
  type IssueSessionTokenInput,
  IssueSessionTokenResponseSchema,
  type RequestOptions,
  type SessionAppendOptions,
  type SessionCreatedLifecycleEvent,
  type SessionListOptions,
  type SessionListPage,
  SessionListPageSchema,
  type SessionLogOptions,
  type SessionRecord,
  SessionRecordSchema,
  type SessionStore,
  type StarciteOptions,
} from "./types";

const LIFECYCLE_AUTH_ERROR_MESSAGE =
  "starcite.on() requires StarciteOptions.apiKey. Lifecycle events are backend-only and authenticate with the server API key, not a minted session token.";

/**
 * Resolves auth issuer base URL in this order:
 * explicit option -> env -> API key JWT issuer authority.
 */
function resolveAuthBaseUrl(
  explicitAuthUrl: string | undefined,
  issuerAuthority: string | undefined
): string | undefined {
  const value =
    explicitAuthUrl ??
    globalThis.process?.env?.STARCITE_AUTH_URL ??
    issuerAuthority;
  if (!value) {
    return undefined;
  }

  return parseHttpUrl(value).toString();
}

function mergeAppendOptions(
  defaults: SessionAppendOptions | undefined,
  overrides: SessionAppendOptions | undefined
): SessionAppendOptions | undefined {
  if (!defaults) {
    return overrides;
  }

  if (!overrides) {
    return defaults;
  }

  return {
    ...defaults,
    ...overrides,
    retryPolicy: {
      ...defaults.retryPolicy,
      ...overrides.retryPolicy,
    },
  };
}

interface StarciteLifecycleEvents {
  "session.created": (event: SessionCreatedLifecycleEvent) => void;
  error: (error: Error) => void;
}

/**
 * Tenant-scoped Starcite client.
 *
 * Create identities with {@link user} / {@link agent}, then bind them to
 * sessions with {@link session}.
 */
export class Starcite {
  /** Normalized API base URL ending with `/v1`. */
  readonly baseUrl: string;

  private readonly transport: TransportConfig;
  private readonly authBaseUrl?: string;
  private readonly inferredTenantId?: string;
  private readonly apiKey: string | undefined;
  private readonly socketUrl: string;
  private readonly store: SessionStore | undefined;
  private readonly appendOptions: SessionAppendOptions | undefined;
  private readonly lifecycle = new EventEmitter<StarciteLifecycleEvents>();
  private lifecycleRuntime: LifecycleRuntime | undefined;
  private lifecycleRefs = 0;

  constructor(options: StarciteOptions = {}) {
    const baseUrl = toApiBaseUrl(
      options.baseUrl ??
        globalThis.process?.env?.STARCITE_BASE_URL ??
        "http://localhost:4000"
    );
    this.baseUrl = baseUrl;

    const fetchFn = options.fetch ?? fetch;
    const apiKey = options.apiKey;
    let issuerAuthority: string | undefined;

    if (apiKey) {
      const apiKeyContext = decodeApiKeyContext(apiKey);
      issuerAuthority = apiKeyContext.issuerAuthority;
      this.inferredTenantId = apiKeyContext.tenantId;
    }

    this.authBaseUrl = resolveAuthBaseUrl(options.authUrl, issuerAuthority);
    this.apiKey = apiKey;
    this.store = options.store;
    this.appendOptions = options.appendOptions;
    this.socketUrl = `${toWebSocketBaseUrl(baseUrl)}/socket`;
    this.transport = {
      baseUrl,
      bearerToken: apiKey ?? null,
      socketManager: new SocketManager({
        socketUrl: this.socketUrl,
        token: apiKey,
      }),
      fetchFn,
    };
  }

  /**
   * Subscribes to tenant-scoped Starcite lifecycle events.
   *
   * Today the SDK supports only live `session.created` notifications.
   * Backend/service auth is required by the server.
   */
  on(
    eventName: "session.created",
    listener: (event: SessionCreatedLifecycleEvent) => void
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "session.created" | "error",
    listener:
      | ((event: SessionCreatedLifecycleEvent) => void)
      | ((error: Error) => void)
  ): () => void {
    if (!this.apiKey) {
      throw new StarciteError(LIFECYCLE_AUTH_ERROR_MESSAGE);
    }

    this.ensureLifecycleRuntime();
    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.lifecycle.on(eventName, listener as any);
    this.lifecycleRefs += 1;

    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
      this.off(eventName as any, listener as any);
    };
  }

  off(
    eventName: "session.created",
    listener: (event: SessionCreatedLifecycleEvent) => void
  ): void;
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "session.created" | "error",
    listener:
      | ((event: SessionCreatedLifecycleEvent) => void)
      | ((error: Error) => void)
  ): void {
    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.lifecycle.off(eventName, listener as any);
    this.lifecycleRefs = Math.max(0, this.lifecycleRefs - 1);
    if (this.lifecycleRefs === 0) {
      this.lifecycleRuntime?.close();
      this.lifecycleRuntime = undefined;
    }
  }

  /**
   * Creates a user identity bound to this client's tenant.
   */
  user(options: { id: string }): StarciteIdentity {
    return new StarciteIdentity({
      tenantId: this.requireTenantId("user()"),
      id: options.id,
      type: "user",
    });
  }

  /**
   * Creates an agent identity bound to this client's tenant.
   */
  agent(options: { id: string }): StarciteIdentity {
    return new StarciteIdentity({
      tenantId: this.requireTenantId("agent()"),
      id: options.id,
      type: "agent",
    });
  }

  /**
   * Creates or binds to a session.
   *
   * **With identity** (backend): creates a new session and/or mints a session
   * token for the given identity. Pass `id` to create-or-bind that session.
   *
   * **With token** (frontend): wraps an existing session token. The identity
   * and session id are decoded from the JWT.
   */
  session(input: {
    token: string;
    logOptions?: SessionLogOptions;
    appendOptions?: SessionAppendOptions;
  }): StarciteSession;
  session(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    logOptions?: SessionLogOptions;
    appendOptions?: SessionAppendOptions;
  }): Promise<StarciteSession>;
  session(
    input:
      | {
          token: string;
          logOptions?: SessionLogOptions;
          appendOptions?: SessionAppendOptions;
        }
      | {
          identity: StarciteIdentity;
          id?: string;
          title?: string;
          metadata?: Record<string, unknown>;
          logOptions?: SessionLogOptions;
          appendOptions?: SessionAppendOptions;
        }
  ): StarciteSession | Promise<StarciteSession> {
    if ("token" in input) {
      return this.sessionFromToken(
        input.token,
        input.logOptions,
        input.appendOptions
      );
    }

    return this.sessionFromIdentity(input);
  }

  /**
   * Lists sessions from the archive-backed catalog.
   */
  listSessions(
    options: SessionListOptions = {},
    requestOptions?: RequestOptions
  ): Promise<SessionListPage> {
    const query = new URLSearchParams();

    if (options.limit !== undefined) {
      query.set("limit", `${options.limit}`);
    }

    if (options.cursor !== undefined) {
      query.set("cursor", options.cursor);
    }

    if (options.metadata !== undefined) {
      for (const [key, value] of Object.entries(options.metadata)) {
        query.set(`metadata.${key}`, value);
      }
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    return request(
      this.transport,
      `/sessions${suffix}`,
      {
        method: "GET",
        signal: requestOptions?.signal,
      },
      SessionListPageSchema
    );
  }

  private async sessionFromIdentity(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    logOptions?: SessionLogOptions;
    appendOptions?: SessionAppendOptions;
  }): Promise<StarciteSession> {
    let sessionId = input.id;
    let record: SessionRecord | undefined;

    if (sessionId) {
      try {
        record = await this.createSession({
          id: sessionId,
          creator_principal: input.identity.toCreatorPrincipal(),
          title: input.title,
          metadata: input.metadata,
        });
      } catch (error) {
        if (!(error instanceof StarciteApiError && error.status === 409)) {
          throw error;
        }
      }
    } else {
      record = await this.createSession({
        creator_principal: input.identity.toCreatorPrincipal(),
        title: input.title,
        metadata: input.metadata,
      });
      sessionId = record.id;
    }

    const tokenResponse = await this.issueSessionToken({
      session_id: sessionId,
      principal: input.identity.toTokenPrincipal(),
      scopes: ["session:read", "session:append"],
    });

    return new StarciteSession({
      id: sessionId,
      token: tokenResponse.token,
      identity: input.identity,
      transport: this.buildSessionTransport(tokenResponse.token),
      store: this.store,
      record,
      logOptions: input.logOptions,
      appendOptions: mergeAppendOptions(
        this.appendOptions,
        input.appendOptions
      ),
    });
  }

  private sessionFromToken(
    token: string,
    logOptions?: SessionLogOptions,
    appendOptions?: SessionAppendOptions
  ): StarciteSession {
    const decoded = decodeSessionToken(token);
    const sessionId = decoded.sessionId;

    if (!sessionId) {
      throw new StarciteError(
        "session({ token }) requires a token with a session_id claim."
      );
    }

    return new StarciteSession({
      id: sessionId,
      token,
      identity: decoded.identity,
      transport: this.buildSessionTransport(token),
      store: this.store,
      logOptions,
      appendOptions: mergeAppendOptions(this.appendOptions, appendOptions),
    });
  }

  private buildSessionTransport(token: string): TransportConfig {
    const socketManager =
      token === this.apiKey
        ? this.transport.socketManager
        : new SocketManager({
            socketUrl: this.socketUrl,
            token,
          });

    return {
      ...this.transport,
      bearerToken: token,
      socketManager,
    };
  }

  private createSession(input: {
    id?: string;
    creator_principal?: { tenant_id: string; id: string; type: string };
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord> {
    return request(
      this.transport,
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      SessionRecordSchema
    );
  }

  private issueSessionToken(
    input: IssueSessionTokenInput
  ): Promise<{ token: string; expires_in: number }> {
    if (!this.transport.bearerToken) {
      throw new StarciteError(
        "session() with identity requires apiKey. Set StarciteOptions.apiKey."
      );
    }

    if (!this.authBaseUrl) {
      throw new StarciteError(
        "session() could not resolve auth issuer URL. Set StarciteOptions.authUrl, STARCITE_AUTH_URL, or use an API key JWT with an 'iss' claim."
      );
    }

    return requestWithBaseUrl(
      this.transport,
      this.authBaseUrl,
      "/api/v1/session-tokens",
      {
        method: "POST",
        headers: {
          "cache-control": "no-store",
        },
        body: JSON.stringify(input),
      },
      IssueSessionTokenResponseSchema
    );
  }

  private requireTenantId(method: string): string {
    const tenantId = this.inferredTenantId;
    if (!tenantId) {
      throw new StarciteError(`${method} requires apiKey to determine tenant.`);
    }
    return tenantId;
  }

  private ensureLifecycleRuntime(): void {
    if (this.lifecycleRuntime) {
      return;
    }

    if (!this.apiKey) {
      throw new StarciteError(LIFECYCLE_AUTH_ERROR_MESSAGE);
    }

    this.lifecycleRuntime = new LifecycleRuntime({
      socketManager: this.transport.socketManager,
    });

    this.lifecycleRuntime.on("session.created", (event) => {
      this.lifecycle.emit("session.created", event);
    });
    this.lifecycleRuntime.on("error", (error) => {
      this.lifecycle.emit("error", error);
    });
  }
}
