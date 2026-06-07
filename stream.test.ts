import { test, expect } from "bun:test";
import { StreamParser, toolLabel, displayText } from "./stream.ts";

// helper: wrap an Anthropic stream event the way claude -p does
const ev = (event: any) => JSON.stringify({ type: "stream_event", event });
const textDelta = (t: string) => ev({ type: "content_block_delta", delta: { type: "text_delta", text: t } });
const thinkingDelta = () => ev({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } });
const toolStart = (name: string) =>
  ev({ type: "content_block_start", content_block: { type: "tool_use", name } });

test("accumulates text_delta into the answer and clears status", () => {
  const p = new StreamParser();
  p.push(textDelta("Hello "));
  p.push(textDelta("world"));
  expect(p.text).toBe("Hello world");
  expect(p.status).toBeNull();
});

test("starts in a thinking state and stays there while only thinking", () => {
  const p = new StreamParser();
  expect(p.status).toBe("💭 thinking…");
  p.push(thinkingDelta());
  expect(p.status).toBe("💭 thinking…");
  expect(p.text).toBe("");
});

test("tool_use start sets a friendly status", () => {
  const p = new StreamParser();
  p.push(toolStart("WebSearch"));
  expect(p.status).toBe("🔍 searching the web…");
});

test("result marks done and supplies a final-text fallback", () => {
  const p = new StreamParser();
  p.push(JSON.stringify({ type: "result", subtype: "success", result: "final answer" }));
  expect(p.done).toBe(true);
  expect(p.status).toBeNull();
  expect(p.finalText()).toBe("final answer");
});

test("finalText prefers streamed text over the result event", () => {
  const p = new StreamParser();
  p.push(textDelta("streamed answer"));
  p.push(JSON.stringify({ type: "result", result: "ignored" }));
  expect(p.finalText()).toBe("streamed answer");
});

test("ignores malformed, empty, and unknown lines", () => {
  const p = new StreamParser();
  p.push("not json");
  p.push("   ");
  p.push(JSON.stringify({ type: "system", subtype: "init" }));
  p.push(JSON.stringify({ type: "rate_limit_event" }));
  expect(p.text).toBe("");
  expect(p.done).toBe(false);
});

test("full sequence thinking -> tool -> text -> done", () => {
  const p = new StreamParser();
  p.push(thinkingDelta());
  expect(displayText(p.state())).toBe("💭 thinking…");
  p.push(toolStart("WebSearch"));
  expect(displayText(p.state())).toBe("🔍 searching the web…");
  p.push(textDelta("Here "));
  p.push(textDelta("it is."));
  expect(displayText(p.state())).toBe("Here it is.");
  p.push(JSON.stringify({ type: "result", result: "Here it is." }));
  expect(p.done).toBe(true);
  expect(p.finalText()).toBe("Here it is.");
});

test("tool_use in a complete assistant event also sets status", () => {
  const p = new StreamParser();
  p.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__claude_ai_Gmail__search" }] },
    }),
  );
  expect(p.status).toBe("📧 checking email…");
});

test("toolLabel maps known tools and falls back", () => {
  expect(toolLabel("WebSearch")).toContain("searching");
  expect(toolLabel("WebFetch")).toContain("reading");
  expect(toolLabel("mcp__x_Gmail__list")).toContain("email");
  expect(toolLabel("mcp__x_Google_Drive__list")).toContain("Drive");
  expect(toolLabel("mcp__x_Google_Calendar__events")).toContain("calendar");
  expect(toolLabel("Bash")).toBe("⚙️ working…");
  expect(toolLabel("MysteryTool")).toBe("🔧 working…");
});

test("displayText: text wins, else status, else ellipsis", () => {
  expect(displayText({ status: "💭 thinking…", text: "", done: false })).toBe("💭 thinking…");
  expect(displayText({ status: null, text: "", done: false })).toBe("…");
  expect(displayText({ status: "🔍 …", text: "answer", done: true })).toBe("answer");
});
