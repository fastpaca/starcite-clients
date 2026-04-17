import { describe, expect, it, vi } from "vitest";
import { NewSessionCursorRegistry } from "../src/new-session-cursor-registry";

describe("NewSessionCursorRegistry", () => {
  it("returns cursor zero throughout the grace window", () => {
    const registry = new NewSessionCursorRegistry(30_000);

    registry.remember("ses_new");

    expect(registry.initialCursorFor("ses_new")).toBe(0);
    expect(registry.initialCursorFor("ses_new")).toBe(0);
  });

  it("prunes expired session ids when remembering newer sessions", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);

    const registry = new NewSessionCursorRegistry(30_000);
    const internal = registry as unknown as {
      expiresAtBySessionId: Map<string, number>;
    };

    registry.remember("ses_expired");
    now.mockReturnValue(40_000);
    registry.remember("ses_fresh");

    expect(internal.expiresAtBySessionId.size).toBe(1);
    expect(registry.initialCursorFor("ses_expired")).toBeUndefined();
    expect(registry.initialCursorFor("ses_fresh")).toBe(0);

    vi.restoreAllMocks();
  });
});
