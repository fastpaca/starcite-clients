// src/index.ts
var DEFAULT_HISTORY_SETTLE = {
  idleWindowMs: 100,
  minWaitMs: 500,
  pollIntervalMs: 25,
  timeoutMs: 1500
};
function sleep(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
var StarciteSessionSupervisor = class {
  bindSession;
  createRuntime;
  discoverInitialSessionIds;
  historySettle;
  isSessionActive;
  logger;
  shouldStartRuntime;
  shouldStartRuntimeFromHistory;
  subscribeReleasedSessionIds;
  subscribeDiscoveredSessionIds;
  discoveryUnsub;
  releaseUnsub;
  pendingSessionIds = /* @__PURE__ */ new Set();
  releasedSessionIds = /* @__PURE__ */ new Set();
  runtimes = /* @__PURE__ */ new Map();
  watchers = /* @__PURE__ */ new Map();
  constructor(options) {
    this.bindSession = options.bindSession;
    this.createRuntime = options.createRuntime;
    this.discoverInitialSessionIds = options.discoverInitialSessionIds;
    this.historySettle = {
      ...DEFAULT_HISTORY_SETTLE,
      ...options.historySettle ?? {}
    };
    this.isSessionActive = options.isSessionActive ?? (() => true);
    this.logger = options.logger;
    this.shouldStartRuntime = options.shouldStartRuntime;
    this.shouldStartRuntimeFromHistory = options.shouldStartRuntimeFromHistory;
    this.subscribeReleasedSessionIds = options.subscribeReleasedSessionIds;
    this.subscribeDiscoveredSessionIds = options.subscribeDiscoveredSessionIds;
  }
  async start() {
    const initialSessionIds = await this.discoverInitialSessionIds?.();
    if (initialSessionIds) {
      for (const sessionId of initialSessionIds) {
        await this.watchSession(sessionId);
      }
    }
    this.discoveryUnsub = this.subscribeDiscoveredSessionIds?.((sessionId) => {
      this.watchSession(sessionId).catch((error) => {
        this.logger?.error(
          `[starcite-session-supervisor] failed to watch session ${sessionId}`,
          error
        );
      });
    });
    this.releaseUnsub = this.subscribeReleasedSessionIds?.((sessionId) => {
      this.releaseSession(sessionId);
    });
  }
  stop() {
    this.discoveryUnsub?.();
    this.discoveryUnsub = void 0;
    this.releaseUnsub?.();
    this.releaseUnsub = void 0;
    for (const [, managedRuntime] of this.runtimes) {
      managedRuntime.runtime.stop();
    }
    this.runtimes.clear();
    for (const [, watcher] of this.watchers) {
      watcher.unsubscribe();
      watcher.session.disconnect();
    }
    this.watchers.clear();
    this.pendingSessionIds.clear();
    this.releasedSessionIds.clear();
  }
  async watchSession(sessionId) {
    if (!await this.isSessionActive(sessionId)) {
      return;
    }
    if (this.pendingSessionIds.has(sessionId) || this.watchers.has(sessionId) || this.runtimes.has(sessionId)) {
      return;
    }
    this.releasedSessionIds.delete(sessionId);
    this.pendingSessionIds.add(sessionId);
    try {
      const session = await this.bindSession(sessionId);
      if (this.releasedSessionIds.has(sessionId) || !await this.isSessionActive(sessionId)) {
        session.disconnect();
        return;
      }
      if (this.historySettle.minWaitMs > 0) {
        await sleep(this.historySettle.minWaitMs);
      }
      const historyFloorSeq = await this.awaitSessionHistorySettled(session);
      if (this.releasedSessionIds.has(sessionId)) {
        session.disconnect();
        return;
      }
      if (await this.shouldStartRuntimeFromHistory?.(session) ?? false) {
        const retainedEvents = [...session.events()].sort(
          (left, right) => right.seq - left.seq
        );
        for (const event of retainedEvents) {
          if (await this.shouldStartRuntime(event, session)) {
            this.startRuntime({
              initialEvent: event,
              session,
              sessionId,
              source: "history"
            });
            return;
          }
        }
      }
      const unsubscribe = session.on(
        "event",
        async (event) => {
          if (event.seq <= historyFloorSeq) {
            return;
          }
          if (!await this.isSessionActive(sessionId)) {
            return;
          }
          if (!await this.shouldStartRuntime(event, session)) {
            return;
          }
          this.startRuntime({
            initialEvent: event,
            session,
            sessionId,
            source: "live"
          });
        },
        { replay: false }
      );
      this.watchers.set(sessionId, {
        session,
        unsubscribe
      });
      this.logger?.info(
        `[starcite-session-supervisor] watching session ${sessionId}`
      );
    } finally {
      this.pendingSessionIds.delete(sessionId);
    }
  }
  releaseSession(sessionId) {
    this.releasedSessionIds.add(sessionId);
    const watcher = this.watchers.get(sessionId);
    if (watcher) {
      watcher.unsubscribe();
      watcher.session.disconnect();
      this.watchers.delete(sessionId);
    }
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.runtime.stop();
      this.runtimes.delete(sessionId);
    }
    this.logger?.info(
      `[starcite-session-supervisor] released session ${sessionId}`
    );
  }
  async awaitSessionHistorySettled(session) {
    const deadline = Date.now() + this.historySettle.timeoutMs;
    let previousLastSeq = -1;
    let stableSinceMs = Date.now();
    while (Date.now() < deadline) {
      const lastSeq = session.log.lastSeq;
      if (lastSeq !== previousLastSeq) {
        previousLastSeq = lastSeq;
        stableSinceMs = Date.now();
      } else if (Date.now() - stableSinceMs >= this.historySettle.idleWindowMs) {
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
  startRuntime(activation) {
    const watcher = this.watchers.get(activation.sessionId);
    if (watcher) {
      watcher.unsubscribe();
      this.watchers.delete(activation.sessionId);
    }
    if (this.runtimes.has(activation.sessionId)) {
      return;
    }
    const runtime = this.createRuntime(activation);
    this.runtimes.set(activation.sessionId, {
      runtime,
      session: activation.session
    });
    this.logger?.info(
      `[starcite-session-supervisor] started runtime for session ${activation.sessionId}`
    );
  }
};
export {
  StarciteSessionSupervisor
};
//# sourceMappingURL=index.js.map