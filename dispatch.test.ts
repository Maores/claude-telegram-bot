import { test, expect } from "bun:test";
import { isStopCommand, classifyUpdate, ChatQueues, SerialChain } from "./dispatch";

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

// test helpers: a manually-opened gate + a microtask/timer flush
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, p };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("ChatQueues runs jobs of one chat strictly in order", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g1 = gate();
  q.enqueue(7, async () => { await g1.p; ran.push("a"); });
  q.enqueue(7, async () => { ran.push("b"); });
  await tick();
  expect(ran).toEqual([]); // b must wait for a
  g1.open();
  await tick(); await tick();
  expect(ran).toEqual(["a", "b"]);
});

test("ChatQueues isolates chats from each other", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(1, async () => { await g.p; ran.push("slow-chat1"); });
  q.enqueue(2, async () => { ran.push("fast-chat2"); });
  await tick();
  expect(ran).toEqual(["fast-chat2"]); // chat 2 never waited on chat 1
  g.open();
  await tick();
});

test("a throwing job does not break its chat's chain", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  q.enqueue(3, async () => { throw new Error("boom"); });
  q.enqueue(3, async () => { ran.push("after-boom"); });
  await tick(); await tick();
  expect(ran).toEqual(["after-boom"]);
});

test("drop() skips queued-but-unstarted jobs, not the running one; queue stays usable", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(9, async () => { await g.p; ran.push("running"); });
  q.enqueue(9, async () => { ran.push("queued-1"); });
  q.enqueue(9, async () => { ran.push("queued-2"); });
  await tick();
  expect(q.pending(9)).toBe(2);
  expect(q.drop(9)).toBe(2);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["running"]); // queued-1/2 were dropped
  q.enqueue(9, async () => { ran.push("post-drop"); });
  await tick(); await tick();
  expect(ran).toEqual(["running", "post-drop"]);
  await tick();
  expect(q.pending(9)).toBe(0); // counter is cleared by drop and never goes negative
});

test("a second drop() before the chain drains reports 0, not the same jobs again", async () => {
  const q = new ChatQueues();
  const g = gate();
  q.enqueue(4, async () => { await g.p; });
  q.enqueue(4, async () => {});
  q.enqueue(4, async () => {});
  await tick();
  expect(q.drop(4)).toBe(2);
  expect(q.drop(4)).toBe(0); // rapid double-/stop must not double-count
  g.open();
  await tick(); await tick();
  expect(q.pending(4)).toBe(0);
});

test("SerialChain runs jobs one at a time, surviving errors", async () => {
  const c = new SerialChain();
  const ran: string[] = [];
  const g = gate();
  c.enqueue(async () => { await g.p; ran.push("first"); });
  c.enqueue(async () => { throw new Error("mid"); });
  c.enqueue(async () => { ran.push("third"); });
  await tick();
  expect(ran).toEqual([]);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["first", "third"]);
});

test("ChatQueues.idle resolves only after all queued jobs finish", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(1, async () => { await g.p; ran.push("a"); });
  q.enqueue(2, async () => { ran.push("b"); });
  let idle = false;
  void q.idle().then(() => { idle = true; });
  await tick();
  expect(idle).toBe(false); // chat 1 still gated
  g.open();
  await tick(); await tick();
  expect(idle).toBe(true);
  expect(ran.sort()).toEqual(["a", "b"]);
});

test("SerialChain.idle resolves after the tail job", async () => {
  const c = new SerialChain();
  const g = gate();
  let idle = false;
  c.enqueue(async () => { await g.p; });
  void c.idle().then(() => { idle = true; });
  await tick();
  expect(idle).toBe(false);
  g.open();
  await tick(); await tick();
  expect(idle).toBe(true);
});
