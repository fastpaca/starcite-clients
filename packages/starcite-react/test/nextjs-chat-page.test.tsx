import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const STREAMING_STATUS_TEXT = /status: streaming \| streaming right now: yes/i;
const AUTH_READY_TEXT = /auth: ready/i;

const mockState = vi.hoisted(() => {
  return {
    sessionFactory: vi.fn(),
    starciteOptions: [] as unknown[],
    storeOptions: [] as unknown[],
    useStarciteChat: vi.fn(),
  };
});

vi.mock("@starcite/react", () => {
  return {
    useStarciteChat: mockState.useStarciteChat,
  };
});

vi.mock("@starcite/sdk", () => {
  class FakeLocalStorageSessionStore {
    constructor(options: unknown) {
      mockState.storeOptions.push(options);
    }
  }

  class FakeStarcite {
    constructor(options: unknown) {
      mockState.starciteOptions.push(options);
    }

    session(input: unknown): unknown {
      return mockState.sessionFactory(input);
    }
  }

  return {
    LocalStorageSessionStore: FakeLocalStorageSessionStore,
    Starcite: FakeStarcite,
  };
});

vi.mock("@/components/ai-elements/conversation", () => {
  return {
    Conversation: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    ConversationContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    ConversationEmptyState: ({
      title,
      description,
    }: {
      title: string;
      description: string;
    }) => (
      <div>
        <div>{title}</div>
        <div>{description}</div>
      </div>
    ),
    ConversationScrollButton: () => null,
  };
});

vi.mock("@/components/ai-elements/message", () => {
  return {
    Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    MessageContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    MessageResponse: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock("@/components/ai-elements/prompt-input", () => {
  return {
    PromptInput: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputBody: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputFooter: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    PromptInputSubmit: () => <button type="button">Send</button>,
    PromptInputTextarea: () => <textarea aria-label="prompt" />,
  };
});

import Page from "../../../examples/nextjs-chat-ui/app/page";

describe("nextjs chat example page", () => {
  beforeEach(() => {
    mockState.sessionFactory.mockReset();
    mockState.useStarciteChat.mockReset();
    mockState.starciteOptions.length = 0;
    mockState.storeOptions.length = 0;

    window.history.replaceState({}, "", "/?sessionId=ses_refresh");

    mockState.sessionFactory.mockReturnValue({
      id: "ses_refresh",
    });
    mockState.useStarciteChat.mockReturnValue({
      messages: [
        {
          id: "assistant_1",
          role: "assistant",
          parts: [{ type: "text", text: "hello from history" }],
        },
      ],
      sendMessage: vi.fn(),
      status: "streaming",
      authState: { status: "ready" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => {
        return { token: "jwt_refresh_token", sessionId: "ses_refresh" };
      },
    }) as unknown as typeof fetch;
  });

  it("rebinds the page from ?sessionId and resumes a streaming chat state", async () => {
    render(<Page />);

    await waitFor(() => {
      expect(screen.getByText("sessionId: ses_refresh")).toBeTruthy();
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/starcite/session",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(
      JSON.parse(
        (
          (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
            .calls[0]?.[1] as RequestInit
        ).body as string
      )
    ).toEqual({
      sessionId: "ses_refresh",
    });

    expect(mockState.storeOptions).toEqual([
      {
        keyPrefix: "starcite:nextjs-chat-ui",
      },
    ]);
    expect(mockState.sessionFactory).toHaveBeenCalledWith({
      token: "jwt_refresh_token",
      refreshToken: expect.any(Function),
    });
    expect(mockState.useStarciteChat).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ses_refresh",
        session: expect.objectContaining({
          id: "ses_refresh",
        }),
      })
    );
    expect(screen.getByText(STREAMING_STATUS_TEXT)).toBeTruthy();
    expect(screen.getByText(AUTH_READY_TEXT)).toBeTruthy();
    expect(window.location.search).toContain("sessionId=ses_refresh");
  });
});
