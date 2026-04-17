import {
  type SessionActivatedLifecycleEvent,
  type SessionArchivedLifecycleEvent,
  type SessionCreatedLifecycleEvent,
  type SessionFrozenLifecycleEvent,
  type SessionUnarchivedLifecycleEvent,
  StarciteIdentity,
  type TailEvent,
} from "@starcite/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  SessionAgent,
  type SessionAgentSession,
  SessionAgentSupervisor,
} from "../src/index";

type LifecycleEvent =
  | SessionActivatedLifecycleEvent
  | SessionArchivedLifecycleEvent
  | SessionCreatedLifecycleEvent
  | SessionFrozenLifecycleEvent
  | SessionUnarchivedLifecycleEvent;

function createAgentIdentity(): StarciteIdentity {
  return new StarciteIdentity({
    id: "assistant",
    tenantId: "tenant_1",
    type: "agent",
  });
}

function createSessionEvent(
  seq: number,
  input: {
    readonly actor?: string;
    readonly text?: string;
    readonly type?: string;
  } = {}
): TailEvent {
  return {
    actor: input.actor ?? "user:selund",
    inserted_at: "2026-04-08T10:00:00.000Z",
    payload: {
      text: input.text ?? `event-${seq}`,
    },
    producer_id: "producer-1",
    producer_seq: seq,
    seq,
    source: "user",
    type: input.type ?? "message.user",
  };
}

class FakeSession implements SessionAgentSession {
  readonly id: string;
  readonly log: { lastSeq: number };
  disconnected = false;
  readonly replayOptionHistory: boolean[] = [];
  private readonly retainedEvents: TailEvent[] = [];
  private readonly eventListeners = new Set<
    (event: TailEvent) => void | Promise<void>
  >();

  constructor(id: string, events: readonly TailEvent[] = []) {
    this.id = id;
    this.log = {
      lastSeq: events.reduce((maxSeq, event) => Math.max(maxSeq, event.seq), 0),
    };
    this.retainedEvents.push(...events);
  }

  readonly on: SessionAgentSession["on"] = ((eventName, listener, options) => {
    if (eventName !== "event") {
      throw new Error(`Unsupported event listener: ${eventName}`);
    }

    this.replayOptionHistory.push(options?.replay ?? true);
    const eventListener = listener as (event: TailEvent) => void;
    this.eventListeners.add(eventListener);

    return () => {
      this.eventListeners.delete(eventListener);
    };
  }) as SessionAgentSession["on"];

  disconnect(): void {
    this.disconnected = true;
  }

  events(): readonly TailEvent[] {
    return this.retainedEvents;
  }

  async emitEvent(event: TailEvent): Promise<void> {
    this.retainedEvents.push(event);
    this.log.lastSeq = Math.max(this.log.lastSeq, event.seq);
    for (const listener of this.eventListeners) {
      await listener(event);
    }
  }

  get listenerCount(): number {
    return this.eventListeners.size;
  }
}

class FakeStarcite {
  readonly sessions = new Map<string, FakeSession>();
  readonly listeners = new Map<string, Set<(event: LifecycleEvent) => void>>();
  readonly sessionCalls: string[] = [];

  on(
    eventName:
      | "session.activated"
      | "session.archived"
      | "session.created"
      | "session.frozen"
      | "session.unarchived",
    listener: (event: LifecycleEvent) => void
  ): () => void {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  session(input: {
    readonly id: string;
    readonly identity: StarciteIdentity;
  }): Promise<FakeSession> {
    this.sessionCalls.push(`${input.identity.toActor()}:${input.id}`);
    const session = this.sessions.get(input.id);
    if (!session) {
      throw new Error(`Unknown session: ${input.id}`);
    }

    return Promise.resolve(session);
  }

  async emit(
    eventName:
      | "session.activated"
      | "session.archived"
      | "session.created"
      | "session.frozen"
      | "session.unarchived",
    sessionId: string
  ): Promise<void> {
    const listeners = this.listeners.get(eventName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      await listener({
        kind: eventName,
        session_id: sessionId,
      } as LifecycleEvent);
    }
  }
}

class RecordingAgent extends SessionAgent<FakeSession> {
  override readonly archive = vi.fn(async () => undefined);
  readonly received: number[] = [];
  override readonly shutdown = vi.fn(async () => undefined);
  override readonly start = vi.fn(async () => undefined);
  override readonly stop = vi.fn(async () => undefined);
  override readonly unarchive = vi.fn(async () => undefined);

  override receive(event: TailEvent): void {
    this.received.push(event.seq);
  }
}

class ChatAgent extends SessionAgent<FakeSession> {
  readonly seenTexts: string[] = [];

  override receive(event: TailEvent): void {
    const payload = event.payload;
    this.seenTexts.push(
      typeof payload.text === "string" ? payload.text : "unknown"
    );
  }
}

function createHistorySettleOptions() {
  return {
    idleWindowMs: 0,
    minWaitMs: 0,
    pollIntervalMs: 0,
    timeoutMs: 0,
  };
}

describe("SessionAgentSupervisor", () => {
  it("restores sessions and replays retained events before live delivery", async () => {
    const starcite = new FakeStarcite();
    const session = new FakeSession("ses_a", [
      createSessionEvent(1),
      createSessionEvent(2),
    ]);
    starcite.sessions.set("ses_a", session);

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      restoreSessionIds: () => ["ses_a"],
      starcite,
    });

    await supervisor.start();

    const agent = supervisor.get("ses_a");
    expect(agent).toBeInstanceOf(RecordingAgent);
    expect(agent?.start).toHaveBeenCalledTimes(1);
    expect((agent as RecordingAgent | undefined)?.received).toEqual([1, 2]);
    expect(session.replayOptionHistory).toEqual([false]);

    await session.emitEvent(createSessionEvent(3));

    expect((agent as RecordingAgent | undefined)?.received).toEqual([1, 2, 3]);
  });

