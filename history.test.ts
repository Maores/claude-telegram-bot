import { test, expect } from "bun:test";
import { parseHistoryArgs, renderHit, renderContextRow } from "./history";

test("parseHistoryArgs: search with flags", () => {
  expect(parseHistoryArgs(["search", "מה החלטנו", "--chat", "5", "--days", "30", "--limit", "3"])).toEqual({
    cmd: "search",
    query: "מה החלטנו",
    chatId: 5,
    days: 30,
    limit: 3,
  });
});

test("parseHistoryArgs: defaults and context form", () => {
  expect(parseHistoryArgs(["search", "banana"])).toEqual({ cmd: "search", query: "banana" });
  expect(parseHistoryArgs(["context", "412", "--around", "2"])).toEqual({ cmd: "context", id: 412, around: 2 });
  expect(parseHistoryArgs(["context", "412"])).toEqual({ cmd: "context", id: 412 });
});

test("parseHistoryArgs: junk → null (caller prints usage)", () => {
  expect(parseHistoryArgs([])).toBeNull();
  expect(parseHistoryArgs(["search"])).toBeNull(); // query required
  expect(parseHistoryArgs(["context", "abc"])).toBeNull(); // id must be numeric
  expect(parseHistoryArgs(["nuke", "it"])).toBeNull();
});

test("renderHit: [#id local-time] role: content, truncated at 200", () => {
  const line = renderHit({ id: 7, chatId: 1, role: "user", content: "x".repeat(300), ts: 1_750_000_000, model: "sonnet", rank: -1 } as any);
  expect(line.startsWith("[#7 ")).toBe(true);
  expect(line).toContain("] user: ");
  expect(line.length).toBeLessThan(240);
  expect(line.endsWith("…")).toBe(true);
});

test("renderContextRow marks the target row", () => {
  const row = { id: 7, chatId: 1, role: "assistant", content: "hi", ts: 1_750_000_000, model: "sonnet" } as any;
  expect(renderContextRow(row, 7).startsWith("→")).toBe(true);
  expect(renderContextRow(row, 8).startsWith(" ")).toBe(true);
});
