import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID_TEXT = /ses_swarm/i;

const mockState = vi.hoisted(() => {
  return {
    sessionFactory: vi.fn(),
    starciteOptions: [] as unknown[],
    storeOptions: [] as unknown[],
    useStarciteSession: vi.fn(),
  };
});

vi.mock("@starcite/react", () => {
  return {
    useStarciteSession: mockState.useStarciteSession,
  };
});

vi.mock("@starcite/sdk", () => {
  class FakeLocalStorageSessionCache {
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
    LocalStorageSessionCache: FakeLocalStorageSessionCache,
    Starcite: FakeStarcite,
  };
});

vi.mock("streamdown", () => {
  return {
    Streamdown: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock("use-stick-to-bottom", () => {
  const Root = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Root.Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    StickToBottom: Root,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

import Page from "../../../examples/multi-agent-viewer/app/page";

describe("multi-agent viewer example page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockState.sessionFactory.mockReset();
    mockState.useStarciteSession.mockReset();
    mockState.starciteOptions.length = 0;
    mockState.storeOptions.length = 0;

    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        disconnect(): void {
          /* noop for jsdom */
        }
        observe(): void {
          /* noop for jsdom */
        }
        unobserve(): void {
          /* noop for jsdom */
        }
      }
    );

    window.history.replaceState({}, "", "/?sessionId=ses_swarm");

    mockState.sessionFactory.mockReturnValue({
      id: "ses_swarm",
    });
    mockState.useStarciteSession.mockReturnValue({
      events: [
        {
          seq: 1,
          type: "message.user",
          payload: { text: "Compare the top three options." },
        },
        {
          seq: 2,
          type: "agent.streaming.chunk",
          payload: {
            agent: "coordinator",
            name: "Coordinator",
            delta: "Drafting a plan.",
          },
        },
        {
          seq: 3,
          type: "agent.done",
          payload: {
            agent: "coordinator",
            name: "Coordinator",
          },
        },
      ],
      append: vi.fn(),
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => {
        return { token: "jwt_viewer_token", sessionId: "ses_swarm" };
      },
    }) as unknown as typeof fetch;
  });

  it("rebinds an existing session id and renders the reconstructed feed", async () => {
    render(<Page />);

    await waitFor(() => {
      expect(screen.getByText(SESSION_ID_TEXT)).toBeTruthy();
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
      sessionId: "ses_swarm",
    });

    expect(mockState.storeOptions).toEqual([
      {
        keyPrefix: "starcite:multi-agent-viewer",
      },
    ]);
    expect(mockState.sessionFactory).toHaveBeenCalledWith({
      token: "jwt_viewer_token",
      refreshToken: expect.any(Function),
    });
    expect(mockState.useStarciteSession).toHaveBeenCalledWith(
      expect.objectContaining({
        read: "all",
        session: expect.objectContaining({
          id: "ses_swarm",
        }),
      })
    );
    expect(screen.getByText("Compare the top three options.")).toBeTruthy();
    expect(screen.getByText("Drafting a plan.")).toBeTruthy();
    expect(window.location.search).toContain("sessionId=ses_swarm");
  });
});
