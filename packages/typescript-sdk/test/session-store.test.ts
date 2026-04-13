import { describe, expect, it } from "vitest";
import {
  decodeSessionStoreValue,
  encodeSessionStoreValue,
  WebStorageSessionStore,
} from "../src/session-store";

class FakeStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("WebStorageSessionStore", () => {
  it("round-trips opaque session state values through web storage", () => {
    const storage = new FakeStorage();
    const value = encodeSessionStoreValue({
      history: {
        cursor: 3,
        lastSeq: 3,
        events: [
          {
            seq: 3,
            cursor: 3,
            type: "content",
            payload: { text: "frame-3" },
            actor: "agent:drafter",
            producer_id: "producer:drafter",
            producer_seq: 3,
          },
        ],
        coverage: [{ fromSeq: 3, toSeq: 3, afterCursor: 3 }],
      },
    });

    const sessionStore = new WebStorageSessionStore(storage, {
      keyForSession: () => "stored-entry",
    });
    sessionStore.write("ses_store", value);

    expect(sessionStore.read("ses_store")).toBe(value);
    expect(
      decodeSessionStoreValue(sessionStore.read("ses_store") ?? "")
    ).toEqual({
      version: 2,
      cursor: 3,
      lastSeq: 3,
      events: [
        {
          seq: 3,
          cursor: 3,
          type: "content",
          payload: { text: "frame-3" },
          actor: "agent:drafter",
          producer_id: "producer:drafter",
          producer_seq: 3,
        },
      ],
      coverage: [{ fromSeq: 3, toSeq: 3, afterCursor: 3 }],
    });
  });
});
