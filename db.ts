/**
 * db.ts — SQLite-backed message store + FTS5 recall for the Telegram bot.
 *
 * Phase 1 of the self-improving memory design
 * (docs/superpowers/specs/2026-06-09-self-improving-memory-design.md).
 * One DB at memory/bot.db (bun:sqlite, FTS5 built in). `messages` is the source
 * of truth for conversation history; a trigger-synced `messages_fts` virtual
 * table powers keyword recall (BM25). No embeddings.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

export interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface RecallHit {
  id: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

const DEFAULT_DB_PATH = join(import.meta.dir, "memory", "bot.db");

/** Create tables, FTS index, and sync triggers. Idempotent. */
export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id  INTEGER NOT NULL,
      role     TEXT    NOT NULL,
      content  TEXT    NOT NULL,
      ts       INTEGER NOT NULL,
      model    TEXT,
      active   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, tokenize = 'unicode61');

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      UPDATE messages_fts SET content = new.content WHERE rowid = old.id;
    END;

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

/** Open (and migrate) the DB at `path`. Tests pass ":memory:". */
export function openDb(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  initSchema(db);
  return db;
}

let _db: Database | null = null;
/** Lazy process-wide singleton for the poller. */
export function getDb(): Database {
  if (!_db) _db = openDb();
  return _db;
}

/** Append a message; returns its row id. */
export function insertMessage(
  db: Database,
  m: { chatId: number; role: "user" | "assistant"; content: string; ts: number; model?: string | null },
): number {
  const info = db
    .query("INSERT INTO messages (chat_id, role, content, ts, model) VALUES (?, ?, ?, ?, ?)")
    .run(m.chatId, m.role, m.content, m.ts, m.model ?? null);
  return Number(info.lastInsertRowid);
}

/** Last `n` messages for a chat, oldest→newest. */
export function recentMessages(db: Database, chatId: number, n: number): MessageRow[] {
  const rows = db
    .query("SELECT id, role, content, ts FROM messages WHERE chat_id = ? AND active = 1 ORDER BY id DESC LIMIT ?")
    .all(chatId, n) as MessageRow[];
  return rows.reverse();
}
