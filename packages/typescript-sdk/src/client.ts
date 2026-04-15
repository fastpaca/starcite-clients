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
  type SessionArchivedFilter,
  type SessionAttachMode,
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
  type SessionUpdateInput,
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

const FRESH_SESSION_GRACE_MS = 30_000;

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
  private readonly sessionStore: SessionStore | undefined;
  private readonly sessionAttachMode: SessionAttachMode;
  private readonly appendOptions: SessionAppendOptions | undefined;
  private readonly lifecycle = new EventEmitter<StarciteLifecycleEvents>();
  private readonly freshSessionIds = new Set<string>();
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
    this.sessionStore = options.sessionStore;
    this.sessionAttachMode = options.sessionAttachMode ?? "on-demand";
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

    switch (eventName) {
      case "lifecycle":
        return this.onLifecycle(
          listener as (event: LifecycleEventEnvelope) => void
        );
      case "error":
        return this.onLifecycleError(listener as (error: Error) => void);
      case "session.created":
        return this.onSessionCreated(
          listener as StarciteLifecycleEvents["session.created"]
        );
      case "session.updated":
        return this.onSessionUpdated(
          listener as StarciteLifecycleEvents["session.updated"]
        );
      case "session.archived":
        return this.onSessionArchived(
          listener as StarciteLifecycleEvents["session.archived"]
        );
      case "session.unarchived":
        return this.onSessionUnarchived(
          listener as StarciteLifecycleEvents["session.unarchived"]
        );
      case "session.hydrating":
        return this.onSessionHydrating(
          listener as StarciteLifecycleEvents["session.hydrating"]
        );
      case "session.activated":
        return this.onSessionActivated(
          listener as StarciteLifecycleEvents["session.activated"]
        );
      case "session.freezing":
        return this.onSessionFreezing(
          listener as StarciteLifecycleEvents["session.freezing"]
        );
      case "session.frozen":
        return this.onSessionFrozen(
          listener as StarciteLifecycleEvents["session.frozen"]
        );
      default:
        throw new StarciteError(`Unsupported lifecycle event '${eventName}'`);
    }
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
    switch (eventName) {
      case "lifecycle":
        this.offLifecycle(listener as (event: LifecycleEventEnvelope) => void);
        return;
      case "error":
        this.lifecycle.off("error", listener as (error: Error) => void);
        return;
      case "session.created":
        this.offSessionCreated(
          listener as StarciteLifecycleEvents["session.created"]
        );
        return;
      case "session.updated":
        this.offSessionUpdated(
          listener as StarciteLifecycleEvents["session.updated"]
        );
        return;
      case "session.archived":
        this.offSessionArchived(
          listener as StarciteLifecycleEvents["session.archived"]
        );
        return;
      case "session.unarchived":
        this.offSessionUnarchived(
          listener as StarciteLifecycleEvents["session.unarchived"]
        );
        return;
      case "session.hydrating":
        this.offSessionHydrating(
          listener as StarciteLifecycleEvents["session.hydrating"]
        );
        return;
      case "session.activated":
        this.offSessionActivated(
          listener as StarciteLifecycleEvents["session.activated"]
        );
        return;
      case "session.freezing":
        this.offSessionFreezing(
          listener as StarciteLifecycleEvents["session.freezing"]
        );
        return;
      case "session.frozen":
        this.offSessionFrozen(
          listener as StarciteLifecycleEvents["session.frozen"]
        );
        return;
      default:
        throw new StarciteError(`Unsupported lifecycle event '${eventName}'`);
    }
  }

  private onLifecycle(
    listener: (event: LifecycleEventEnvelope) => void
  ): () => void {
    this.lifecycle.on("lifecycle", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offLifecycle(listener);
    };
  }

  private onLifecycleError(listener: (error: Error) => void): () => void {
    this.lifecycle.on("error", listener);
    return () => {
      this.lifecycle.off("error", listener);
    };
  }

  private offLifecycle(
    listener: (event: LifecycleEventEnvelope) => void
  ): void {
    this.lifecycle.off("lifecycle", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionCreated(
    listener: StarciteLifecycleEvents["session.created"]
  ): () => void {
    this.lifecycle.on("session.created", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionCreated(listener);
    };
  }

  private offSessionCreated(
    listener: StarciteLifecycleEvents["session.created"]
  ): void {
    this.lifecycle.off("session.created", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionUpdated(
    listener: StarciteLifecycleEvents["session.updated"]
  ): () => void {
    this.lifecycle.on("session.updated", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionUpdated(listener);
    };
  }

  private offSessionUpdated(
    listener: StarciteLifecycleEvents["session.updated"]
  ): void {
    this.lifecycle.off("session.updated", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionArchived(
    listener: StarciteLifecycleEvents["session.archived"]
  ): () => void {
    this.lifecycle.on("session.archived", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionArchived(listener);
    };
  }

  private offSessionArchived(
    listener: StarciteLifecycleEvents["session.archived"]
  ): void {
    this.lifecycle.off("session.archived", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionUnarchived(
    listener: StarciteLifecycleEvents["session.unarchived"]
  ): () => void {
    this.lifecycle.on("session.unarchived", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionUnarchived(listener);
    };
  }

  private offSessionUnarchived(
    listener: StarciteLifecycleEvents["session.unarchived"]
  ): void {
    this.lifecycle.off("session.unarchived", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionHydrating(
    listener: StarciteLifecycleEvents["session.hydrating"]
  ): () => void {
    this.lifecycle.on("session.hydrating", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionHydrating(listener);
    };
  }

  private offSessionHydrating(
    listener: StarciteLifecycleEvents["session.hydrating"]
  ): void {
    this.lifecycle.off("session.hydrating", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionActivated(
    listener: StarciteLifecycleEvents["session.activated"]
  ): () => void {
    this.lifecycle.on("session.activated", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionActivated(listener);
    };
  }

  private offSessionActivated(
    listener: StarciteLifecycleEvents["session.activated"]
  ): void {
    this.lifecycle.off("session.activated", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionFreezing(
    listener: StarciteLifecycleEvents["session.freezing"]
  ): () => void {
    this.lifecycle.on("session.freezing", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionFreezing(listener);
    };
  }

  private offSessionFreezing(
    listener: StarciteLifecycleEvents["session.freezing"]
  ): void {
    this.lifecycle.off("session.freezing", listener);
    this.detachLifecycleChannelIfIdle();
  }

  private onSessionFrozen(
    listener: StarciteLifecycleEvents["session.frozen"]
  ): () => void {
    this.lifecycle.on("session.frozen", listener);
    this.ensureLifecycleChannelAttached();
    return () => {
      this.offSessionFrozen(listener);
    };
  }

  private offSessionFrozen(
    listener: StarciteLifecycleEvents["session.frozen"]
  ): void {
    this.lifecycle.off("session.frozen", listener);
    this.detachLifecycleChannelIfIdle();
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
    attachMode?: SessionAttachMode;
  }): StarciteSession;
  session(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    appendOptions?: SessionAppendOptions;
    refreshToken?: SessionTokenRefreshHandler;
    attachMode?: SessionAttachMode;
  }): Promise<StarciteSession>;
  session(
    input:
      | {
          token: string;
          appendOptions?: SessionAppendOptions;
          refreshToken?: SessionTokenRefreshHandler;
          attachMode?: SessionAttachMode;
        }
      | {
          identity: StarciteIdentity;
          id?: string;
          title?: string;
          metadata?: Record<string, unknown>;
          appendOptions?: SessionAppendOptions;
          refreshToken?: SessionTokenRefreshHandler;
          attachMode?: SessionAttachMode;
        }
  ): StarciteSession | Promise<StarciteSession> {
    if ("token" in input) {
      return this.sessionFromToken(
        input.token,
        input.appendOptions,
        input.refreshToken,
        input.attachMode
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

    if (options.archived !== undefined) {
      query.set("archived", serializeArchivedFilter(options.archived));
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

  /**
   * Fetches one session header by id, including archived sessions.
   */
  getSession(
    sessionId: string,
    requestOptions?: RequestOptions
  ): Promise<SessionRecord> {
    return request(
      this.transport,
      `/sessions/${sessionId}`,
      {
        method: "GET",
        signal: requestOptions?.signal,
      },
      SessionRecordSchema
    );
  }

  /**
   * Updates mutable session header fields.
   */
  updateSession(
    sessionId: string,
    input: SessionUpdateInput,
    requestOptions?: RequestOptions
  ): Promise<SessionRecord> {
    return request(
      this.transport,
      `/sessions/${sessionId}`,
      {
        method: "PATCH",
        signal: requestOptions?.signal,
        body: JSON.stringify({
          title: input.title,
          metadata: input.metadata,
          expected_version: input.expectedVersion,
        }),
      },
      SessionRecordSchema
    );
  }

  /**
   * Archives one session without deleting its timeline.
   */
  archiveSession(
    sessionId: string,
    requestOptions?: RequestOptions
  ): Promise<SessionRecord> {
    return request(
      this.transport,
      `/sessions/${sessionId}/archive`,
      {
        method: "POST",
        signal: requestOptions?.signal,
        body: JSON.stringify({}),
      },
      SessionRecordSchema
    );
  }

  /**
   * Restores one archived session to active list results.
   */
  unarchiveSession(
    sessionId: string,
    requestOptions?: RequestOptions
  ): Promise<SessionRecord> {
    return request(
      this.transport,
      `/sessions/${sessionId}/unarchive`,
      {
        method: "POST",
        signal: requestOptions?.signal,
        body: JSON.stringify({}),
      },
      SessionRecordSchema
    );
  }

  private async sessionFromIdentity(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    appendOptions?: SessionAppendOptions;
    refreshToken?: SessionTokenRefreshHandler;
    attachMode?: SessionAttachMode;
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
      sessionStore: this.sessionStore,
      record,
      initialTailCursor: this.initialTailCursorFor(sessionId),
      attachMode: input.attachMode ?? this.sessionAttachMode,
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
    refreshToken?: SessionTokenRefreshHandler,
    attachMode?: SessionAttachMode
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
      sessionStore: this.sessionStore,
      attachMode: attachMode ?? this.sessionAttachMode,
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
      switch (parsed.data.kind) {
        case "session.created":
          this.rememberFreshSession(parsed.data.session_id);
          this.lifecycle.emit("session.created", parsed.data);
          return;
        case "session.updated":
          this.lifecycle.emit("session.updated", parsed.data);
          return;
        case "session.archived":
          this.lifecycle.emit("session.archived", parsed.data);
          return;
        case "session.unarchived":
          this.lifecycle.emit("session.unarchived", parsed.data);
          return;
        case "session.hydrating":
          this.lifecycle.emit("session.hydrating", parsed.data);
          return;
        case "session.activated":
          this.lifecycle.emit("session.activated", parsed.data);
          return;
        case "session.freezing":
          this.lifecycle.emit("session.freezing", parsed.data);
          return;
        case "session.frozen":
          this.lifecycle.emit("session.frozen", parsed.data);
          return;
        default:
          return;
      }
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

  private rememberFreshSession(sessionId: string): void {
    this.freshSessionIds.add(sessionId);
    const cleanup = setTimeout(() => {
      this.freshSessionIds.delete(sessionId);
    }, FRESH_SESSION_GRACE_MS);
    cleanup.unref?.();
  }

  private initialTailCursorFor(sessionId: string): 0 | undefined {
    return this.freshSessionIds.has(sessionId) ? 0 : undefined;
  }
}

function serializeArchivedFilter(value: SessionArchivedFilter): string {
  return value === "all" ? "all" : `${value}`;
}
