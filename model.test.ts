import { test, expect } from "bun:test";
import { pickModel } from "./model.ts";

test("defaults to sonnet for ordinary messages", () => {
  expect(pickModel("what's 2+2?").model).toBe("sonnet");
  expect(pickModel("remind me at 6pm to call the bank").model).toBe("sonnet");
  expect(pickModel("summarize my latest email").model).toBe("sonnet");
});

test("/opus prefix escalates to opus and is stripped", () => {
  const r = pickModel("/opus solve this hard puzzle");
  expect(r.model).toBe("opus");
  expect(r.prompt).toBe("solve this hard puzzle");
});

test("/opus prefix is case-insensitive", () => {
  expect(pickModel("/OPUS hi").model).toBe("opus");
  expect(pickModel("/Opus hi").prompt).toBe("hi");
});

test("/sonnet prefix forces sonnet and is stripped", () => {
  const r = pickModel("/sonnet just a quick one");
  expect(r.model).toBe("sonnet");
  expect(r.prompt).toBe("just a quick one");
});

test("keywords escalate to opus without stripping the text", () => {
  expect(pickModel("think hard about this problem").model).toBe("opus");
  expect(pickModel("can you use opus for this?").model).toBe("opus");
  expect(pickModel("Think hard about X").prompt).toBe("Think hard about X");
});

test("code blocks escalate to opus", () => {
  expect(pickModel("fix this:\n```js\nconsole.log(1)\n```").model).toBe("opus");
});

test("a long but ordinary message stays on sonnet", () => {
  expect(pickModel("please summarize the following: " + "blah ".repeat(400)).model).toBe("sonnet");
});

test("surrounding whitespace is handled", () => {
  expect(pickModel("   /opus   hello world  ").prompt).toBe("hello world");
});
