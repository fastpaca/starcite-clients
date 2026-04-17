import type {
  SessionArchivedLifecycleEvent,
  SessionCreatedLifecycleEvent,
  SessionEventListener,
  SessionFrozenLifecycleEvent,
  SessionLifecycleEventName,
  SessionOnEventOptions,
  SessionUnarchivedLifecycleEvent,
  StarciteIdentity,
  StarciteSession,
  TailEvent,
} from "@starcite/sdk";

export interface SessionAgentSession
  extends Pick<StarciteSession, "disconnect" | "events" | "id"> {
  on(
    eventName: "event",
    listener: SessionEventListener,
    options?: Pick<SessionOnEventOptions, "replay">
  ): () => void;
  readonly log: {
    readonly lastSeq: number;
  };
}

export interface HistorySettleOptions {
  readonly idleWindowMs?: number;
  readonly minWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface SessionSupervisorLogger {
  error(message: string, error?: unknown): void;
  info(message: string): void;
}

export type AgentStartCause = "activated" | "initial";
export type AgentStopCause = "archived" | "frozen" | "shutdown";

type MaybePromise<T> = Promise<T> | T;
type SessionLifecycleEvent =
  | SessionCreatedLifecycleEvent
  | SessionArchivedLifecycleEvent
  | SessionUnarchivedLifecycleEvent
  | SessionFrozenLifecycleEvent
  | { readonly session_id: string };

interface SessionLifecycleSource<
  TSession extends SessionAgentSession = SessionAgentSession,
> {
  on(
    eventName: SessionLifecycleEventName,
    listener: (event: SessionLifecycleEvent) => void | Promise<void>
  ): () => void;
  session(input: {
    readonly identity: StarciteIdentity;
    readonly id: string;
  }): Promise<TSession>;
}

const CURRENT_SESSION = Symbol("session-agent-current-session");

type ManagedAgent<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession,
> = TAgent & {
  [CURRENT_SESSION]: TSession | undefined;
};

export abstract class SessionAgent<
  TSession extends SessionAgentSession = StarciteSession,
> {
  readonly sessionId: string;
  [CURRENT_SESSION]: TSession | undefined;

  constructor(input: { readonly sessionId: string }) {
    this.sessionId = input.sessionId;
    this[CURRENT_SESSION] = undefined;
  }

  protected get session(): TSession {
    const session = this[CURRENT_SESSION];
    if (!session) {
      throw new Error(
        `SessionAgent '${this.sessionId}' does not have an active session.`
      );
    }

    return session;
  }

  start(): MaybePromise<void> {
    return;
  }

  abstract receive(event: TailEvent): MaybePromise<void>;

  archive(): MaybePromise<void> {
    return;
  }

  unarchive(): MaybePromise<void> {
    return;
  }

  stop(_cause: AgentStopCause): MaybePromise<void> {
    return;
  }

  shutdown(): MaybePromise<void> {
    return;
  }
}

export interface SessionAgentSupervisorOptions<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession = StarciteSession,
> {
  readonly Agent: new (input: { readonly sessionId: string }) => TAgent;
  readonly agent: StarciteIdentity;
  readonly historySettle?: HistorySettleOptions;
  readonly logger?: SessionSupervisorLogger;
  readonly manages?: (sessionId: string) => MaybePromise<boolean>;
  readonly restoreSessionIds?: () =>
    | Promise<readonly string[]>
    | readonly string[];
  readonly starcite: SessionLifecycleSource<TSession>;
}

interface AgentEntry<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession,
> {
  readonly agent: ManagedAgent<TAgent, TSession>;
  archived: boolean;
  lastDeliveredSeq: number;
  operation: Promise<void>;
  phase: "started" | "starting" | "stopped" | "stopping";
  session: TSession | undefined;
  unsubscribe: (() => void) | undefined;
}

const DEFAULT_HISTORY_SETTLE: Required<HistorySettleOptions> = {
  idleWindowMs: 100,
  minWaitMs: 500,
  pollIntervalMs: 25,
  timeoutMs: 1500,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function assignSession<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession,
>(agent: ManagedAgent<TAgent, TSession>, session: TSession): void {
  agent[CURRENT_SESSION] = session;
}

function clearSession<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession,
>(agent: ManagedAgent<TAgent, TSession>): void {
  agent[CURRENT_SESSION] = undefined;
}

export class SessionAgentSupervisor<
  TAgent extends SessionAgent<TSession>,
  TSession extends SessionAgentSession = StarciteSession,
> {
  private readonly Agent: SessionAgentSupervisorOptions<
    TAgent,
    TSession
  >["Agent"];
  private readonly agent: StarciteIdentity;
  private readonly agentActor: string;
  private readonly historySettle: Required<HistorySettleOptions>;
  private readonly logger: SessionSupervisorLogger | undefined;
  private readonly manages: (sessionId: string) => MaybePromise<boolean>;
  private readonly restoreSessionIds: SessionAgentSupervisorOptions<
    TAgent,
    TSession
  >["restoreSessionIds"];
  private readonly starcite: SessionLifecycleSource<TSession>;
  private readonly entries = new Map<string, AgentEntry<TAgent, TSession>>();
  private readonly lifecycleUnsubs: Array<() => void> = [];
  private started = false;

  constructor(options: SessionAgentSupervisorOptions<TAgent, TSession>) {
    this.Agent = options.Agent;
    this.agent = options.agent;
    this.agentActor = options.agent.toActor();
    this.historySettle = {
      ...DEFAULT_HISTORY_SETTLE,
      ...(options.historySettle ?? {}),
    };
    this.logger = options.logger;
    this.manages = options.manages ?? (() => true);
    this.restoreSessionIds = options.restoreSessionIds;
    this.starcite = options.starcite;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.subscribeLifecycle("session.created", async (event) => {
      await this.handleCreated(event.session_id);
    });
    this.subscribeLifecycle("session.archived", async (event) => {
      await this.handleArchived(event.session_id);
    });
    this.subscribeLifecycle("session.unarchived", async (event) => {
      await this.handleUnarchived(event.session_id);
    });
    this.subscribeLifecycle("session.activated", async (event) => {
      await this.handleActivated(event.session_id, "activated");
    });
    this.subscribeLifecycle("session.frozen", async (event) => {
      await this.handleFrozen(event.session_id);
    });

    const restoredSessionIds = await this.restoreSessionIds?.();
    if (!restoredSessionIds) {
      return;
    }

    for (const sessionId of restoredSessionIds) {
      await this.handleActivated(sessionId, "initial");
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    while (this.lifecycleUnsubs.length > 0) {
      this.lifecycleUnsubs.pop()?.();
    }

    const sessionIds = [...this.entries.keys()];
    for (const sessionId of sessionIds) {
      await this.shutdownSession(sessionId);
    }
  }

  get(sessionId: string): TAgent | undefined {
    return this.entries.get(sessionId)?.agent;
  }

  async shutdownSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    await this.enqueue(entry, async () => {
      await this.stopEntry(entry, "shutdown");
      await entry.agent.shutdown();
      this.entries.delete(sessionId);
      this.logger?.info(
        `[session-agent-supervisor] shut down agent for session ${sessionId}`
      );
    });
  }

  private subscribeLifecycle(
    eventName: SessionLifecycleEventName,
    handler: (event: SessionLifecycleEvent) => Promise<void>
  ): void {
    const unsubscribe = this.starcite.on(eventName, (event) => {
      return handler(event).catch((error) => {
        this.logger?.error(
          `[session-agent-supervisor] failed handling ${eventName} for session ${event.session_id}`,
          error
        );
      });
    });
    this.lifecycleUnsubs.push(unsubscribe);
  }

  private async handleCreated(sessionId: string): Promise<void> {
    await this.getOrCreateEntry(sessionId);
  }

  private async handleActivated(
    sessionId: string,
    cause: AgentStartCause
  ): Promise<void> {
    const entry = await this.getOrCreateEntry(sessionId);
    if (!entry) {
      return;
    }

    await this.enqueue(entry, async () => {
      if (entry.phase === "started" || entry.phase === "starting") {
        return;
      }

      await this.startEntry(entry, cause);
    });
  }

  private async handleFrozen(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    await this.enqueue(entry, async () => {
      await this.stopEntry(entry, "frozen");
    });
  }

  private async handleArchived(sessionId: string): Promise<void> {
    const entry = await this.getOrCreateEntry(sessionId);
    if (!entry) {
      return;
    }

    await this.enqueue(entry, async () => {
      await this.stopEntry(entry, "archived");
      if (entry.archived) {
        return;
      }

      entry.archived = true;
      await entry.agent.archive();
      this.logger?.info(
        `[session-agent-supervisor] archived session ${sessionId}`
      );
    });
  }

  private async handleUnarchived(sessionId: string): Promise<void> {
    const entry = await this.getOrCreateEntry(sessionId);
    if (!entry) {
      return;
    }

    await this.enqueue(entry, async () => {
      if (!entry.archived) {
        return;
      }

      entry.archived = false;
      await entry.agent.unarchive();
      this.logger?.info(
        `[session-agent-supervisor] unarchived session ${sessionId}`
      );
    });
  }

  private async getOrCreateEntry(
    sessionId: string
  ): Promise<AgentEntry<TAgent, TSession> | undefined> {
    const existing = this.entries.get(sessionId);
    if (existing) {
      return existing;
    }

    if (!(await this.manages(sessionId))) {
      return undefined;
    }

    const agent = new this.Agent({
      sessionId,
    }) as ManagedAgent<TAgent, TSession>;
    const entry: AgentEntry<TAgent, TSession> = {
      agent,
      archived: false,
      lastDeliveredSeq: 0,
      operation: Promise.resolve(),
      phase: "stopped",
      session: undefined,
      unsubscribe: undefined,
    };
    this.entries.set(sessionId, entry);
    this.logger?.info(
      `[session-agent-supervisor] created agent for session ${sessionId}`
    );
    return entry;
  }

  private async enqueue(
    entry: AgentEntry<TAgent, TSession>,
    operation: () => Promise<void>
  ): Promise<void> {
    const nextOperation = entry.operation.then(operation, operation);
    entry.operation = nextOperation.then(
      () => undefined,
      () => undefined
    );
    await nextOperation;
  }

  private async startEntry(
    entry: AgentEntry<TAgent, TSession>,
    _cause: AgentStartCause
  ): Promise<void> {
    entry.phase = "starting";

    const session = await this.starcite.session({
      identity: this.agent,
      id: entry.agent.sessionId,
    });

    try {
      if (this.historySettle.minWaitMs > 0) {
        await sleep(this.historySettle.minWaitMs);
      }

      const historyFloorSeq = await this.awaitSessionHistorySettled(session);
      assignSession(entry.agent, session);
      entry.session = session;
      entry.unsubscribe = session.on(
        "event",
        (event) => {
          return this.enqueue(entry, async () => {
            await this.receiveLiveEvent(entry, event, historyFloorSeq);
          }).catch((error) => {
            this.logger?.error(
              `[session-agent-supervisor] failed processing live event ${event.seq} for session ${entry.agent.sessionId}`,
              error
            );
          });
        },
        { replay: false }
      );
      entry.phase = "started";

      await entry.agent.start();
      await this.replayRetainedEvents(entry, historyFloorSeq);
      this.logger?.info(
        `[session-agent-supervisor] started agent for session ${entry.agent.sessionId}`
      );
    } catch (error) {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      clearSession(entry.agent);
      entry.session = undefined;
      session.disconnect();
      entry.phase = "stopped";
      throw error;
    }
  }

  private async replayRetainedEvents(
    entry: AgentEntry<TAgent, TSession>,
    historyFloorSeq: number
  ): Promise<void> {
    if (!entry.session) {
      return;
    }

    const retainedEvents = [...entry.session.events()]
      .filter(
        (event) =>
          event.seq <= historyFloorSeq && event.seq > entry.lastDeliveredSeq
      )
      .sort((left, right) => left.seq - right.seq);

    for (const event of retainedEvents) {
      await this.deliverEvent(entry, event);
    }
  }

  private async receiveLiveEvent(
    entry: AgentEntry<TAgent, TSession>,
    event: TailEvent,
    historyFloorSeq: number
  ): Promise<void> {
    if (entry.phase !== "started") {
      return;
    }

    if (event.seq <= historyFloorSeq || event.seq <= entry.lastDeliveredSeq) {
      return;
    }

    await this.deliverEvent(entry, event);
  }

  private async deliverEvent(
    entry: AgentEntry<TAgent, TSession>,
    event: TailEvent
  ): Promise<void> {
    if (event.seq <= entry.lastDeliveredSeq) {
      return;
    }

    if (event.actor === this.agentActor) {
      entry.lastDeliveredSeq = event.seq;
      return;
    }

    await entry.agent.receive(event);
    entry.lastDeliveredSeq = event.seq;
  }

  private async stopEntry(
    entry: AgentEntry<TAgent, TSession>,
    cause: AgentStopCause
  ): Promise<void> {
    if (entry.phase === "stopped") {
      return;
    }

    entry.phase = "stopping";
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;

    const session = entry.session;
    try {
      await entry.agent.stop(cause);
    } finally {
      clearSession(entry.agent);
      entry.session = undefined;
      session?.disconnect();
      entry.phase = "stopped";
      this.logger?.info(
        `[session-agent-supervisor] stopped agent for session ${entry.agent.sessionId} (${cause})`
      );
    }
  }

  private async awaitSessionHistorySettled(session: TSession): Promise<number> {
    const deadline = Date.now() + this.historySettle.timeoutMs;
    let previousLastSeq = -1;
    let stableSinceMs = Date.now();

    while (Date.now() < deadline) {
      const lastSeq = session.log.lastSeq;

      if (lastSeq !== previousLastSeq) {
        previousLastSeq = lastSeq;
        stableSinceMs = Date.now();
      } else if (
        Date.now() - stableSinceMs >=
        this.historySettle.idleWindowMs
      ) {
        return lastSeq;
      }

      if (this.historySettle.pollIntervalMs > 0) {
        await sleep(this.historySettle.pollIntervalMs);
      } else {
        await Promise.resolve();
      }
    }

    return session.log.lastSeq;
  }
}
