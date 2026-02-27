import { describe, expect, it } from "vitest";
import {
  createInMemoryCursorStore,
  createLocalStorageCursorStore,
  createWebStorageCursorStore,
} from "../src/cursor-store";
import { StarciteError } from "../src/errors";

describe("cursor store helpers", () => {
  it("persists and loads cursors in memory", async () => {
    const store = createInMemoryCursorStore({ ses_a: 3 });

    expect(await store.load("ses_a")).toBe(3);
    expect(await store.load("ses_b")).toBeUndefined();

    await store.save("ses_b", 8);
    expect(await store.load("ses_b")).toBe(8);
  });

  it("uses web storage with default key format", async () => {
    const map = new Map<string, string>();
    const store = createWebStorageCursorStore({
      getItem(key: string): string | null {
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        map.set(key, value);
      },
    });

    await store.save("ses_a", 12);
    expect(map.get("starcite:ses_a:lastSeq")).toBe("12");
    expect(await store.load("ses_a")).toBe(12);
  });

  it("supports custom key resolvers", async () => {
    const map = new Map<string, string>();
    const store = createWebStorageCursorStore(
      {
        getItem(key: string): string | null {
          return map.get(key) ?? null;
        },
        setItem(key: string, value: string): void {
          map.set(key, value);
        },
      },
      {
        keyForSession: (sessionId) => `cursor/${sessionId}`,
      }
    );

    await store.save("ses_custom", 5);
    expect(map.get("cursor/ses_custom")).toBe("5");
    expect(await store.load("ses_custom")).toBe(5);
  });

  it("returns parsed persisted cursor values without additional validation", async () => {
    const map = new Map<string, string>([["starcite:ses_bad:lastSeq", "oops"]]);
    const store = createWebStorageCursorStore({
      getItem(key: string): string | null {
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        map.set(key, value);
      },
    });

    expect(await store.load("ses_bad")).toSatisfy(Number.isNaN);
  });

  it("throws when localStorage is unavailable", () => {
    const original = globalThis.localStorage;

    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: undefined,
        configurable: true,
      });

      expect(() => createLocalStorageCursorStore()).toThrow(StarciteError);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        configurable: true,
      });
    }
  });
});
