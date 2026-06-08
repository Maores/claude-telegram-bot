import { test, expect } from "bun:test";
import { parseEvents, fmtEvent, nudgeKey, selectUpcoming, pruneNotified } from "./calendar.ts";

const TIMED = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1@test
SUMMARY:Dentist
DTSTART:20260609T090000Z
DTEND:20260609T100000Z
END:VEVENT
END:VCALENDAR`;

const ALLDAY = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-2@test
SUMMARY:Holiday
DTSTART;VALUE=DATE:20260610
DTEND;VALUE=DATE:20260611
END:VEVENT
END:VCALENDAR`;

const TWO = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a@test
SUMMARY:First
DTSTART:20260609T090000Z
DTEND:20260609T093000Z
END:VEVENT
BEGIN:VEVENT
UID:b@test
SUMMARY:Second
DTSTART:20260609T110000Z
DTEND:20260609T113000Z
END:VEVENT
END:VCALENDAR`;

test("parses a timed event", () => {
  const [e] = parseEvents(TIMED);
  expect(e.title).toBe("Dentist");
  expect(e.uid).toBe("evt-1@test");
  expect(e.allDay).toBe(false);
  expect(e.start instanceof Date).toBe(true);
  expect(e.end.getTime()).toBeGreaterThan(e.start.getTime());
});

test("detects an all-day event", () => {
  const [e] = parseEvents(ALLDAY);
  expect(e.title).toBe("Holiday");
  expect(e.allDay).toBe(true);
});

test("parses multiple events from one calendar", () => {
  const evs = parseEvents(TWO);
  expect(evs.length).toBe(2);
  expect(evs.map((e) => e.title)).toEqual(["First", "Second"]);
});

test("returns [] for empty or garbage input", () => {
  expect(parseEvents("")).toEqual([]);
  expect(parseEvents("not an ical")).toEqual([]);
});

test("fmtEvent includes the title and a time", () => {
  const [e] = parseEvents(TIMED);
  const s = fmtEvent(e);
  expect(s).toContain("Dentist");
  expect(s).toMatch(/\d\d:\d\d|all day/);
});

test("nudgeKey is unique per occurrence", () => {
  expect(nudgeKey({ uid: "x", start: new Date(1_000_000) } as any)).toBe("x@1000000");
});

test("selectUpcoming picks timed events in the window, excludes all-day and past", () => {
  const now = 1_000_000_000_000;
  const mk = (uid: string, offMin: number, allDay = false) =>
    ({
      uid,
      title: uid,
      start: new Date(now + offMin * 60000),
      end: new Date(now + offMin * 60000 + 1_800_000),
      allDay,
      calendar: "c",
    }) as any;
  const events = [mk("past", -5), mk("soon", 10), mk("edge", 15), mk("far", 30), mk("allday", 5, true)];
  expect(selectUpcoming(events, now, 15).map((e) => e.uid).sort()).toEqual(["edge", "soon"]);
});

test("pruneNotified drops entries over an hour past", () => {
  const now = 10_000_000_000;
  const pruned = pruneNotified(
    { recent: now - 1000, oldish: now - 30 * 60000, ancient: now - 2 * 3_600_000 },
    now,
  );
  expect(pruned.recent).toBeDefined();
  expect(pruned.oldish).toBeDefined();
  expect(pruned.ancient).toBeUndefined();
});
