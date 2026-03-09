import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * SQLite-backed cursor store. Tracks the last-processed event seq per session
 * so that replayed events are skipped on reconnect / server restart.
 */

const DATA_DIR = join(process.cwd(), ".data");
const DB_PATH = join(DATA_DIR, "cursors.sqlite");

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cursors (
      session_id TEXT NOT NULL,
      agent      TEXT NOT NULL,
      last_seq   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, agent)
    )
  `);
  return db;
}

/** Get the last-processed seq for an agent in a session. Returns 0 if none. */
export function getCursor(sessionId: string, agent: string): number {
  const row = getDb()
    .prepare("SELECT last_seq FROM cursors WHERE session_id = ? AND agent = ?")
    .get(sessionId, agent) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

/** Update the cursor — only advances forward, never backwards. */
export function setCursor(sessionId: string, agent: string, seq: number): void {
  getDb()
    .prepare(
      `INSERT INTO cursors (session_id, agent, last_seq) VALUES (?, ?, ?)
       ON CONFLICT (session_id, agent) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`
    )
    .run(sessionId, agent, seq);
}
