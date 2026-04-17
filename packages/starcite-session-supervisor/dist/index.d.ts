import { StarciteSession, TailEvent, SessionEventListener, SessionOnEventOptions } from '@starcite/sdk';

interface SupervisedRuntime {
    stop(): void;
}
interface SupervisedSession extends Pick<StarciteSession, "disconnect" | "id"> {
    events(): readonly TailEvent[];
    on(eventName: "event", listener: SessionEventListener, options?: Pick<SessionOnEventOptions, "replay">): () => void;
    readonly log: {
        readonly lastSeq: number;
    };
}
interface HistorySettleOptions {
    readonly idleWindowMs?: number;
    readonly minWaitMs?: number;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
}
type RuntimeActivationSource = "history" | "live";
interface RuntimeActivation<TSession extends SupervisedSession = SupervisedSession> {
    readonly initialEvent: TailEvent;
    readonly session: TSession;
    readonly sessionId: string;
    readonly source: RuntimeActivationSource;
}
interface SessionSupervisorLogger {
    error(message: string, error?: unknown): void;
    info(message: string): void;
}
type MaybePromise<T> = Promise<T> | T;
interface SessionSupervisorOptions<TSession extends SupervisedSession = SupervisedSession> {
    readonly bindSession: (sessionId: string) => Promise<TSession>;
    readonly createRuntime: (activation: RuntimeActivation<TSession>) => SupervisedRuntime;
    readonly discoverInitialSessionIds?: () => Promise<readonly string[]> | readonly string[];
    readonly historySettle?: HistorySettleOptions;
    readonly isSessionActive?: (sessionId: string) => MaybePromise<boolean>;
    readonly logger?: SessionSupervisorLogger;
    readonly shouldStartRuntime: (event: TailEvent, session: TSession) => MaybePromise<boolean>;
    readonly shouldStartRuntimeFromHistory?: (session: TSession) => MaybePromise<boolean>;
    readonly subscribeDiscoveredSessionIds?: (listener: (sessionId: string) => void) => () => void;
    readonly subscribeReleasedSessionIds?: (listener: (sessionId: string) => void) => () => void;
}
declare class StarciteSessionSupervisor<TSession extends SupervisedSession = SupervisedSession> {
    private readonly bindSession;
    private readonly createRuntime;
    private readonly discoverInitialSessionIds;
    private readonly historySettle;
    private readonly isSessionActive;
    private readonly logger;
    private readonly shouldStartRuntime;
    private readonly shouldStartRuntimeFromHistory;
    private readonly subscribeReleasedSessionIds;
    private readonly subscribeDiscoveredSessionIds;
    private discoveryUnsub;
    private releaseUnsub;
    private readonly pendingSessionIds;
    private readonly releasedSessionIds;
    private readonly runtimes;
    private readonly watchers;
    constructor(options: SessionSupervisorOptions<TSession>);
    start(): Promise<void>;
    stop(): void;
    private watchSession;
    private releaseSession;
    private awaitSessionHistorySettled;
    private startRuntime;
}

export { type HistorySettleOptions, type RuntimeActivation, type RuntimeActivationSource, type SessionSupervisorLogger, type SessionSupervisorOptions, StarciteSessionSupervisor, type SupervisedRuntime, type SupervisedSession };
