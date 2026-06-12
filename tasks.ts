/**
 * tasks.ts — Maor's real Apple Reminders over iCloud CalDAV (VTODO), mirroring
 * calendar.ts (VEVENT). Pure parse/build/merge core is unit-tested; network
 * wrappers are thin and live-verified on the droplet (creds exist only there).
 * Spec: docs/superpowers/specs/2026-06-12-tasks-reminders-design.md
 */
import ical from "node-ical";
import { client, escapeText, fmtUTC, fmtDate } from "./calendar.ts";

/** Writes default to this list (Maor's iPhone default). Falls back to the
 *  first todo-capable collection if it's ever renamed. */
export const DEFAULT_LIST = "תזכורות";

export interface TaskItem {
  uid: string;
  title: string;
  due?: Date;
  /** true when DUE was VALUE=DATE (a day, not an instant) */
  dueDateOnly?: boolean;
  done: boolean;
  completedAt?: Date;
  notes?: string;
  recurring: boolean;
  list?: string;
}

/** A task located on the server, carrying what edit/complete/delete need. */
export interface FoundTask extends TaskItem {
  url: string;
  etag?: string;
  raw: string;
}

/** node-ical renders some text props as {params, val} when parameters are
 *  present — normalize either shape to a plain string. */
function pv(x: unknown): string {
  if (x && typeof x === "object" && "val" in (x as any)) return String((x as any).val);
  return x == null ? "" : String(x);
}

/** node-ical throws when a VTODO has RRULE but no DTSTART (curr.start is
 *  undefined and it tries to call .toISOString() on it). Inject a synthetic
 *  DTSTART:19700101T000000Z so the parser can build the RRule object — the
 *  epoch value is irrelevant; we only care that !!v.rrule is truthy. */
function injectMissingDtstart(ics: string): string {
  // Split on CRLF or LF so we handle both line endings.
  const lines = ics.split(/\r\n|\n/);
  const out: string[] = [];
  let inVtodo = false;
  let hasDtstart = false;
  let hasRrule = false;
  // Two-pass: collect lines per VTODO, inject if needed.
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VTODO") {
      current = [line];
      inVtodo = true;
      hasDtstart = false;
      hasRrule = false;
    } else if (line === "END:VTODO" && current) {
      if (hasRrule && !hasDtstart) {
        current.splice(1, 0, "DTSTART:19700101T000000Z");
      }
      current.push(line);
      blocks.push(current);
      current = null;
      inVtodo = false;
    } else if (inVtodo && current) {
      if (line.startsWith("DTSTART")) hasDtstart = true;
      if (line.startsWith("RRULE")) hasRrule = true;
      current.push(line);
    } else {
      blocks.push([line]);
    }
  }
  return blocks.flat().join("\r\n");
}

/** Parse VTODOs out of an iCalendar string. Pure — no network. [] on bad input. */
export function parseTodos(icsString: string, listName?: string): TaskItem[] {
  let parsed: Record<string, any>;
  try {
    parsed = ical.sync.parseICS(injectMissingDtstart(icsString)) as Record<string, any>;
  } catch {
    return [];
  }
  const out: TaskItem[] = [];
  for (const v of Object.values(parsed)) {
    if (v?.type !== "VTODO") continue;
    let due = v.due instanceof Date ? v.due : undefined;
    const dueDateOnly = (due as any)?.dateOnly === true;
    // node-ical builds VALUE=DATE dates at LOCAL midnight; normalize to UTC
    // midnight so re-emitting via fmtDate (UTC getters) can't shift the day.
    if (due && dueDateOnly) {
      due = new Date(Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()));
    }
    const completedAt = v.completed instanceof Date ? v.completed : undefined;
    out.push({
      uid: String(v.uid ?? ""),
      title: pv(v.summary).trim() || "(no title)",
      due,
      dueDateOnly: dueDateOnly || undefined,
      done: v.status === "COMPLETED" || !!completedAt,
      completedAt,
      notes: v.description ? pv(v.description) : undefined,
      recurring: !!v.rrule,
      list: listName,
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One human line, e.g. "☐ Pay rent — Mon 15/06 09:00 🔁 (תזכורות)".
 *  Local getters — the server clock is Asia/Jerusalem, and node-ical builds
 *  date-only dates at local midnight. */
export function fmtTask(t: TaskItem): string {
  let s = `${t.done ? "☑" : "☐"} ${t.title}`;
  if (t.due) {
    const d = t.due;
    s += ` — ${DAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
    if (!t.dueDateOnly) s += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (t.recurring) s += " 🔁";
  if (t.list) s += ` (${t.list})`;
  return s;
}

export type SelectMode = "open" | "done" | "all";

/** Filter by completion state. Pure. */
export function selectTasks(tasks: TaskItem[], mode: SelectMode): TaskItem[] {
  if (mode === "open") return tasks.filter((t) => !t.done);
  if (mode === "done") return tasks.filter((t) => t.done);
  return tasks;
}

/** Open before done, then due ascending (no-due last), then title. Pure.
 *  Generic so FoundTask[] sorts without losing its type. */
export function sortTasks<T extends TaskItem>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity) ||
      a.title.localeCompare(b.title),
  );
}

/** Input for building a VTODO. `done` requires `completedAt`. */
export interface TodoInput {
  uid: string;
  title: string;
  due?: Date;
  dueDateOnly?: boolean;
  notes?: string;
  done?: boolean;
  completedAt?: Date;
  dtstamp: Date;
}

/** Build a complete VCALENDAR/VTODO iCalendar string. Pure — no network.
 *  Same PRODID + CRLF discipline as buildVEvent. */
export function buildVTodo(input: TodoInput): string {
  const { uid, title, due, dueDateOnly, notes, done, completedAt, dtstamp } = input;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//maor-telegram-bot//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${fmtUTC(dtstamp)}`,
    `SUMMARY:${escapeText(title)}`,
  ];
  if (due) {
    lines.push(dueDateOnly ? `DUE;VALUE=DATE:${fmtDate(due)}` : `DUE:${fmtUTC(due)}`);
  }
  if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
  if (done) {
    lines.push("STATUS:COMPLETED");
    if (completedAt) lines.push(`COMPLETED:${fmtUTC(completedAt)}`);
    lines.push("PERCENT-COMPLETE:100");
  } else {
    lines.push("STATUS:NEEDS-ACTION");
  }
  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export interface TaskPatch {
  title?: string;
  /** a Date moves the due; null clears it; undefined leaves it alone */
  due?: Date | null;
  dueDateOnly?: boolean;
  notes?: string;
  done?: boolean;
  completedAt?: Date;
}

/** Merge a patch onto a task's fields, keeping the uid and unset fields. Pure. */
export function mergeTask(base: TaskItem, patch: TaskPatch, dtstamp: Date): TodoInput {
  const due = patch.due === null ? undefined : (patch.due ?? base.due);
  const dueDateOnly =
    patch.due === null ? undefined
    : patch.due !== undefined ? (patch.dueDateOnly ?? false) || undefined
    : base.dueDateOnly;
  return {
    uid: base.uid,
    title: patch.title ?? base.title,
    due,
    dueDateOnly,
    notes: patch.notes ?? base.notes,
    done: patch.done ?? base.done,
    completedAt: patch.completedAt ?? base.completedAt,
    dtstamp,
  };
}
