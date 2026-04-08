import EventEmitter from "eventemitter3";
import { decodeApiKeyContext, decodeSessionToken } from "./auth";
import { StarciteApiError, StarciteError } from "./errors";
import { StarciteIdentity } from "./identity";
import { StarciteSession } from "./session";
import {
  type RejoinableChannel,
  readJoinFailureReason,
  SocketManager,
} from "./socket-manager";
import type { TransportConfig } from "./transport";
import {
  parseHttpUrl,
  request,
  requestWithBaseUrl,
  stripTrailingSlashes,
  toApiBaseUrl,
  toWebSocketBaseUrl,
} from "./transport";
import {
  type IssueSessionTokenInput,
  IssueSessionTokenResponseSchema,
  type LifecycleEventEnvelope,
  LifecycleEventEnvelopeSchema,
  type RequestOptions,
  type SessionAppendOptions,
  type SessionLifecycleEventListeners,
  type SessionLifecycleEventName,
  SessionLifecycleEventNameSchema,
  SessionLifecycleEventNames,
  SessionLifecycleEventSchema,
  type SessionListOptions,
  type SessionListPage,
  SessionListPageSchema,
  type SessionRecord,
  SessionRecordSchema,
  type SessionStore,
  type SessionTokenRefreshHandler,
  type StarciteOptions,
} from "./types";

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

  return stripTrailingSlashes(parseHttpUrl(value).toString());
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

interface StarciteLifecycleEvents extends SessionLifecycleEventListeners {
  lifecycle: (event: LifecycleEventEnvelope) => void;
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
  private lifecycleChannel: RejoinableChannel | undefined;
  private closeLifecycleChannel: (() => void) | undefined;
  private lifecycleBindingRef = 0;

  constructor(options: StarciteOptions = {}) {
    const baseUrl = toApiBaseUrl(
      options.baseUrl ??
        globalThis.process?.env?.STARCITE_BASE_URL ??
        "http://localhost:4000"
    );
    this.baseUrl = baseUrl;

    const fetchFn =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
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
   * `lifecycle` forwards every backend lifecycle payload as-is. Typed named
   * listeners such as `session.created` are convenience helpers for the
   * currently modeled lifecycle kinds. Lifecycle subscriptions are live-only
   * and require backend/service auth.
   */
  on(
    eventName: "lifecycle",
    listener: (event: LifecycleEventEnvelope) => void
  ): () => void;
  on<K extends SessionLifecycleEventName>(
    eventName: K,
    listener: StarciteLifecycleEvents[K]
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "lifecycle" | SessionLifecycleEventName | "error",
    listener:
      | ((event: LifecycleEventEnvelope) => void)
      | StarciteLifecycleEvents[SessionLifecycleEventName]
      | ((error: Error) => void)
  ): () => void {
    if (!this.apiKey) {
      throw new StarciteError(
        "starcite.on() requires StarciteOptions.apiKey. Lifecycle events are backend-only and authenticate with the server API key, not a minted session token."
      );
    }

    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.lifecycle.on(eventName, listener as any);
    if (eventName !== "error") {
      this.ensureLifecycleChannelAttached();
    }

    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
      this.off(eventName as any, listener as any);
    };
  }

