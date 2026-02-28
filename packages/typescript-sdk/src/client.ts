import {
  decodeSessionToken,
  inferIdentityFromApiKey,
  inferIssuerAuthorityFromApiKey,
} from "./auth";
import { StarciteError } from "./errors";
import { StarciteIdentity } from "./identity";
import { StarciteSession } from "./session";
import type { TransportConfig } from "./transport";
import {
  defaultWebSocketFactory,
  normalizeAbsoluteHttpUrl,
  request,
  requestWithBaseUrl,
  resolveWebSocketAuthTransport,
  toApiBaseUrl,
  toWebSocketBaseUrl,
} from "./transport";
import type {
  IssueSessionTokenInput,
  RequestOptions,
  SessionListOptions,
  SessionListPage,
  SessionLogOptions,
  SessionRecord,
  StarciteOptions,
} from "./types";
import {
  IssueSessionTokenResponseSchema,
  SessionListOptionsSchema,
  SessionListPageSchema,
  SessionRecordSchema,
} from "./types";

const DEFAULT_BASE_URL =
  globalThis.process?.env?.STARCITE_BASE_URL ?? "http://localhost:4000";
const DEFAULT_AUTH_URL = globalThis.process?.env?.STARCITE_AUTH_URL;

/**
 * Resolves auth issuer base URL in this order:
 * explicit option -> env -> API key JWT issuer authority.
 */
function resolveAuthBaseUrl(
  explicitAuthUrl: string | undefined,
  apiKey: string | undefined
): string | undefined {
  if (explicitAuthUrl) {
    return normalizeAbsoluteHttpUrl(explicitAuthUrl, "authUrl");
  }

  if (DEFAULT_AUTH_URL) {
    return normalizeAbsoluteHttpUrl(DEFAULT_AUTH_URL, "STARCITE_AUTH_URL");
  }

  if (apiKey) {
    return inferIssuerAuthorityFromApiKey(apiKey);
  }

  return undefined;
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
  private readonly inferredIdentity?: StarciteIdentity;

  constructor(options: StarciteOptions = {}) {
    const baseUrl = toApiBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.baseUrl = baseUrl;

    const fetchFn = options.fetch ?? fetch;
    const headers = new Headers(options.headers);
    const apiKey = options.apiKey?.trim();
    let authorization: string | undefined;

    if (apiKey) {
      authorization = `Bearer ${apiKey}`;
      this.inferredIdentity = inferIdentityFromApiKey(apiKey);
    }

    this.authBaseUrl = resolveAuthBaseUrl(options.authUrl, apiKey);

    const websocketAuthTransport = resolveWebSocketAuthTransport(
      options.websocketAuthTransport,
      options.websocketFactory !== undefined
    );
    const websocketFactory =
      options.websocketFactory ?? defaultWebSocketFactory;

    this.transport = {
      baseUrl,
      websocketBaseUrl: toWebSocketBaseUrl(baseUrl),
      authorization: authorization ?? null,
      fetchFn,
      headers,
      websocketFactory,
      websocketAuthTransport,
    };
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
   * token for the given identity. Pass `id` to bind to an existing session.
   *
   * **With token** (frontend): wraps an existing session token. The identity
   * and session id are decoded from the JWT.
   */
  session(input: {
    token: string;
    id?: string;
    logOptions?: SessionLogOptions;
  }): StarciteSession;
  session(input: {
    identity: StarciteIdentity;
    id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    logOptions?: SessionLogOptions;
  }): Promise<StarciteSession>;
  session(
    input:
      | { token: string; id?: string; logOptions?: SessionLogOptions }
      | {
          identity: StarciteIdentity;
          id?: string;
          title?: string;
          metadata?: Record<string, unknown>;
          logOptions?: SessionLogOptions;
        }
  ): StarciteSession | Promise<StarciteSession> {
    if ("token" in input) {
      return this.sessionFromToken(input.token, input.id, input.logOptions);
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
    const parsed = SessionListOptionsSchema.parse(options);
    const query = new URLSearchParams();

    if (parsed.limit !== undefined) {
      query.set("limit", `${parsed.limit}`);
    }

    if (parsed.cursor !== undefined) {
      query.set("cursor", parsed.cursor);
    }

    if (parsed.metadata !== undefined) {
      for (const [key, value] of Object.entries(parsed.metadata)) {
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
  }): Promise<StarciteSession> {
    let sessionId = input.id;
    let record: SessionRecord | undefined;

    if (!sessionId) {
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
      record,
      logOptions: input.logOptions,
    });
  }

  private sessionFromToken(
    token: string,
    explicitId?: string,
    logOptions?: SessionLogOptions
  ): StarciteSession {
    const decoded = decodeSessionToken(token);
    const sessionId = explicitId ?? decoded.sessionId;

    if (!sessionId) {
      throw new StarciteError(
        "session({ token }) requires 'id' when the token does not contain a session_id claim."
      );
    }

    return new StarciteSession({
      id: sessionId,
      token,
      identity: decoded.identity,
      transport: this.buildSessionTransport(token),
      logOptions,
    });
  }

  private buildSessionTransport(token: string): TransportConfig {
    return {
      ...this.transport,
      authorization: `Bearer ${token}`,
    };
  }

  private createSession(input: {
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
    if (!this.transport.authorization) {
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
    const tenantId = this.inferredIdentity?.tenantId;
    if (!tenantId) {
      throw new StarciteError(`${method} requires apiKey to determine tenant.`);
    }
    return tenantId;
  }
}
