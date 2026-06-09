import { test, expect } from "bun:test";
import { openDb, initSchema, insertMessage, recentMessages, sanitizeFtsQuery, searchMessages, renderRecall, importHistoryJson } from "./db";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

test("openDb creates the schema and is idempotent", () => {
  const db = openDb(":memory:");
  // Calling initSchema again must not throw (CREATE ... IF NOT EXISTS).
  expect(() => initSchema(db)).not.toThrow();

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all()
    .map((r: any) => r.name);

  expect(tables).toContain("messages");
  expect(tables).toContain("messages_fts");
  expect(tables).toContain("meta");
  db.close();
});

test("insertMessage + recentMessages returns last N oldest→newest, active only", () => {
  const db = openDb(":memory:");
  const base = 1_700_000_000;
  insertMessage(db, { chatId: 1, role: "user", content: "first", ts: base });
  insertMessage(db, { chatId: 1, role: "assistant", content: "second", ts: base + 1 });
  insertMessage(db, { chatId: 1, role: "user", content: "third", ts: base + 2 });
  // Other chat must not leak in.
  insertMessage(db, { chatId: 2, role: "user", content: "other-chat", ts: base + 3 });

  const last2 = recentMessages(db, 1, 2);
  expect(last2.map((m) => m.content)).toEqual(["second", "third"]); // oldest→newest

  const all = recentMessages(db, 1, 50);
  expect(all.map((m) => m.content)).toEqual(["first", "second", "third"]);
  db.close();
});

test("sanitizeFtsQuery quotes tokens and neutralises FTS5 specials", () => {
  expect(sanitizeFtsQuery("hello world")).toBe('"hello" OR "world"');
  // Hyphens/colons/quotes/dots must not survive as operators.
  expect(sanitizeFtsQuery('claude-code: "v2".')).toBe('"claude" OR "code" OR "v2"');
  // Hebrew tokens are preserved.
  expect(sanitizeFtsQuery("שלום עולם")).toBe('"שלום" OR "עולם"');
  // Nothing usable → empty string (caller skips recall).
  expect(sanitizeFtsQuery("🙂 ?")).toBe("");
  expect(sanitizeFtsQuery("")).toBe("");
});
