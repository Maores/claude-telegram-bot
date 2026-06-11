import { test, expect } from "bun:test";
import { isStopCommand, classifyUpdate } from "./dispatch";

test("classifyUpdate triages callback > stop > message > ignore", () => {
  expect(classifyUpdate({ update_id: 1, callback_query: {} }, "bot")).toBe("callback");
  expect(classifyUpdate({ update_id: 2, message: { chat: { id: 5 }, text: "/stop" } }, "bot")).toBe("stop");
  expect(classifyUpdate({ update_id: 3, message: { chat: { id: 5 }, text: "/stop@MyBot" } }, "mybot")).toBe("stop");
  expect(classifyUpdate({ update_id: 4, message: { chat: { id: 5 }, text: "hello /stop" } }, "bot")).toBe("message");
  // voice/photo messages have no text — they are messages, not stops
  expect(classifyUpdate({ update_id: 5, message: { chat: { id: 5 } } }, "bot")).toBe("message");
  // update kinds we don't handle (edited_message etc.) are ignored
  expect(classifyUpdate({ update_id: 6 }, "bot")).toBe("ignore");
});

test("isStopCommand exact-match semantics survive the move", () => {
  expect(isStopCommand("/stop", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/STOP", "")).toBe(true);
  expect(isStopCommand("/stop@maores_assistant_bot", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/stop@otherbot", "maores_assistant_bot")).toBe(false);
  expect(isStopCommand("/stopwatch", "x")).toBe(false);
  expect(isStopCommand("please /stop", "x")).toBe(false);
});
