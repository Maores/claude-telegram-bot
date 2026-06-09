import { test, expect } from "bun:test";
import { openDb, initSchema } from "./db";

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
