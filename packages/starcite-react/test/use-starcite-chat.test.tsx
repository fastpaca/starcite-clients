import type {
  SessionAppendInput,
  SessionEvent,
  SessionEventContext,
  SessionEventListener,
  SessionOnEventOptions,
} from "@starcite/sdk";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatAssistantChunkEventType,
  chatUserMessageEventType,
  createAssistantChunkEnvelope,
  createUserMessageEnvelope,
} from "../src/chat-protocol";
import {
  type StarciteChatSession,
  useStarciteChat,
} from "../src/use-starcite-chat";

class FakeSession implements StarciteChatSession {
  readonly id: string;
  private readonly eventListeners = new Set<SessionEventListener>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly eventLog: SessionEvent[];
  private nextSeq: number;

  failNextAppend = false;
  appendCalls: SessionAppendInput[] = [];

  constructor(id: string, seedEvents: SessionEvent[] = []) {
    this.id = id;
    this.eventLog = [...seedEvents];
    this.nextSeq = (seedEvents.at(-1)?.seq ?? 0) + 1;
  }

  events(): readonly SessionEvent[] {
    return [...this.eventLog];
  }

  append(
    input: SessionAppendInput
  ): Promise<{ deduped: boolean; seq: number }> {
    this.appendCalls.push(input);

    if (this.failNextAppend) {
      this.failNextAppend = false;
      return Promise.reject(new Error("append failed"));
    }

    const seq = this.nextSeq;
    this.nextSeq += 1;
    return Promise.resolve({ deduped: false, seq });
  }

  on(
    eventName: "event",
    listener: SessionEventListener,
    _options?: SessionOnEventOptions<SessionEvent>
  ): () => void;
  on(eventName: "error", listener: (error: Error) => void): () => void;
  on(
    eventName: "event" | "error",
    listener: SessionEventListener | ((error: Error) => void)
  ): () => void {
    if (eventName === "event") {
      const eventListener = listener as SessionEventListener;
      this.eventListeners.add(eventListener);
      return () => {
        this.eventListeners.delete(eventListener);
      };
    }

    const errorListener = listener as (error: Error) => void;
    this.errorListeners.add(errorListener);
    return () => {
      this.errorListeners.delete(errorListener);
    };
  }

  private emitWithContext(
    type: string,
    payload: unknown,
    context: SessionEventContext
  ): void {
    const seq = this.nextSeq;
    this.nextSeq += 1;

    const event = {
      seq,
      type,
      payload,
      actor: "agent:test",
      producer_id: "producer:test",
      producer_seq: seq,
    } as SessionEvent;

    this.eventLog.push(event);
    for (const listener of this.eventListeners) {
      listener(event, context);
    }
  }

  emitEvent(type: string, payload: unknown): void {
    this.emitWithContext(type, payload, { phase: "live", replayed: false });
  }

  emitReplayEvent(type: string, payload: unknown): void {
    this.emitWithContext(type, payload, { phase: "replay", replayed: true });
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function assistantText(messages: readonly UIMessage[]): string {
  const assistant = [...messages].reverse().find((message) => {
    return message.role === "assistant";
  });

  if (!assistant) {
    return "";
  }

  for (const part of assistant.parts) {
    if (
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return part.text;
    }
  }

  return "";
}

describe("useStarciteChat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hydrates from durable events and detects active streaming", async () => {
    const seedEvents = [
      {
        seq: 1,
        type: chatUserMessageEventType,
        payload: createUserMessageEnvelope({
          id: "msg_user_1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
        actor: "user:test",
        producer_id: "producer:user",
        producer_seq: 1,
      },
      {
        seq: 2,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_1",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 2,
      },
      {
        seq: 3,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_1",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 3,
      },
      {
        seq: 4,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "hi",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 4,
      },
    ] as SessionEvent[];

    const session = new FakeSession("ses_history", seedEvents);
    const { result } = renderHook(() => useStarciteChat({ session }));

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
    });

    expect(assistantText(result.current.messages)).toBe("hi");
    expect(result.current.status).toBe("streaming");
  });

  it("tracks submitted -> streaming -> ready for a sent message", async () => {
    const session = new FakeSession("ses_stream");
    const { result } = renderHook(() => useStarciteChat({ session }));

    await act(async () => {
      await result.current.sendMessage({ text: "hello" });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("submitted");
    });

    const firstAppend = session.appendCalls[0];
    expect(firstAppend?.type).toBe(chatUserMessageEventType);

    act(() => {
      session.emitEvent(
        chatUserMessageEventType,
        createUserMessageEnvelope({
          id: "msg_user_2",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        })
      );
      session.emitEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_2",
        })
      );
      session.emitEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_2",
        })
      );
      session.emitEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_2",
          delta: "reply",
        })
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe("streaming");
    });

    await waitFor(() => {
      expect(assistantText(result.current.messages)).toBe("reply");
    });

    act(() => {
      session.emitEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      );
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
  });

  it("reports append failures as error status", async () => {
    const session = new FakeSession("ses_error");
    session.failNextAppend = true;

    const { result } = renderHook(() => useStarciteChat({ session }));

    await act(async () => {
      await expect(
        result.current.sendMessage({ text: "boom" })
      ).rejects.toThrow("append failed");
    });

    expect(result.current.status).toBe("error");
  });

  it("forwards session stream errors without forcing error status", () => {
    const session = new FakeSession("ses_runtime_error");
    const errors: Error[] = [];
    const { result } = renderHook(() =>
      useStarciteChat({
        session,
        onError: (error) => {
          errors.push(error);
        },
      })
    );

    act(() => {
      session.emitError(new Error("live stream failed"));
    });

    expect(result.current.status).toBe("ready");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("live stream failed");
  });

  it("batches replay events and resolves to final ready state", async () => {
    const session = new FakeSession("ses_replay_batch");
    const { result } = renderHook(() => useStarciteChat({ session }));

    act(() => {
      session.emitReplayEvent(
        chatUserMessageEventType,
        createUserMessageEnvelope({
          id: "msg_user_replay",
          role: "user",
          parts: [{ type: "text", text: "hello replay" }],
        })
      );
      session.emitReplayEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "start",
          messageId: "assistant_replay",
        })
      );
      session.emitReplayEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-start",
          id: "part_replay",
        })
      );
      session.emitReplayEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_replay",
          delta: "replayed response",
        })
      );
      session.emitReplayEvent(
        chatAssistantChunkEventType,
        createAssistantChunkEnvelope({
          type: "finish",
          finishReason: "stop",
        })
      );
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.status).toBe("ready");

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
    });

    expect(assistantText(result.current.messages)).toBe("replayed response");
    expect(result.current.status).toBe("ready");
  });

  it("does not enter error state when durable chunks are malformed", async () => {
    const session = new FakeSession("ses_malformed_chunks", [
      {
        seq: 1,
        type: chatUserMessageEventType,
        payload: createUserMessageEnvelope({
          id: "user_1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        }),
        actor: "user:test",
        producer_id: "producer:user",
        producer_seq: 1,
      },
      {
        seq: 2,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "start",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 2,
      },
      {
        seq: 3,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "text-delta",
          id: "part_1",
          delta: "broken ordering",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 3,
      },
      {
        seq: 4,
        type: chatAssistantChunkEventType,
        payload: createAssistantChunkEnvelope({
          type: "finish",
        }),
        actor: "agent:test",
        producer_id: "producer:agent",
        producer_seq: 4,
      },
    ] as SessionEvent[]);

    const { result } = renderHook(() => useStarciteChat({ session }));

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.role)).toEqual([
        "user",
      ]);
    });

    expect(result.current.status).toBe("ready");
  });
});
