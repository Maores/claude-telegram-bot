import { test, expect } from "bun:test";
import {
  parseEvents,
  fmtEvent,
  nudgeKey,
  selectUpcoming,
  pruneNotified,
  buildVEvent,
  toUtcZ,
  isRecurring,
  mergeEvent,
} from "./calendar.ts";

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

// --- buildVEvent (phase 3: write) ---

const STAMP = new Date("2026-06-08T12:00:00Z");

test("buildVEvent round-trips a timed event through parseEvents", () => {
  const start = new Date("2026-06-10T15:00:00Z");
  const end = new Date("2026-06-10T16:00:00Z");
  const ics = buildVEvent({ uid: "u1@bot", title: "Dentist", start, end, dtstamp: STAMP });
  const [e] = parseEvents(ics);
  expect(e.title).toBe("Dentist");
  expect(e.uid).toBe("u1@bot");
  expect(e.allDay).toBe(false);
  expect(e.start.getTime()).toBe(start.getTime());
  expect(e.end.getTime()).toBe(end.getTime());
});

test("buildVEvent emits a UTC DTSTART/DTEND for timed events", () => {
  const ics = buildVEvent({
    uid: "u2@bot",
    title: "Call",
    start: new Date("2026-06-10T15:00:00Z"),
    end: new Date("2026-06-10T15:30:00Z"),
    dtstamp: STAMP,
  });
  expect(ics).toMatch(/DTSTART:20260610T150000Z/);
  expect(ics).toMatch(/DTEND:20260610T153000Z/);
});

test("buildVEvent round-trips an all-day event using VALUE=DATE", () => {
  const ics = buildVEvent({
    uid: "u3@bot",
    title: "Holiday",
    start: new Date("2026-06-10T00:00:00Z"),
    end: new Date("2026-06-11T00:00:00Z"),
    allDay: true,
    dtstamp: STAMP,
  });
  expect(ics).toMatch(/DTSTART;VALUE=DATE:20260610/);
  const [e] = parseEvents(ics);
  expect(e.title).toBe("Holiday");
  expect(e.allDay).toBe(true);
});

test("buildVEvent escapes commas and semicolons in the title", () => {
  const title = "Lunch; with A, B";
  const ics = buildVEvent({
    uid: "u4@bot",
    title,
    start: new Date("2026-06-10T15:00:00Z"),
    end: new Date("2026-06-10T16:00:00Z"),
    dtstamp: STAMP,
  });
  expect(ics).toContain("SUMMARY:Lunch\\; with A\\, B");
  const [e] = parseEvents(ics);
  expect(e.title).toBe(title);
});

test("buildVEvent includes location/description when given and omits them otherwise", () => {
  const base = {
    uid: "u5@bot",
    title: "Meeting",
    start: new Date("2026-06-10T15:00:00Z"),
    end: new Date("2026-06-10T16:00:00Z"),
    dtstamp: STAMP,
  };
  const withExtras = buildVEvent({ ...base, location: "Room 3", description: "bring laptop" });
  expect(withExtras).toContain("LOCATION:Room 3");
  expect(withExtras).toContain("DESCRIPTION:bring laptop");
  const bare = buildVEvent(base);
  expect(bare).not.toContain("LOCATION:");
  expect(bare).not.toContain("DESCRIPTION:");
});

test("toUtcZ converts a local-offset instant to the right UTC instant", () => {
  expect(toUtcZ("2026-06-09T15:00:00+03:00")).toBe("2026-06-09T12:00:00.000Z");
});

test("toUtcZ passes a UTC instant through unchanged", () => {
  expect(toUtcZ("2026-06-09T12:00:00Z")).toBe("2026-06-09T12:00:00.000Z");
});

test("toUtcZ throws on an unparseable date", () => {
  expect(() => toUtcZ("not a date")).toThrow();
});

// --- edit/delete helpers (phase 3) ---

const WITH_EXTRAS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:x@test
SUMMARY:Meeting
LOCATION:Room 5
DESCRIPTION:bring laptop
DTSTART:20260610T090000Z
DTEND:20260610T093000Z
END:VEVENT
END:VCALENDAR`;

test("parseEvents captures location and description when present", () => {
  const [e] = parseEvents(WITH_EXTRAS);
  expect(e.location).toBe("Room 5");
  expect(e.description).toBe("bring laptop");
});

test("parseEvents leaves location/description undefined when absent", () => {
  const [e] = parseEvents(TIMED);
  expect(e.location).toBeUndefined();
  expect(e.description).toBeUndefined();
});

test("isRecurring detects an RRULE and ignores non-recurring events", () => {
  expect(isRecurring("BEGIN:VEVENT\nRRULE:FREQ=WEEKLY;COUNT=5\nEND:VEVENT")).toBe(true);
  expect(isRecurring(TIMED)).toBe(false);
});

test("mergeEvent overrides only patched fields and preserves uid + unset fields", () => {
  const base = {
    uid: "m@test",
    title: "Old",
    start: new Date("2026-06-10T15:00:00Z"),
    end: new Date("2026-06-10T16:00:00Z"),
    allDay: false,
    location: "A",
    description: "d",
  };
  const merged = mergeEvent(base, { title: "New", start: new Date("2026-06-10T17:00:00Z") }, STAMP);
  expect(merged.uid).toBe("m@test");
  expect(merged.title).toBe("New");
  expect(merged.start.toISOString()).toBe("2026-06-10T17:00:00.000Z");
  expect(merged.end.toISOString()).toBe("2026-06-10T16:00:00.000Z");
  expect(merged.location).toBe("A");
  expect(merged.description).toBe("d");
  expect(merged.dtstamp).toBe(STAMP);
});
