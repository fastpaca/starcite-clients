const COORDINATOR_AGENT = "coordinator";
const AGENT_PALETTE = [
  { accent: "#0f6f66", surface: "rgba(15, 111, 102, 0.14)" },
  { accent: "#9a4f96", surface: "rgba(154, 79, 150, 0.14)" },
  { accent: "#2966a3", surface: "rgba(41, 102, 163, 0.14)" },
  { accent: "#b84d28", surface: "rgba(184, 77, 40, 0.14)" },
  { accent: "#867221", surface: "rgba(134, 114, 33, 0.14)" },
];
const MARKDOWN_CACHE_LIMIT = 120;
const markdownCache = new Map();

const state = {
  sessionId: null,
  token: null,
  apiBaseUrl: null,
  websocketUrl: null,
  socket: null,
  channel: null,
  eventsBySeq: new Map(),
  cursor: 0,
  streamStatus: "booting",
  runStatus: "idle",
  statusTimer: null,
  tailAttempt: 0,
  renderScheduled: false,
  transcriptSignature: null,
  liveSignature: null,
  assignmentSignature: null,
  legendSignature: null,
};

const els = {
  sessionId: document.querySelector("#session-id"),
  streamStatus: document.querySelector("#stream-status"),
  runStatus: document.querySelector("#run-status"),
  apiBaseUrl: document.querySelector("#api-base-url"),
  websocketUrl: document.querySelector("#websocket-url"),
  eventCount: document.querySelector("#event-count"),
  workerCount: document.querySelector("#worker-count"),
  assignmentStack: document.querySelector("#assignment-stack"),
  workerLegend: document.querySelector("#worker-legend"),
  feed: document.querySelector("#feed"),
  emptyFeed: document.querySelector("#empty-feed"),
  streamGrid: document.querySelector("#stream-grid"),
  emptyLive: document.querySelector("#empty-live"),
  liveCount: document.querySelector("#live-count"),
  notice: document.querySelector("#notice"),
  prompt: document.querySelector("#prompt"),
  submitButton: document.querySelector("#submit-button"),
  composer: document.querySelector("#composer"),
  newSession: document.querySelector("#new-session"),
  copyLink: document.querySelector("#copy-link"),
};

window.addEventListener("DOMContentLoaded", () => {
  attachUi();
  void bootstrap();
});

function attachUi() {
  els.composer?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPrompt();
  });

  els.newSession?.addEventListener("click", () => {
    void startNewSession();
  });

  els.copyLink?.addEventListener("click", async () => {
    if (!state.sessionId) {
      setNotice("Create a session first before copying a share link.");
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("sessionId", state.sessionId);
    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice("Share link copied.");
    } catch {
      setNotice(url.toString());
    }
  });
}

async function bootstrap() {
  setNotice("");
  const sessionId = new URLSearchParams(window.location.search).get("sessionId");
  await bindSession(sessionId);
  startStatusPolling();
}

function clearSessionBinding() {
  state.sessionId = null;
  state.token = null;
  state.apiBaseUrl = null;
  state.websocketUrl = null;
  state.runStatus = "idle";
}

async function startNewSession() {
  disconnectTail();
  clearSessionBinding();
  state.eventsBySeq.clear();
  state.cursor = 0;
  resetPresentationCache();
  render();
  await bindSession(null);
}

async function bindSession(sessionId) {
  setStreamStatus("minting");
  els.submitButton.disabled = true;
  state.runStatus = "idle";

  let response;
  try {
    response = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId || undefined,
        title: "LangChain Research Swarm",
      }),
    });
  } catch {
    setNotice("Could not reach the FastAPI session endpoint.");
    setStreamStatus("offline");
    els.submitButton.disabled = !state.sessionId;
    return;
  }

  if (!response.ok) {
    const message = await readError(response);
    setNotice(message);
    setStreamStatus("offline");
    els.submitButton.disabled = !state.sessionId;
    return;
  }

  const payload = await response.json();
  state.sessionId = payload.session_id;
  state.token = payload.token;
  state.apiBaseUrl = payload.api_base_url;
  state.websocketUrl = payload.websocket_url;
  state.eventsBySeq.clear();
  state.cursor = 0;
  resetPresentationCache();

  const url = new URL(window.location.href);
  url.searchParams.set("sessionId", state.sessionId);
  window.history.replaceState({}, "", url);

  render();
  await refreshStatus();
  connectTail({ reconnect: false });
}