  it("ignores events emitted by the supervised agent identity", async () => {
    const starcite = new FakeStarcite();
    const session = new FakeSession("ses_self", [
      createSessionEvent(1, { actor: "agent:assistant" }),
      createSessionEvent(2),
    ]);
    starcite.sessions.set("ses_self", session);

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      restoreSessionIds: () => ["ses_self"],
      starcite,
    });

    await supervisor.start();
    await session.emitEvent(
      createSessionEvent(3, { actor: "agent:assistant" })
    );
    await session.emitEvent(createSessionEvent(4));

    const agent = supervisor.get("ses_self") as RecordingAgent | undefined;
    expect(agent?.received).toEqual([2, 4]);
  });

  it("reuses the same agent across freeze and re-activation without replaying already delivered events", async () => {
    const starcite = new FakeStarcite();
    const session = new FakeSession("ses_cycle", [createSessionEvent(1)]);
    starcite.sessions.set("ses_cycle", session);

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      restoreSessionIds: () => ["ses_cycle"],
      starcite,
    });

    await supervisor.start();
    const agent = supervisor.get("ses_cycle");
    expect(agent).toBeInstanceOf(RecordingAgent);

    await session.emitEvent(createSessionEvent(2));
    await starcite.emit("session.frozen", "ses_cycle");
    await session.emitEvent(createSessionEvent(3));
    await starcite.emit("session.activated", "ses_cycle");

    expect(supervisor.get("ses_cycle")).toBe(agent);
    expect((agent as RecordingAgent | undefined)?.start).toHaveBeenCalledTimes(
      2
    );
    expect((agent as RecordingAgent | undefined)?.stop).toHaveBeenCalledWith(
      "frozen"
    );
    expect((agent as RecordingAgent | undefined)?.received).toEqual([1, 2, 3]);
  });

  it("routes archive and unarchive lifecycle transitions to the same agent", async () => {
    const starcite = new FakeStarcite();
    starcite.sessions.set("ses_archive", new FakeSession("ses_archive"));

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      starcite,
    });

    await supervisor.start();
    await starcite.emit("session.created", "ses_archive");
    await starcite.emit("session.archived", "ses_archive");
    await starcite.emit("session.unarchived", "ses_archive");

    const agent = supervisor.get("ses_archive") as RecordingAgent | undefined;
    expect(agent?.archive).toHaveBeenCalledTimes(1);
    expect(agent?.unarchive).toHaveBeenCalledTimes(1);
  });

  it("shuts down and removes a single session agent on demand", async () => {
    const starcite = new FakeStarcite();
    starcite.sessions.set("ses_shutdown", new FakeSession("ses_shutdown"));

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      restoreSessionIds: () => ["ses_shutdown"],
      starcite,
    });

    await supervisor.start();
    const agent = supervisor.get("ses_shutdown") as RecordingAgent | undefined;

    await supervisor.shutdownSession("ses_shutdown");

    expect(agent?.stop).toHaveBeenCalledWith("shutdown");
    expect(agent?.shutdown).toHaveBeenCalledTimes(1);
    expect(supervisor.get("ses_shutdown")).toBeUndefined();
  });

  it("shuts down all agents when the supervisor stops", async () => {
    const starcite = new FakeStarcite();
    starcite.sessions.set("ses_a", new FakeSession("ses_a"));
    starcite.sessions.set("ses_b", new FakeSession("ses_b"));

    const supervisor = new SessionAgentSupervisor({
      Agent: RecordingAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      restoreSessionIds: () => ["ses_a", "ses_b"],
      starcite,
    });

    await supervisor.start();
    const first = supervisor.get("ses_a") as RecordingAgent | undefined;
    const second = supervisor.get("ses_b") as RecordingAgent | undefined;

    await supervisor.stop();

    expect(first?.stop).toHaveBeenCalledWith("shutdown");
    expect(second?.stop).toHaveBeenCalledWith("shutdown");
    expect(first?.shutdown).toHaveBeenCalledTimes(1);
    expect(second?.shutdown).toHaveBeenCalledTimes(1);
    expect(supervisor.get("ses_a")).toBeUndefined();
    expect(supervisor.get("ses_b")).toBeUndefined();
  });

  it("skips unmanaged sessions", async () => {
    const starcite = new FakeStarcite();
    starcite.sessions.set("ses_ignore", new FakeSession("ses_ignore"));

    const supervisor = new SessionAgentSupervisor({
      Agent: ChatAgent,
      agent: createAgentIdentity(),
      historySettle: createHistorySettleOptions(),
      manages: (sessionId) => sessionId !== "ses_ignore",
      starcite,
    });

    await supervisor.start();
    await starcite.emit("session.activated", "ses_ignore");

    expect(supervisor.get("ses_ignore")).toBeUndefined();
  });
});
