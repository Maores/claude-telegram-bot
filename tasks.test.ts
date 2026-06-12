import { test, expect } from "bun:test";
import { parseTodos, fmtTask, selectTasks, sortTasks, type TaskItem } from "./tasks";

const wrap = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iOS 17.0//EN", body, "END:VCALENDAR"].join("\r\n") + "\r\n";

const OPEN_TODO = wrap(
  ["BEGIN:VTODO", "UID:open-1", "DTSTAMP:20260612T080000Z", "SUMMARY:לקנות חלב", "STATUS:NEEDS-ACTION", "END:VTODO"].join("\r\n"),
);

const DONE_TODO = wrap(
  [
    "BEGIN:VTODO", "UID:done-1", "DTSTAMP:20260612T080000Z", "SUMMARY:Call plumber",
    "STATUS:COMPLETED", "COMPLETED:20260611T130000Z", "PERCENT-COMPLETE:100", "END:VTODO",
  ].join("\r\n"),
);

const TIMED_DUE = wrap(
  ["BEGIN:VTODO", "UID:due-1", "DTSTAMP:20260612T080000Z", "SUMMARY:Pay rent", "DUE:20260615T090000Z", "STATUS:NEEDS-ACTION", "END:VTODO"].join("\r\n"),
);

const DATEONLY_DUE = wrap(
  ["BEGIN:VTODO", "UID:due-2", "DTSTAMP:20260612T080000Z", "SUMMARY:Renew passport", "DUE;VALUE=DATE:20260620", "STATUS:NEEDS-ACTION", "END:VTODO"].join("\r\n"),
);

const RECURRING = wrap(
  ["BEGIN:VTODO", "UID:rec-1", "DTSTAMP:20260612T080000Z", "SUMMARY:Water plants", "RRULE:FREQ=WEEKLY", "STATUS:NEEDS-ACTION", "END:VTODO"].join("\r\n"),
);

const ESCAPED = wrap(
  [
    "BEGIN:VTODO", "UID:esc-1", "DTSTAMP:20260612T080000Z",
    "SUMMARY:Call mom\\, then dad\\; later",
    "DESCRIPTION:line one\\nline two",
    "STATUS:NEEDS-ACTION", "END:VTODO",
  ].join("\r\n"),
);

test("parseTodos: open todo basics + list tag", () => {
  const t = parseTodos(OPEN_TODO, "תזכורות");
  expect(t.length).toBe(1);
  expect(t[0].uid).toBe("open-1");
  expect(t[0].title).toBe("לקנות חלב");
  expect(t[0].done).toBe(false);
  expect(t[0].due).toBeUndefined();
  expect(t[0].recurring).toBe(false);
  expect(t[0].list).toBe("תזכורות");
});

test("parseTodos: completed todo carries done + completedAt", () => {
  const t = parseTodos(DONE_TODO)[0];
  expect(t.done).toBe(true);
  expect(t.completedAt?.toISOString()).toBe("2026-06-11T13:00:00.000Z");
});

test("parseTodos: timed due is an instant, not date-only", () => {
  const t = parseTodos(TIMED_DUE)[0];
  expect(t.due?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  expect(t.dueDateOnly ?? false).toBe(false);
});

test("parseTodos: VALUE=DATE due is date-only, normalized to UTC midnight", () => {
  const t = parseTodos(DATEONLY_DUE)[0];
  // node-ical hands back LOCAL midnight; parseTodos must normalize to UTC
  // midnight so buildVTodo's UTC-getter fmtDate can never shift the day.
  expect(t.due?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  expect(t.dueDateOnly).toBe(true);
});

test("parseTodos: RRULE marks recurring", () => {
  expect(parseTodos(RECURRING)[0].recurring).toBe(true);
});

test("parseTodos: unescapes RFC-5545 text", () => {
  const t = parseTodos(ESCAPED)[0];
  expect(t.title).toBe("Call mom, then dad; later");
  expect(t.notes).toBe("line one\nline two");
});

test("parseTodos: ignores VEVENTs and survives garbage", () => {
  const eventOnly = wrap(
    ["BEGIN:VEVENT", "UID:ev-1", "DTSTAMP:20260612T080000Z", "DTSTART:20260615T090000Z", "SUMMARY:Meeting", "END:VEVENT"].join("\r\n"),
  );
  expect(parseTodos(eventOnly)).toEqual([]);
  expect(parseTodos("not ical at all")).toEqual([]);
});

const mk = (over: Partial<TaskItem>): TaskItem => ({
  uid: "u", title: "t", done: false, recurring: false, ...over,
});

test("sortTasks: open first, then due ascending, no-due last", () => {
  const a = mk({ uid: "a", due: new Date("2026-06-20T09:00:00Z") });
  const b = mk({ uid: "b", due: new Date("2026-06-15T09:00:00Z") });
  const c = mk({ uid: "c" }); // no due
  const d = mk({ uid: "d", done: true, due: new Date("2026-06-01T09:00:00Z") });
  expect(sortTasks([a, c, d, b]).map((t) => t.uid)).toEqual(["b", "a", "c", "d"]);
});

test("selectTasks: open / done / all modes", () => {
  const open = mk({ uid: "o" });
  const done = mk({ uid: "d", done: true });
  expect(selectTasks([open, done], "open").map((t) => t.uid)).toEqual(["o"]);
  expect(selectTasks([open, done], "done").map((t) => t.uid)).toEqual(["d"]);
  expect(selectTasks([open, done], "all").length).toBe(2);
});

test("fmtTask: open with timed due, done, recurring, list tag", () => {
  const due = new Date(2026, 5, 15, 9, 0); // local Mon 15/06 09:00
  expect(fmtTask(mk({ title: "Pay rent", due }))).toBe("☐ Pay rent — Mon 15/06 09:00");
  // date-only dues are UTC midnight (parseTodos normalizes them); local
  // getters still show the right day for Jerusalem's positive offset
  const dueOnly = new Date(Date.UTC(2026, 5, 20));
  expect(fmtTask(mk({ title: "Renew passport", due: dueOnly, dueDateOnly: true }))).toBe("☐ Renew passport — Sat 20/06");
  expect(fmtTask(mk({ title: "Water plants", recurring: true }))).toBe("☐ Water plants 🔁");
  expect(fmtTask(mk({ title: "Call plumber", done: true, list: "תזכורות" }))).toBe("☑ Call plumber (תזכורות)");
});
