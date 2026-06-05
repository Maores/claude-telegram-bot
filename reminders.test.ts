import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

// Use a throwaway store file so tests never touch the real reminders.json.
const TMP = join(import.meta.dir, "reminders.test.tmp.json");
process.env.REMINDERS_FILE = TMP;

import { nextFire, addOnce, addRepeat, listFor, cancel, popDue, loadStore } from "./reminders.ts";

const DAILY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const epochOf = (y: number, m0: number, d: number, h: number, min: number) =>
  Math.floor(new Date(y, m0, d, h, min, 0, 0).getTime() / 1000);

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
});
afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
});

// --- nextFire -----------------------------------------------------------

test("nextFire daily: before today's time → today", () => {
  const now = epochOf(2026, 5, 5, 7, 0); // Jun 5 2026, 07:00 local
  const f = nextFire(now, 8, 0, DAILY);
  const d = new Date(f * 1000);
  expect(f).toBeGreaterThan(now);
  expect(d.getHours()).toBe(8);
  expect(d.getMinutes()).toBe(0);
  expect(d.getDate()).toBe(5);
});

test("nextFire daily: after today's time → tomorrow", () => {
  const now = epochOf(2026, 5, 5, 9, 0);
  const f = nextFire(now, 8, 0, DAILY);
  const d = new Date(f * 1000);
  expect(d.getDate()).toBe(6);
  expect(d.getHours()).toBe(8);
});

test("nextFire weekdays: result is always a weekday, after now", () => {
  // try a week of starting points
  for (let day = 1; day <= 7; day++) {
    const now = epochOf(2026, 5, day, 23, 0);
    const f = nextFire(now, 8, 0, WEEKDAYS);
    const d = new Date(f * 1000);
    expect(f).toBeGreaterThan(now);
    expect(WEEKDAYS).toContain(d.getDay());
    expect(d.getHours()).toBe(8);
  }
});

test("nextFire weekly (single day) lands on that weekday", () => {
  const now = epochOf(2026, 5, 5, 12, 0);
  const f = nextFire(now, 10, 30, [1]); // Mondays 10:30
  const d = new Date(f * 1000);
  expect(d.getDay()).toBe(1);
  expect(d.getHours()).toBe(10);
  expect(d.getMinutes()).toBe(30);
  expect(f).toBeGreaterThan(now);
});

// --- add / list / cancel ------------------------------------------------

test("addOnce then list then cancel roundtrip", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = addOnce(42, future, "call the bank");
  expect(r.id).toBe("r1");
  let items = listFor(42);
  expect(items.length).toBe(1);
  expect(items[0].text).toBe("call the bank");
  expect(cancel(42, "r1")).toBe(true);
  expect(listFor(42).length).toBe(0);
  expect(cancel(42, "r1")).toBe(false); // already gone
});

test("list is scoped per chat", () => {
  const t = Math.floor(Date.now() / 1000) + 3600;
  addOnce(1, t, "a");
  addOnce(2, t, "b");
  expect(listFor(1).length).toBe(1);
  expect(listFor(2).length).toBe(1);
  expect(listFor(1)[0].text).toBe("a");
});

// --- popDue -------------------------------------------------------------

test("popDue fires and removes a one-time reminder", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  addOnce(7, past, "ping");
  const due = popDue();
  expect(due.length).toBe(1);
  expect(due[0].text).toBe("ping");
  expect(loadStore().length).toBe(0); // removed
});

test("popDue fires and reschedules a recurring reminder", () => {
  const now = epochOf(2026, 5, 5, 9, 0);
  // first fire computed for 08:00 daily relative to a now BEFORE that, so it's pending...
  addRepeat(7, 8, 0, DAILY, "standup", epochOf(2026, 5, 5, 7, 0));
  // now it's 09:00 (past 08:00) → should be due, fire once, reschedule to tomorrow 08:00
  const due = popDue(now);
  expect(due.length).toBe(1);
  const after = loadStore();
  expect(after.length).toBe(1); // still there
  const next = new Date(after[0].fireAt * 1000);
  expect(after[0].fireAt).toBeGreaterThan(now);
  expect(next.getHours()).toBe(8);
});

test("popDue leaves future reminders untouched", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  addOnce(7, future, "later");
  expect(popDue().length).toBe(0);
  expect(loadStore().length).toBe(1);
});
