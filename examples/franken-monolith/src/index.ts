import { Starcite, type SessionEvent, type StarciteSession } from "@starcite/sdk";
import { EV, plStr, textOf } from "./contracts";
import { OpenAIRuntime } from "./openai-responses";
import { ResponsesWorker, type WorkerSessions } from "./responses-worker";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = require(args.prompt ?? process.env.LIVE_PROMPT, "Missing --prompt or LIVE_PROMPT");
  const openaiKey = require(process.env.OPENAI_API_KEY, "Missing OPENAI_API_KEY");
  const starciteKey = require(process.env.STARCITE_API_KEY, "Missing STARCITE_API_KEY");
  const baseUrl = process.env.STARCITE_BASE_URL ?? "https://api.starcite.io";

  const starcite = new Starcite({ apiKey: starciteKey, baseUrl });

  // Create session + per-identity handles
  const userSession = await starcite.session({
    identity: starcite.user({ id: args.userId ?? "demo-user" }),
    ...(args.sessionId ? { id: args.sessionId } : {}),
    title: "Live Responses API 3-agent workflow",
  });
  const id = userSession.id;

  const [coordinator, researcher, writer] = await Promise.all([
    starcite.session({ identity: starcite.agent({ id: "coordinator" }), id }),
    starcite.session({ identity: starcite.agent({ id: "researcher" }), id }),
    starcite.session({ identity: starcite.agent({ id: "writer" }), id }),
  ]);

  const sessions: WorkerSessions = {
    stream: coordinator, // any handle works — they all see the same events
    agents: { coordinator, researcher, writer },
  };

  // Print transcript
  const stopTranscript = coordinator.on("event", (event) => {
    console.log(formatEvent(event));
  }, { replay: true });

  // Boot worker
  const openai = new OpenAIRuntime({
    apiKey: openaiKey,
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    coordinatorModel: process.env.OPENAI_COORDINATOR_MODEL ?? process.env.OPENAI_MODEL,
    researcherModel: process.env.OPENAI_RESEARCHER_MODEL ?? process.env.OPENAI_MODEL,
    writerModel: process.env.OPENAI_WRITER_MODEL ?? process.env.OPENAI_MODEL,
  });
  const worker = new ResponsesWorker(openai);
  const stopWorker = worker.start(sessions);

  console.log(`session id: ${id}`);
  console.log("appending user message and waiting for approval checkpoint");

  await userSession.append({ source: "user", text: prompt, type: EV.userMessage });

  // Wait for approval request
  const approvalRequest = await waitFor(coordinator, (e) => e.type === EV.approvalRequested);
  const approvalText = args.approvalText ?? await promptForApproval(
    textOf(approvalRequest) ?? "Approve this draft?",
  );

  await userSession.append({ source: "user", text: approvalText, type: EV.approvalReceived });

  // Wait for final answer
  const finalAnswer = await waitFor(coordinator, (e) => e.type === EV.finalAnswer);
  console.log("\nfinal answer:");
  console.log(textOf(finalAnswer) ?? "");

  stopWorker();
  stopTranscript();
  userSession.disconnect();
  coordinator.disconnect();
  researcher.disconnect();
  writer.disconnect();
}

// --- Helpers ---

async function waitFor(
  session: StarciteSession,
  predicate: (e: SessionEvent) => boolean,
  timeoutMs = 180_000,
): Promise<SessionEvent> {
  for (const e of session.events()) {
    if (predicate(e)) return e;
  }

  return new Promise<SessionEvent>((resolve, reject) => {
    let stop: () => void = () => {};
    const timeout = setTimeout(() => { stop(); reject(new Error(`Timed out after ${timeoutMs}ms`)); }, timeoutMs);
    stop = session.on("event", (event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      stop();
      resolve(event);
    }, { replay: false });
  });
}

async function promptForApproval(promptText: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) return "Approved. Finalize and send the response.";
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${promptText}\napproval> `);
    return answer.trim() || "Approved. Finalize and send the response.";
  } finally {
    rl.close();
  }
}

function formatEvent(event: SessionEvent): string {
  const detail = textOf(event) ?? plStr(event, "instruction") ?? plStr(event, "responseId");
  return `${String(event.seq).padStart(2, "0")} ${event.type.padEnd(26, " ")} ${event.actor.padEnd(20, " ")} ${detail ?? ""}`;
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg?.startsWith("--") && next) {
      values[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
      i++;
    }
  }
  return values;
}

function require(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