function connectTail({ reconnect }) {
  disconnectTail();

  if (!state.sessionId || !state.token || !state.websocketUrl) {
    return;
  }

  const SocketCtor = window.Phoenix?.Socket;
  if (typeof SocketCtor !== "function") {
    setNotice("Phoenix browser client did not load.");
    setStreamStatus("offline");
    return;
  }

  const attempt = state.tailAttempt + 1;
  state.tailAttempt = attempt;
  setStreamStatus(reconnect ? "reconnecting" : "connecting");

  const socket = new SocketCtor(state.websocketUrl, {
    params: { token: state.token },
    reconnectAfterMs: (tries) => [300, 800, 1800, 3200, 5000][tries - 1] ?? 5000,
  });
  let joined = false;

  socket.onOpen(() => {
    if (!isCurrentTailAttempt(socket, attempt)) {
      return;
    }
    if (joined) {
      setStreamStatus("live");
      clearNoticeIfConnectionOnly();
    }
  });

  socket.onError(() => {
    if (!isCurrentTailAttempt(socket, attempt)) {
      return;
    }
    if (joined || state.streamStatus === "live") {
      setStreamStatus("reconnecting");
    }
  });

  socket.onClose(() => {
    if (!isCurrentTailAttempt(socket, attempt)) {
      return;
    }
    if (joined && state.streamStatus === "live") {
      setStreamStatus("reconnecting");
    }
  });

  socket.connect();

  const channel = socket.channel(`tail:${state.sessionId}`, {
    cursor: state.cursor || 0,
  });

  channel.on("events", (payload) => {
    if (!Array.isArray(payload?.events)) {
      return;
    }

    for (const event of payload.events) {
      if (typeof event?.seq !== "number") {
        continue;
      }
      state.eventsBySeq.set(event.seq, event);
      if (typeof event.cursor === "number") {
        state.cursor = event.cursor;
      }
    }

    scheduleRender();
  });

  channel.on("gap", (payload) => {
    if (typeof payload?.next_cursor === "number") {
      state.cursor = payload.next_cursor;
    }
    setNotice("Tail gap detected. Rejoining Starcite from the updated cursor.");
    reconnectTail();
  });

  channel.on("token_expired", async () => {
    setNotice("Session token expired. Reissuing a token and reconnecting.");
    await bindSession(state.sessionId);
  });

  channel
    .join()
    .receive("ok", () => {
      if (!isCurrentTailAttempt(socket, attempt)) {
        return;
      }
      joined = true;
      setStreamStatus("live");
      els.submitButton.disabled = false;
      clearNoticeIfConnectionOnly();
    })
    .receive("error", async (error) => {
      if (!isCurrentTailAttempt(socket, attempt)) {
        return;
      }
      setStreamStatus("offline");
      setNotice(`Tail join failed: ${readJoinReason(error)}`);
      if (state.sessionId) {
        await bindSession(state.sessionId);
      }
    })
    .receive("timeout", () => {
      if (!isCurrentTailAttempt(socket, attempt)) {
        return;
      }
      setStreamStatus("offline");
      setNotice("Tail join timed out.");
    });

  state.socket = socket;
  state.channel = channel;
}

function reconnectTail() {
  connectTail({ reconnect: true });
}

function disconnectTail() {
  const channel = state.channel;
  const socket = state.socket;
  state.channel = null;
  state.socket = null;
  channel?.leave();
  socket?.disconnect();
}

function startStatusPolling() {
  if (state.statusTimer !== null) {
    window.clearInterval(state.statusTimer);
  }

  state.statusTimer = window.setInterval(() => {
    void refreshStatus();
  }, 2000);
}

async function refreshStatus() {
  if (!state.sessionId) {
    return;
  }

  let response;
  try {
    response = await fetch(`/sessions/${encodeURIComponent(state.sessionId)}`);
  } catch {
    return;
  }

  if (!response.ok) {
    return;
  }

  const payload = await response.json();
  state.runStatus = payload.running ? "running" : "idle";
  renderStatus();
}

