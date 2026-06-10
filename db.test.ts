import { test, expect, describe } from "bun:test";
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

  // Fix 3: insert a row with a LOWER ts than "third" but a HIGHER id (backdated).
  // recentMessages must order by id (insertion order), not by ts.
  insertMessage(db, { chatId: 1, role: "user", content: "backdated", ts: base - 999 });
  const allWithBackdated = recentMessages(db, 1, 50);
  expect(allWithBackdated.map((m) => m.content)).toEqual(["first", "second", "third", "backdated"]);

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
  const idChat2 = insertMessage(db, { chatId: 2, role: "user", content: "bank in another chat", ts: base + 3 });

  // beforeId = idRecent ⇒ the recent message itself is excluded; only older hits.
  const hits = searchMessages(db, 1, "bank", 5, idRecent);
  expect(hits.map((h) => h.id)).toContain(id1);
  expect(hits.map((h) => h.id)).not.toContain(idRecent); // excluded window
  expect(hits.every((h) => h.id !== idChat2)).toBe(true); // chat 2 never appears

  // No match → [].
  expect(searchMessages(db, 1, "zzznotpresent", 5, idRecent)).toEqual([]);
  // Unsanitizable / hostile input → [] (no throw).
  expect(() => searchMessages(db, 1, "🙂", 5, idRecent)).not.toThrow();
  expect(() => searchMessages(db, 1, 'a AND ( "', 5, idRecent)).not.toThrow();
  db.close();
});

test("active = 0 rows are excluded by recentMessages and searchMessages", () => {
  const db = openDb(":memory:");
  const base = 1_700_000_000;
  const idActive = insertMessage(db, { chatId: 5, role: "user", content: "visible message", ts: base });
  // Insert an inactive row directly via raw SQL — no public deactivate() exists yet.
  db.query("INSERT INTO messages (chat_id, role, content, ts, active) VALUES (?,?,?,?,0)").run(
    5, "user", "hidden message", base + 1,
  );

  const recent = recentMessages(db, 5, 50);
  expect(recent.map((m) => m.content)).toEqual(["visible message"]);
  expect(recent.map((m) => m.id)).toContain(idActive);

  // searchMessages must also exclude the inactive row.
  // Use a large beforeId so neither row is excluded by the recent-window filter.
  const hits = searchMessages(db, 5, "hidden", 10, 999_999);
  expect(hits.map((h) => h.content)).not.toContain("hidden message");

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

  // Fix 5: the corrupt 99.json produced no rows.
  expect(recentMessages(db, 99, 50)).toEqual([]);

  // Second call is a no-op (marker set).
  expect(importHistoryJson(db, dir, 1_700_000_001)).toBe(0);
  db.close();
});

test("importHistoryJson does NOT set the done-marker when the directory read fails", () => {
  const db = openDb(":memory:");
  const missingDir = pathJoin(tmpdir(), "does-not-exist-" + Date.now());

  // Fix 1: call with a non-existent directory — must return 0 without setting the marker.
  expect(importHistoryJson(db, missingDir, 1_700_000_000)).toBe(0);

  // A subsequent call with a real directory that has a valid file must still succeed,
  // proving the marker was NOT written by the failed call.
  const dir = mkdtempSync(pathJoin(tmpdir(), "hist-retry-"));
  writeFileSync(
    pathJoin(dir, "7.json"),
    JSON.stringify([{ role: "user", content: "retry message" }]),
  );
  const n2 = importHistoryJson(db, dir, 1_700_000_001);
  expect(n2).toBe(1);
  expect(recentMessages(db, 7, 50).map((m) => m.content)).toEqual(["retry message"]);

  db.close();
});

describe("phase 3 skills schema", () => {
  test("skills and skills_fts tables exist", () => {
    const db = openDb(":memory:");
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("skills");
    expect(names).toContain("skills_fts");
    db.close();
  });

  test("initSchema is idempotent with the skills tables", () => {
    const db = openDb(":memory:");
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });

  test("skills_fts indexes name/description/tags on insert and purges on delete", () => {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO skills (name, description, tags, path, provenance, status, created_by, created_ts, updated_ts)
       VALUES ('book-flight','Use when booking a flight','travel,air','skills/book-flight.md','maor','active','maor',1,1)`,
    ).run();
    const hit = db.query("SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'flight'").get() as any;
    expect(hit).not.toBeNull();
    expect(db.query("SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'travel'").get()).not.toBeNull();
    db.query("DELETE FROM skills WHERE id = ?").run(hit.rowid);
    expect(db.query("SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'flight'").get()).toBeNull();
    db.close();
  });

  test("a status-only UPDATE leaves the FTS index intact (indexed cols never change)", () => {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO skills (name, description, tags, path, provenance, status, created_by, created_ts, updated_ts)
       VALUES ('edit-cal','Use when editing a calendar event','calendar','skills/edit-cal.md','maor','active','maor',1,1)`,
    ).run();
    db.query("UPDATE skills SET status = 'archived', use_count = use_count + 1, updated_ts = 2 WHERE name = 'edit-cal'").run();
    expect(db.query("SELECT rowid FROM skills_fts WHERE skills_fts MATCH 'calendar'").get()).not.toBeNull();
    const activeHit = db
      .query("SELECT s.id FROM skills_fts JOIN skills s ON s.id = skills_fts.rowid WHERE skills_fts MATCH 'calendar' AND s.status = 'active'")
      .get();
    expect(activeHit).toBeNull();
    db.query("UPDATE skills SET status = 'active', updated_ts = 3 WHERE name = 'edit-cal'").run();
    expect(
      db.query("SELECT s.id FROM skills_fts JOIN skills s ON s.id = skills_fts.rowid WHERE skills_fts MATCH 'calendar' AND s.status = 'active'").get(),
    ).not.toBeNull();
    db.close();
  });
});

describe("phase 2 schema", () => {
  test("memory, memory_fts and journal tables exist", () => {
    const db = openDb(":memory:");
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("memory");
    expect(names).toContain("memory_fts");
    expect(names).toContain("journal");
    db.close();
  });

  test("initSchema is idempotent with the new tables", () => {
    const db = openDb(":memory:");
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });

  test("memory_fts stays in sync via triggers", () => {
    const db = openDb(":memory:");
    db.query(
      "INSERT INTO memory (kind, content, provenance, status, created_ts, updated_ts) VALUES ('user','likes ristretto','maor','active',1,1)",
    ).run();
    const hit = db
      .query("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'ristretto'")
      .get() as any;
    expect(hit).not.toBeNull();
    db.query("UPDATE memory SET content = 'likes espresso' WHERE id = ?").run(hit.rowid);
    expect(db.query("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'ristretto'").get()).toBeNull();
    expect(db.query("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'espresso'").get()).not.toBeNull();
    db.query("DELETE FROM memory WHERE id = ?").run(hit.rowid);
    expect(db.query("SELECT rowid FROM memory_fts WHERE memory_fts MATCH 'espresso'").get()).toBeNull();
    db.close();
  });
});
