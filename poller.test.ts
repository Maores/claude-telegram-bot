import { test, expect } from "bun:test";
import { chunkText, buildPrompt } from "./poller.ts";

test("short text stays one chunk", () => {
  expect(chunkText("hello")).toEqual(["hello"]);
});

test("empty string yields a single empty chunk", () => {
  expect(chunkText("")).toEqual([""]);
});

test("no chunk exceeds the limit and content is preserved without newlines", () => {
  const big = "x".repeat(10_000);
  const chunks = chunkText(big, 4096);
  expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  expect(chunks.join("")).toBe(big);
});

test("splits on a newline when there is one in range", () => {
  const text = "a".repeat(4000) + "\n" + "b".repeat(200);
  const chunks = chunkText(text, 4096);
  expect(chunks[0]).toBe("a".repeat(4000));
  expect(chunks[1]).toBe("b".repeat(200));
});

test("hard-cuts when there is no newline break point", () => {
  const chunks = chunkText("a".repeat(5000), 4096);
  expect(chunks[0].length).toBe(4096);
  expect(chunks[1].length).toBe(904);
});

test("buildPrompt includes memory-free history and the new message", () => {
  const p = buildPrompt(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ],
    "Sam",
    "how are you?",
  );
  expect(p).toContain("Recent conversation (for context):");
  expect(p).toContain("Sam: hi");
  expect(p).toContain("Assistant: yo");
  expect(p).toContain("New message from Sam:");
  expect(p).toContain("how are you?");
});

test("buildPrompt with no history still asks the new message", () => {
  const p = buildPrompt([], "Sam", "ping");
  expect(p).not.toContain("Recent conversation");
  expect(p).toContain("New message from Sam:");
  expect(p).toContain("ping");
});
