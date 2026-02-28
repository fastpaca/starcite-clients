import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli";

const LIVE_API_BASE_URL =
  process.env.STARCITE_LIVE_API_BASE_URL ?? "https://api.starcite.io";
const LIVE_API_KEY = process.env.STARCITE_LIVE_API_KEY;
const SESSION_ID_PATTERN = /^ses_/;

const describeLive = LIVE_API_KEY ? describe : describe.skip;

describeLive("starcite CLI live API integration", () => {
  it("runs create, append, tail, and sessions list against the live API", async () => {
    const token = LIVE_API_KEY;
    if (!token) {
      throw new Error("missing STARCITE_LIVE_API_KEY");
    }

    const infoMessages: string[] = [];
    const program = buildProgram({
      logger: {
        info(message: string) {
          infoMessages.push(message);
        },
        error(message: string) {
          throw new Error(message);
        },
      },
    });

    const configDir = mkdtempSync(join(tmpdir(), "starcite-cli-live-"));
    const marker = `cli-live-${Date.now()}`;

    try {
      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--base-url",
          LIVE_API_BASE_URL,
          "--token",
          token,
          "--json",
          "create",
          "--title",
          "CLI live integration",
          "--metadata",
          JSON.stringify({ integration: marker }),
        ],
        { from: "user" }
      );

      const created = JSON.parse(infoMessages.pop() ?? "{}") as {
        id?: string;
      };
      expect(created.id).toMatch(SESSION_ID_PATTERN);

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--base-url",
          LIVE_API_BASE_URL,
          "--token",
          token,
          "append",
          created.id ?? "",
          "--agent",
          "tester",
          "--text",
          "cli live append",
        ],
        { from: "user" }
      );

      const appendResult = infoMessages.pop();
      expect(appendResult).toContain("seq=");

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--base-url",
          LIVE_API_BASE_URL,
          "--token",
          token,
          "--json",
          "tail",
          created.id ?? "",
          "--cursor",
          "0",
          "--no-follow",
          "--limit",
          "1",
        ],
        { from: "user" }
      );

      const tailed = JSON.parse(infoMessages.pop() ?? "{}") as {
        actor?: string;
        seq?: number;
      };
      expect(tailed.actor).toBe("agent:tester");
      expect(tailed.seq).toBeGreaterThanOrEqual(1);

      await program.parseAsync(
        [
          "--config-dir",
          configDir,
          "--base-url",
          LIVE_API_BASE_URL,
          "--token",
          token,
          "--json",
          "sessions",
          "list",
          "--limit",
          "20",
          "--metadata",
          JSON.stringify({ integration: marker }),
        ],
        { from: "user" }
      );

      const listed = JSON.parse(infoMessages.pop() ?? "{}") as {
        sessions?: Array<{ id: string }>;
      };
      expect(
        listed.sessions?.some((session) => session.id === created.id)
      ).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 45_000);
});
