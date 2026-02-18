import { useChat } from "@ai-sdk/react";
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";
import type { UIMessage } from "ai";
import { type FormEvent, useMemo, useState } from "react";
import { createDemoStarciteClient, type DemoPayload } from "./demo-starcite";
import "./styles.css";

const integrationSnippet = `import { useChat } from "@ai-sdk/react";
import { createStarciteClient } from "@starcite/sdk";
import { StarciteChatTransport } from "@starcite/ai-sdk-transport";

const client = createStarciteClient<Payload>({
  baseUrl: process.env.STARCITE_BASE_URL,
  apiKey: process.env.STARCITE_API_KEY,
  payloadSchema,
});

const transport = new StarciteChatTransport<Payload>({
  client,
});
const chat = useChat({
  id: "chat_1",
  transport,
});`;

function toMessageText(message: UIMessage): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }

  return message.parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

export function App() {
  const client = useMemo(() => createDemoStarciteClient(), []);
  const transport = useMemo(
    () =>
      new StarciteChatTransport<DemoPayload>({
        client,
        userAgent: "user",
      }),
    [client]
  );

  const { messages, sendMessage, status, error, stop, regenerate, clearError } =
    useChat({
      id: "starcite-demo-chat",
      transport,
    });

  const [draft, setDraft] = useState("");

  const isWorking = status === "submitted" || status === "streaming";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    if (text.length === 0) {
      return;
    }

    setDraft("");
    sendMessage({ text }).catch(() => undefined);
  }

  function onRegenerate(): void {
    regenerate().catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <section className="chat-panel">
        <header className="chat-header">
          <p className="eyebrow">Starcite x AI SDK</p>
          <h1>useChat streaming transport demo</h1>
          <p>
            This demo uses an in-memory Starcite backend, your
            <code>@starcite/ai-sdk-transport</code> adapter, and AI SDK
            <code>useChat</code> so you can inspect the integration end-to-end.
          </p>
        </header>

        <div className="status-row">
          <span data-status={status}>status: {status}</span>
          <div className="status-actions">
            <button disabled={isWorking} onClick={onRegenerate} type="button">
              regenerate
            </button>
            <button disabled={!isWorking} onClick={stop} type="button">
              stop
            </button>
            <button disabled={!error} onClick={clearError} type="button">
              clear error
            </button>
          </div>
        </div>

        {error ? <p className="error-banner">error: {error.message}</p> : null}

        <ul aria-live="polite" className="message-list">
          {messages.map((message) => {
            const text = toMessageText(message);

            return (
              <li className={`bubble bubble-${message.role}`} key={message.id}>
                <p className="role-label">{message.role}</p>
                <p>{text || "(non-text response part)"}</p>
              </li>
            );
          })}
        </ul>

        <form className="composer" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="prompt">
            Prompt
          </label>
          <textarea
            disabled={isWorking}
            id="prompt"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask the demo assistant anything..."
            rows={3}
            value={draft}
          />
          <button
            disabled={draft.trim().length === 0 || isWorking}
            type="submit"
          >
            {isWorking ? "streaming..." : "send"}
          </button>
        </form>
      </section>

      <aside className="integration-panel">
        <h2>Integration shape</h2>
        <p>
          The app wires <code>createStarciteClient</code> to
          <code>StarciteChatTransport</code>, then passes transport into
          <code>useChat</code>.
        </p>
        <pre>
          <code>{integrationSnippet}</code>
        </pre>
      </aside>
    </main>
  );
}