  off<K extends SessionLifecycleEventName>(
    eventName: K,
    listener: StarciteLifecycleEvents[K]
  ): void;
  off(
    eventName: "lifecycle",
    listener: (event: LifecycleEventEnvelope) => void
  ): void;
  off(eventName: "error", listener: (error: Error) => void): void;
  off(
    eventName: "lifecycle" | SessionLifecycleEventName | "error",
    listener:
      | ((event: LifecycleEventEnvelope) => void)
      | StarciteLifecycleEvents[SessionLifecycleEventName]
      | ((error: Error) => void)
  ): void {
    // biome-ignore lint/suspicious/noExplicitAny: overload signatures guarantee type safety
    this.lifecycle.off(eventName, listener as any);
    if (eventName !== "error") {
      this.detachLifecycleChannelIfIdle();
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
    appendOptions?: SessionAppendOptions;
    refreshToken?: SessionTokenRefreshHandler;
  }): StarciteSession;
  session(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    appendOptions?: SessionAppendOptions;
    refreshToken?: SessionTokenRefreshHandler;
  }): Promise<StarciteSession>;
  session(
    input:
      | {
          token: string;
          appendOptions?: SessionAppendOptions;
          refreshToken?: SessionTokenRefreshHandler;
        }
      | {
          identity: StarciteIdentity;
          id?: string;
          title?: string;
          metadata?: Record<string, unknown>;
          appendOptions?: SessionAppendOptions;
          refreshToken?: SessionTokenRefreshHandler;
        }
  ): StarciteSession | Promise<StarciteSession> {
    if ("token" in input) {
      return this.sessionFromToken(
        input.token,
        input.appendOptions,
        input.refreshToken
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
    appendOptions?: SessionAppendOptions;
    refreshToken?: SessionTokenRefreshHandler;
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
      appendOptions: mergeAppendOptions(
        this.appendOptions,
        input.appendOptions
      ),
      refreshToken:
        input.refreshToken ??
        (() =>
          this.issueSessionToken({
            session_id: sessionId,
            principal: input.identity.toTokenPrincipal(),
            scopes: ["session:read", "session:append"],
          }).then((response) => response.token)),
    });
  }

  private sessionFromToken(
    token: string,
    appendOptions?: SessionAppendOptions,
    refreshToken?: SessionTokenRefreshHandler
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
      appendOptions: mergeAppendOptions(this.appendOptions, appendOptions),
      refreshToken,
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

  private ensureLifecycleChannelAttached(): void {
    if (this.lifecycleChannel) {
      return;
    }

    const managed = this.transport.socketManager.openChannel<RejoinableChannel>(
      {
        topic: "lifecycle",
        params: {},
      }
    );
    const channel = managed.channel;

    this.closeLifecycleChannel = managed.close;
    this.lifecycleChannel = channel;

    this.lifecycleBindingRef = channel.on("lifecycle", (payload) => {
      this.handleLifecyclePayload(payload);
    });

    channel.join().receive("error", (payload) => {
      this.emitLifecycleError(
        new StarciteError(
          `Lifecycle subscription failed: ${readJoinFailureReason(payload)}`
        )
      );
    });
  }

  private handleLifecyclePayload(payload: unknown): void {
    const event = (payload as { event?: unknown })?.event;
    const envelope = LifecycleEventEnvelopeSchema.safeParse(event);
    if (!envelope.success) {
      this.emitLifecycleError(
        new StarciteError(
          `Invalid lifecycle payload: ${envelope.error.issues[0]?.message ?? "parse failed"}`
        )
      );
      return;
    }

    this.lifecycle.emit("lifecycle", envelope.data);

    const parsed = SessionLifecycleEventSchema.safeParse(envelope.data);
    if (parsed.success) {
      // biome-ignore lint/suspicious/noExplicitAny: parsed lifecycle union matches the event-specific listener type
      this.lifecycle.emit(parsed.data.kind, parsed.data as any);
      return;
    }

    const lifecycleKind = SessionLifecycleEventNameSchema.safeParse(
      envelope.data.kind
    );
    if (!lifecycleKind.success) {
      return;
    }

    this.emitLifecycleError(
      new StarciteError(
        `Invalid ${envelope.data.kind} payload: ${parsed.error.issues[0]?.message ?? "parse failed"}`
      )
    );
  }

  private detachLifecycleChannelIfIdle(): void {
    if (
      this.lifecycle.listenerCount("lifecycle") > 0 ||
      SessionLifecycleEventNames.some((eventName) => {
        return this.lifecycle.listenerCount(eventName) > 0;
      })
    ) {
      return;
    }

    if (this.lifecycleChannel) {
      this.lifecycleChannel.off("lifecycle", this.lifecycleBindingRef);
      this.lifecycleChannel = undefined;
    }

    this.lifecycleBindingRef = 0;
    this.closeLifecycleChannel?.();
    this.closeLifecycleChannel = undefined;
  }

  private emitLifecycleError(error: Error): void {
    if (this.lifecycle.listenerCount("error") > 0) {
      this.lifecycle.emit("error", error);
      return;
    }

    queueMicrotask(() => {
      throw error;
    });
  }
}
