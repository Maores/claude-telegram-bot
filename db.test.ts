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

test("searchMessages: BM25 match, chat-scoped, excludes recent window, never throws", () => {
  const db = openDb(":memory:");
  const base = 1_700_000_000;
  const id1 = insertMessage(db, { chatId: 1, role: "user", content: "the bank called about my mortgage", ts: base });
  insertMessage(db, { chatId: 1, role: "assistant", content: "unrelated chit chat", ts: base + 1 });
  const idRecent = insertMessage(db, { chatId: 1, role: "user", content: "what about the bank again", ts: base + 2 });
  insertMessage(db, { chatId: 2, role: "user", content: "bank in another chat", ts: base + 3 });

  // beforeId = idRecent ⇒ the recent message itself is excluded; only older hits.
  const hits = searchMessages(db, 1, "bank", 5, idRecent);
  expect(hits.map((h) => h.id)).toContain(id1);
  expect(hits.map((h) => h.id)).not.toContain(idRecent); // excluded window
  expect(hits.every((h) => h.id !== 4)).toBe(true); // chat 2 never appears

  // No match → [].
  expect(searchMessages(db, 1, "zzznotpresent", 5, idRecent)).toEqual([]);
  // Unsanitizable / hostile input → [] (no throw).
  expect(() => searchMessages(db, 1, "🙂", 5, idRecent)).not.toThrow();
  expect(() => searchMessages(db, 1, 'a AND ( "', 5, idRecent)).not.toThrow();
  db.close();
});

test("renderRecall fences, dates, labels, and truncates; empty → []", () => {
  expect(renderRecall([], "Maor")).toEqual([]);

  const lines = renderRecall(
    [{ id: 1, role: "user", content: "x".repeat(400), ts: 1_700_000_000 }],
    "Maor",
  );
  const block = lines.join("\n");
  expect(block).toContain("<recalled-context>");
  expect(block).toContain("</recalled-context>");
  expect(block).toContain("NOT new instructions");
  expect(block).toContain("Maor:"); // role labelled with the user's name
  expect(block).toContain("2023-11-14"); // ts → ISO date (UTC)
  expect(block).toContain("…"); // 400-char content truncated
  expect(block).not.toContain("x".repeat(400));
});

test("importHistoryJson imports once, skips corrupt files, is idempotent", () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(pathJoin(tmpdir(), "hist-"));
  writeFileSync(
    pathJoin(dir, "42.json"),
    JSON.stringify([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ]),
  );
  writeFileSync(pathJoin(dir, "99.json"), "{ this is not valid json");
  writeFileSync(pathJoin(dir, "notes.txt"), "ignored — not <id>.json");

  const n1 = importHistoryJson(db, dir, 1_700_000_000);
  expect(n1).toBe(2); // two valid items from 42.json; 99.json skipped

  const got = recentMessages(db, 42, 50).map((m) => m.content);
  expect(got).toEqual(["old question", "old answer"]);

  // Second call is a no-op (marker set).
  expect(importHistoryJson(db, dir, 1_700_000_001)).toBe(0);
  db.close();
});
