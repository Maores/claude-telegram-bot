/**
 * calendar.ts — read (and later write) the user's iCloud calendar over CalDAV.
 * Phase 1: connection + read. Auth uses an Apple app-specific password from env
 * (ICLOUD_USER / ICLOUD_APP_PASSWORD). Server: https://caldav.icloud.com.
 */
import { createDAVClient } from "tsdav";
import ical from "node-ical";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const SERVER = "https://caldav.icloud.com";

export interface CalEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  calendar?: string;
  location?: string;
  description?: string;
}

let clientPromise: ReturnType<typeof createDAVClient> | null = null;

function client() {
  const username = process.env.ICLOUD_USER;
  const password = process.env.ICLOUD_APP_PASSWORD;
  if (!username || !password) {
    throw new Error("ICLOUD_USER / ICLOUD_APP_PASSWORD not set");
  }
  if (!clientPromise) {
    clientPromise = createDAVClient({
      serverUrl: SERVER,
      credentials: { username, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }
  return clientPromise;
}

function displayName(cal: any): string {
  const d = cal?.displayName;
  return typeof d === "string" && d ? d : "calendar";
}

/** Parse VEVENTs out of an iCalendar string. Pure — no network. Returns [] on bad input. */
export function parseEvents(icsString: string, calendarName?: string): CalEvent[] {
  let parsed: Record<string, any>;
  try {
    parsed = ical.sync.parseICS(icsString) as Record<string, any>;
  } catch {
    return [];
  }
  const events: CalEvent[] = [];
  for (const v of Object.values(parsed)) {
    if (v?.type !== "VEVENT") continue;
    const start = v.start instanceof Date ? v.start : new Date(v.start);
    const end = v.end instanceof Date ? v.end : v.end ? new Date(v.end) : start;
    const allDay = v.datetype === "date" || (v.start as any)?.dateOnly === true;
    events.push({
      uid: String(v.uid ?? v.url ?? ""),
      title: String(v.summary ?? "(no title)").trim() || "(no title)",
      start,
      end,
      allDay: !!allDay,
      calendar: calendarName,
      location: v.location ? String(v.location) : undefined,
      description: v.description ? String(v.description) : undefined,
    });
  }
  return events;
}

/** Normalize any valid date string (UTC, offset, or local) to a UTC instant. Throws on garbage. Pure. */
export function toUtcZ(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d.toISOString();
}

/** Fetch events between two instants across all the user's calendars. Inputs may carry any offset. */
export async function listEvents(fromISO: string, toISO: string): Promise<CalEvent[]> {
  const from = toUtcZ(fromISO);
  const to = toUtcZ(toISO);
  const c = await client();
  const calendars = await c.fetchCalendars();
  const out: CalEvent[] = [];
  for (const cal of calendars) {
    if (cal.components && !cal.components.includes("VEVENT")) continue; // skip reminders/contacts
    let objects: Array<{ data?: any }> = [];
    try {
      objects = await c.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start: from, end: to },
        expand: true,
      });
    } catch (e: any) {
      console.error(`[CAL] fetch failed for ${displayName(cal)}: ${e?.message ?? e}`);
      continue;
    }
    for (const o of objects) {
      if (typeof o.data === "string") out.push(...parseEvents(o.data, displayName(cal)));
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short local-time line, e.g. "Mon 09/06 09:00 — Dentist" or "Tue 10/06 all day — Holiday". */
export function fmtEvent(e: CalEvent): string {
  const d = e.start;
  const day = `${DAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const time = e.allDay ? "all day" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${time} — ${e.title}`;
}

// ---------------------------------------------------------------------------
// Proactive nudges (phase 2)
// ---------------------------------------------------------------------------

const NOTIFIED_FILE = process.env.CAL_NOTIFIED_FILE ?? join(import.meta.dir, "cal_notified.json");

/** Unique key per event occurrence (so we nudge each instance once). */
export function nudgeKey(e: CalEvent): string {
  return `${e.uid}@${e.start.getTime()}`;
}

/** Timed events starting within the next `withinMinutes` (excludes all-day & already-started). Pure. */
export function selectUpcoming(events: CalEvent[], nowMs: number, withinMinutes: number): CalEvent[] {
  const horizon = nowMs + withinMinutes * 60_000;
  return events.filter((e) => !e.allDay && e.start.getTime() > nowMs && e.start.getTime() <= horizon);
}

/** Fetch timed events starting within the next `withinMinutes`. */
export async function upcomingEvents(withinMinutes: number, nowMs = Date.now()): Promise<CalEvent[]> {
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + withinMinutes * 60_000).toISOString();
  return selectUpcoming(await listEvents(from, to), nowMs, withinMinutes);
}

export function loadNotified(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(NOTIFIED_FILE, "utf8"));
  } catch {
    return {};
  }
}
export function saveNotified(map: Record<string, number>) {
  const tmp = NOTIFIED_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, NOTIFIED_FILE);
}
/** Drop entries for events more than an hour past, so the file can't grow forever. Pure. */
export function pruneNotified(map: Record<string, number>, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, startMs] of Object.entries(map)) {
    if (startMs > nowMs - 3_600_000) out[k] = startMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write (phase 3) — build the iCalendar text, then create on the server.
// ---------------------------------------------------------------------------

export interface EventInput {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  description?: string;
  location?: string;
  dtstamp: Date;
}

/** RFC-5545 TEXT escaping: backslash first, then newlines, semicolons, commas. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** UTC timestamp form, e.g. 20260610T150000Z. */
function fmtUTC(d: Date): string {
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

/** Date-only form for all-day events, e.g. 20260610. */
function fmtDate(d: Date): string {
  return String(d.getUTCFullYear()).padStart(4, "0") + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}

/** Build a complete VCALENDAR/VEVENT iCalendar string. Pure — no network. */
export function buildVEvent(input: EventInput): string {
  const { uid, title, start, end, allDay, description, location, dtstamp } = input;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//maor-telegram-bot//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmtUTC(dtstamp)}`,
  ];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtDate(end)}`);
  } else {
    lines.push(`DTSTART:${fmtUTC(start)}`);
    lines.push(`DTEND:${fmtUTC(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(title)}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** Calendars that can hold events (VEVENT), by display name. */
export async function listCalendarNames(): Promise<string[]> {
  const c = await client();
  const calendars = await c.fetchCalendars();
  return calendars.filter((cal) => !cal.components || cal.components.includes("VEVENT")).map(displayName);
}

export interface NewEvent {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  description?: string;
  location?: string;
}

export interface CreateResult {
  uid: string;
  url: string;
  calendar: string;
}

/**
 * Create an event on the server. Picks the target calendar by name (case-insensitive)
 * or falls back to the first event-capable calendar. Network — not unit-tested; verify live.
 */
export async function createEvent(
  ev: NewEvent,
  calendarName?: string,
  nowMs: number = Date.now(),
): Promise<CreateResult> {
  const c = await client();
  const calendars = (await c.fetchCalendars()).filter(
    (cal) => !cal.components || cal.components.includes("VEVENT"),
  );
  if (!calendars.length) throw new Error("no event-capable calendar found");
  const target =
    (calendarName &&
      calendars.find((cal) => displayName(cal).toLowerCase() === calendarName.toLowerCase())) ||
    calendars[0];
  const uid = `${crypto.randomUUID()}@maor-bot`;
  const iCalString = buildVEvent({ ...ev, uid, dtstamp: new Date(nowMs) });
  const res: any = await c.createCalendarObject({ calendar: target, filename: `${uid}.ics`, iCalString });
  if (res && res.ok === false) {
    throw new Error(`server rejected create: ${res.status} ${res.statusText ?? ""}`.trim());
  }
  return { uid, url: res?.url ?? "", calendar: displayName(target) };
}

// ---------------------------------------------------------------------------
// Edit / delete (phase 3) — locate an event, then update or remove it.
// ---------------------------------------------------------------------------

export interface FoundEvent extends CalEvent {
  url: string;
  etag?: string;
  raw: string;
}

export interface EventPatch {
  title?: string;
  start?: Date;
  end?: Date;
  allDay?: boolean;
  location?: string;
  description?: string;
}

/** True if the raw iCalendar text carries a recurrence rule. Pure. */
export function isRecurring(raw: string): boolean {
  return /(^|\n)RRULE[:;]/.test(raw);
}

/** Merge a patch onto an event's fields, keeping the uid and any unset fields. Pure. */
export function mergeEvent(base: CalEvent, patch: EventPatch, dtstamp: Date): EventInput {
  return {
    uid: base.uid,
    title: patch.title ?? base.title,
    start: patch.start ?? base.start,
    end: patch.end ?? base.end,
    allDay: patch.allDay ?? base.allDay,
    location: patch.location ?? base.location,
    description: patch.description ?? base.description,
    dtstamp,
  };
}

/** Find events in a range (optionally title-filtered), keeping url/etag/raw for edit & delete. */
export async function findEvents(
  fromISO: string,
  toISO: string,
  titleQuery?: string,
): Promise<FoundEvent[]> {
  const from = toUtcZ(fromISO);
  const to = toUtcZ(toISO);
  const c = await client();
  const calendars = await c.fetchCalendars();
  const out: FoundEvent[] = [];
  for (const cal of calendars) {
    if (cal.components && !cal.components.includes("VEVENT")) continue;
    let objects: Array<{ data?: any; etag?: string; url: string }> = [];
    try {
      objects = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: from, end: to }, expand: false });
    } catch (e: any) {
      console.error(`[CAL] find failed for ${displayName(cal)}: ${e?.message ?? e}`);
      continue;
    }
    for (const o of objects) {
      if (typeof o.data !== "string") continue;
      for (const e of parseEvents(o.data, displayName(cal))) {
        out.push({ ...e, url: o.url, etag: o.etag, raw: o.data });
      }
    }
  }
  const q = titleQuery?.toLowerCase();
  const filtered = q ? out.filter((e) => e.title.toLowerCase().includes(q)) : out;
  return filtered.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Update an event in place (rebuilds from merged fields, keeps the uid). Refuses recurring events. */
export async function updateEvent(
  target: FoundEvent,
  patch: EventPatch,
  nowMs: number = Date.now(),
): Promise<void> {
  if (isRecurring(target.raw)) {
    throw new Error("that event repeats — edit recurring events on your phone so the series isn't broken");
  }
  const iCalString = buildVEvent(mergeEvent(target, patch, new Date(nowMs)));
  const c = await client();
  const res: any = await c.updateCalendarObject({
    calendarObject: { url: target.url, etag: target.etag, data: iCalString },
  });
  if (res && res.ok === false) {
    throw new Error(`server rejected update: ${res.status} ${res.statusText ?? ""}`.trim());
  }
}

/** Delete an event by its object url/etag. */
export async function deleteEvent(target: { url: string; etag?: string }): Promise<void> {
  const c = await client();
  const res: any = await c.deleteCalendarObject({ calendarObject: { url: target.url, etag: target.etag } });
  if (res && res.ok === false) {
    throw new Error(`server rejected delete: ${res.status} ${res.statusText ?? ""}`.trim());
  }
}