async function submitPrompt() {
  const text = els.prompt.value.trim();
  if (!text || !state.sessionId) {
    return;
  }

  els.submitButton.disabled = true;
  setNotice("");

  const response = await fetch(
    `/sessions/${encodeURIComponent(state.sessionId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );

  if (!response.ok) {
    setNotice(await readError(response));
    els.submitButton.disabled = false;
    return;
  }

  els.prompt.value = "";
  state.runStatus = "running";
  renderStatus();
}

function render() {
  const events = orderedEvents();
  const presentation = derivePresentation(events);

  renderStatus(events);
  renderAssignments(presentation.assignments);
  renderLiveStreams(presentation.live);
  renderFeed(presentation.committed);
  renderLegend(events);
}

function renderStatus(events = orderedEvents()) {
  setText(els.sessionId, state.sessionId ?? "booting");
  setText(els.streamStatus, state.streamStatus);
  setText(els.runStatus, state.runStatus);
  setText(els.apiBaseUrl, state.apiBaseUrl ?? "pending");
  setText(els.websocketUrl, state.websocketUrl ?? "pending");
  setText(els.eventCount, String(state.eventsBySeq.size));

  const workerNames = new Set(
    events
      .flatMap((event) => {
        const payload = asObject(event.payload);
        const agent = asString(payload.agent);
        return agent && agent !== COORDINATOR_AGENT ? [agent] : [];
      }),
  );
  setText(els.workerCount, String(workerNames.size));
}

function renderAssignments(assignments) {
  const stack = els.assignmentStack;
  if (!stack) {
    return;
  }
  const signature = signatureOf(assignments);
  if (signature === state.assignmentSignature) {
    return;
  }
  state.assignmentSignature = signature;
  stack.innerHTML = "";

  if (assignments.length === 0) {
    stack.append(emptyNote("Fanout pending."));
    return;
  }

  for (const assignment of assignments) {
    const card = document.createElement("article");
    card.className = "assignment-card";

    const name = document.createElement("strong");
    name.textContent = assignment.name;

    const prompt = document.createElement("p");
    prompt.textContent = assignment.prompt;

    card.append(name, prompt);
    stack.append(card);
  }
}

function renderLegend(events) {
  const entries = [...activeAgentPalette(events).entries()];
  const signature = signatureOf(entries.map(([agent]) => agent));
  if (signature === state.legendSignature) {
    return;
  }
  state.legendSignature = signature;

  const legend = els.workerLegend;
  if (!legend) {
    return;
  }
  legend.innerHTML = "";

  for (const [agent, meta] of entries) {
    const chip = document.createElement("span");
    chip.className = "legend-chip";
    chip.style.setProperty("--swatch", meta.accent);
    chip.textContent = agent === COORDINATOR_AGENT ? "Coordinator" : agent;
    legend.append(chip);
  }
}

function renderLiveStreams(entries) {
  setText(
    els.liveCount,
    `${entries.length} active stream${entries.length === 1 ? "" : "s"}`,
  );
  if (els.emptyLive) {
    els.emptyLive.hidden = entries.length > 0;
  }

  const signature = signatureOf(
    entries.map((entry) => ({
      agent: entry.agent,
      name: entry.name,
      seq: entry.seq,
      text: entry.text,
    })),
  );
  if (signature === state.liveSignature) {
    return;
  }
  state.liveSignature = signature;

  const grid = els.streamGrid;
  if (!grid) {
    return;
  }
  const existing = new Map(
    [...grid.querySelectorAll("[data-live-agent]")].map((node) => [node.dataset.liveAgent, node]),
  );
  const seen = new Set();

  for (const entry of entries) {
    let card = existing.get(entry.agent);
    if (!card) {
      card = document.createElement("article");
      card.className = "stream-card";
      card.dataset.liveAgent = entry.agent;

      const meta = document.createElement("div");
      meta.className = "stream-meta";

      const name = document.createElement("strong");
      const status = document.createElement("span");
      const body = document.createElement("div");
      body.className = "stream-body markdown-body";

      meta.append(name, status);
      card.append(meta, body);
      grid.append(card);
    }

    updateLiveCard(card, entry);
    seen.add(entry.agent);
  }

  for (const [agent, node] of existing) {
    if (!seen.has(agent)) {
      node.remove();
    }
  }
}

function updateLiveCard(card, entry) {
  const palette = colorForAgent(entry.agent);
  card.style.setProperty("--agent-accent", palette.accent);
  card.style.setProperty("--agent-surface", palette.surface);

  const [meta, body] = card.children;
  const [name, status] = meta.children;
  name.textContent = entry.name;
  status.textContent = `streaming · seq ${entry.seq}`;
  setMarkdown(body, entry.text, { cache: false });
}

function renderFeed(entries) {
  const feed = els.feed;
  if (!feed) {
    return;
  }
  const signature = signatureOf(
    entries.map((entry) => ({
      kind: entry.kind,
      agent: entry.agent,
      name: entry.name,
      seq: entry.seq,
      text: entry.text ?? "",
      assignments: entry.assignments ?? [],
    })),
  );
  if (signature === state.transcriptSignature) {
    return;
  }
  state.transcriptSignature = signature;

  const shouldStick =
    feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 96;
  feed.innerHTML = "";

  if (entries.length === 0) {
    feed.append(els.emptyFeed);
    return;
  }

  for (const entry of entries) {
    feed.append(renderCard(entry));
  }

  if (shouldStick) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function renderCard(entry) {
  const card = document.createElement("article");
  const palette = colorForAgent(entry.agent);
  card.className = `feed-card ${entry.kind}`;
  card.style.setProperty("--agent-accent", palette.accent);
  card.style.setProperty("--agent-surface", palette.surface);

  const meta = document.createElement("div");
  meta.className = "feed-meta";

  const title = document.createElement("strong");
  title.textContent = entry.name;

  const seq = document.createElement("span");
  seq.textContent = `seq ${entry.seq}`;
  meta.append(title, seq);
  card.append(meta);

  if (entry.kind === "plan") {
    const list = document.createElement("ol");
    list.className = "plan-list";
    for (const assignment of entry.assignments) {
      const item = document.createElement("li");
      item.textContent = `${assignment.name}: ${assignment.prompt}`;
      list.append(item);
    }
    card.append(list);
    return card;
  }

  const body = document.createElement("div");
  body.className = "feed-text markdown-body";
  setMarkdown(body, entry.text);
  card.append(body);
  return card;
}

function derivePresentation(events) {
  const committed = [];
  const liveByAgent = new Map();
  let assignments = [];

  for (const event of events) {
    const payload = asObject(event.payload);

    if (event.type === "message.user") {
      committed.push({
        kind: "user",
        agent: "user",
        name: "You",
        seq: event.seq,
        text: asString(payload.text),
      });
      continue;
    }

    if (event.type === "agent.plan") {
      assignments = Array.isArray(payload.assignments)
        ? payload.assignments
            .map((assignment) => asObject(assignment))
            .filter((assignment) => asString(assignment.name) && asString(assignment.prompt))
            .map((assignment) => ({
              name: asString(assignment.name),
              prompt: asString(assignment.prompt),
            }))
        : [];

      committed.push({
        kind: "plan",
        agent: COORDINATOR_AGENT,
        name: "Coordinator Plan",
        seq: event.seq,
        assignments,
      });
      continue;
    }

    if (event.type === "agent.error") {
      committed.push({
        kind: "error",
        agent: COORDINATOR_AGENT,
        name: "Coordinator Error",
        seq: event.seq,
        text: asString(payload.message) || "Unknown error.",
      });
      continue;
    }

    if (event.type !== "agent.streaming.chunk" && event.type !== "agent.done") {
      continue;
    }

    const agent = asString(payload.agent);
    if (!agent) {
      continue;
    }

    if (event.type === "agent.streaming.chunk") {
      const current = liveByAgent.get(agent);
      liveByAgent.set(agent, {
        kind: agent === COORDINATOR_AGENT ? "coordinator" : "worker",
        agent,
        name: asString(payload.name) || agent,
        seq: current?.seq ?? event.seq,
        text: `${current?.text ?? ""}${asString(payload.delta)}`,
      });
      continue;
    }

    const current = liveByAgent.get(agent);
    liveByAgent.delete(agent);
    const text = asString(payload.text) || current?.text || "";
    if (!text) {
      continue;
    }

    committed.push({
      kind: agent === COORDINATOR_AGENT ? "coordinator" : "worker",
      agent,
      name: asString(payload.name) || current?.name || agent,
      seq: event.seq,
      text,
    });
  }

  return {
    assignments,
    committed,
    live: [...liveByAgent.values()],
  };
}

function orderedEvents() {
  return [...state.eventsBySeq.values()].sort((left, right) => left.seq - right.seq);
}

function activeAgentPalette(events = orderedEvents()) {
  const entries = new Map();
  for (const event of events) {
    const payload = asObject(event.payload);
    const agent = asString(payload.agent);
    if (!agent) {
      continue;
    }
    entries.set(agent, colorForAgent(agent));
  }
  if (!entries.has(COORDINATOR_AGENT)) {
    entries.set(COORDINATOR_AGENT, colorForAgent(COORDINATOR_AGENT));
  }
  return entries;
}

function colorForAgent(agent) {
  if (agent === "user") {
    return { accent: "#2d2117", surface: "rgba(34, 22, 15, 0.12)" };
  }
  if (agent === COORDINATOR_AGENT) {
    return { accent: "#b84d28", surface: "rgba(184, 77, 40, 0.14)" };
  }

  const hash = [...agent].reduce((total, char) => total + char.charCodeAt(0), 0);
  return AGENT_PALETTE[hash % AGENT_PALETTE.length];
}

function scheduleRender() {
  if (state.renderScheduled) {
    return;
  }

  state.renderScheduled = true;
  window.requestAnimationFrame(() => {
    state.renderScheduled = false;
    render();
  });
}

function resetPresentationCache() {
  state.transcriptSignature = null;
  state.liveSignature = null;
  state.assignmentSignature = null;
  state.legendSignature = null;
}

function signatureOf(value) {
  return JSON.stringify(value);
}

function setStreamStatus(value) {
  if (state.streamStatus === value) {
    return;
  }
  state.streamStatus = value;
  renderStatus();
}

function isCurrentTailAttempt(socket, attempt) {
  return state.socket === socket && state.tailAttempt === attempt;
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function setMarkdown(element, text, { cache = true } = {}) {
  if (!element) {
    return;
  }
  if (element.dataset.markdownSource === text) {
    return;
  }
  element.dataset.markdownSource = text;
  element.innerHTML = renderMarkdown(text, { cache });
}

function renderMarkdown(text, { cache = true } = {}) {
  const source =
    typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  if (!source.trim()) {
    return "";
  }
  if (cache) {
    const cached = markdownCache.get(source);
    if (cached !== undefined) {
      return cached;
    }
  }

  const rendered = renderMarkdownHtml(source);
  if (cache) {
    markdownCache.set(source, rendered);
    if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
      const oldestKey = markdownCache.keys().next().value;
      if (oldestKey !== undefined) {
        markdownCache.delete(oldestKey);
      }
    }
  }
  return rendered;
}

function renderMarkdownHtml(source) {
  const markedApi = window.marked;
  const sanitizer = window.DOMPurify;

  if (
    markedApi &&
    typeof markedApi.parse === "function" &&
    sanitizer &&
    typeof sanitizer.sanitize === "function"
  ) {
    try {
      const rawHtml = markedApi.parse(source, {
        async: false,
        breaks: true,
        gfm: true,
      });
      return sanitizer.sanitize(rawHtml);
    } catch {
      return renderPlaintextHtml(source);
    }
  }

  return renderPlaintextHtml(source);
}

function renderPlaintextHtml(source) {
  return `<p>${escapeHtml(source).replaceAll("\n", "<br>")}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setNotice(message) {
  if (!message) {
    els.notice.hidden = true;
    els.notice.textContent = "";
    return;
  }

  els.notice.hidden = false;
  els.notice.textContent = message;
}

function clearNoticeIfConnectionOnly() {
  if (els.notice.textContent?.startsWith("Tail ")) {
    setNotice("");
  }
}

function emptyNote(message) {
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = message;
  return note;
}

async function readError(response) {
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string") {
      return payload.detail;
    }
    if (typeof payload?.error === "string") {
      return payload.error;
    }
  } catch {}

  return `Request failed (${response.status}).`;
}

function readJoinReason(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    if (typeof payload.reason === "string") {
      return payload.reason;
    }
    if (typeof payload.message === "string") {
      return payload.message;
    }
  }
  return "join failed";
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}
