/**
 * calendar.ts — read (and later write) the user's iCloud calendar over CalDAV.
 * Phase 1: connection + read. Auth uses an Apple app-specific password from env
 * (ICLOUD_USER / ICLOUD_APP_PASSWORD). Server: https://caldav.icloud.com.
 */
import { createDAVClient } from "tsdav";
import ical from "node-ical";

const SERVER = "https://caldav.icloud.com";

export interface CalEvent {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  calendar?: string;
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
    });
  }
  return events;
}

/** Fetch events between two ISO instants (UTC, ...Z) across all the user's calendars. */
export async function listEvents(fromISO: string, toISO: string): Promise<CalEvent[]> {
  const c = await client();
  const calendars = await c.fetchCalendars();
  const out: CalEvent[] = [];
  for (const cal of calendars) {
    if (cal.components && !cal.components.includes("VEVENT")) continue; // skip reminders/contacts
    let objects: Array<{ data?: any }> = [];
    try {
      objects = await c.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start: fromISO, end: toISO },
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
