import { openai } from "@ai-sdk/openai";
import {
  appendAssistantChunkEvent,
  chatUserMessageEventType,
  toUIMessagesFromEvents,
} from "@starcite/react/chat-protocol";
import { convertToModelMessages, streamText } from "ai";
import { starcite } from "./starcite";

/** Set `NEXTJS_CHAT_DEBUG=1` when running `next dev` to trace lifecycle + handler path. */
const debug = process.env.NEXTJS_CHAT_DEBUG === "1";

function dbg(...args: unknown[]): void {
  if (debug) {
    console.log("[nextjs-chat-debug]", new Date().toISOString(), ...args);
  }
}

dbg("lib/agent loaded (shared starcite)", {
  pid: process.pid,
  baseUrl: process.env.STARCITE_BASE_URL || "https://api.starcite.io (default)",
});

const agentIdentity = starcite.agent({
  id: process.env.STARCITE_AGENT_ID || "nextjs-demo-agent",
});

starcite.on("error", (err) => {
  dbg("starcite lifecycle/socket error", err);
});

starcite.on("session.created", (event) => {
  dbg("session.created received", {
    session_id: event.session_id,
    pid: process.pid,
  });

  void (async () => {
    try {
      const session = await starcite.session({
        identity: agentIdentity,
        id: event.session_id,
        title: "Next.js demo chat",
      });

      dbg("coordinator session handle ready", {
        sessionId: session.id,
        hasToken: Boolean(session.token),
      });

      session.on("event", async (sessionEvent, context) => {
        if (context.replayed) {
          dbg("tail event skipped (replayed)", {
            type: sessionEvent.type,
            seq: sessionEvent.seq,
          });
          return;
        }

        if (sessionEvent.type !== chatUserMessageEventType) {
          return;
        }

        dbg("user message event for model", {
          seq: sessionEvent.seq,
          type: sessionEvent.type,
        });

        const messages = await toUIMessagesFromEvents(session.events());
        if (messages.length === 0) {
          dbg("no UIMessages from session.events(); skipping streamText");
          return;
        }

        dbg("streamText start", { messageCount: messages.length });

        try {
          const result = streamText({
            model: openai(process.env.OPENAI_MODEL || "gpt-4o-mini"),
            system: "You are a concise assistant in a Starcite demo chat.",
            messages: convertToModelMessages(messages),
          });

          let chunks = 0;
          for await (const chunk of result.toUIMessageStream()) {
            chunks++;
            await appendAssistantChunkEvent(session, chunk, {
              source: "openai",
            });
          }
          dbg("streamText finished", { chunks });
        } catch (err) {
          dbg("streamText / append failed", err);
          throw err;
        }
      });
    } catch (err) {
      dbg("session.created handler failed (bind or setup)", err);
    }
  })();
});
