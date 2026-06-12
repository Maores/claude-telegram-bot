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

// ---------------------------------------------------------------------------
// Network — thin tsdav wrappers. Live-verified on the droplet (post-merge arc
// in the PR); creds exist only there.
// ---------------------------------------------------------------------------

/** tsdav's default fetchCalendarObjects filter is hard-coded to VEVENT, so a
 *  todo fetch MUST send its own comp-filter or iCloud returns nothing. */
const TODO_FILTERS = [
  {
    "comp-filter": {
      _attributes: { name: "VCALENDAR" },
      "comp-filter": { _attributes: { name: "VTODO" } },
    },
  },
];

function displayName(cal: any): string {
  const d = cal?.displayName;
  return typeof d === "string" && d ? d : "list";
}

/** Collections that can hold todos. Strict (no components ⇒ excluded): iCloud
 *  declares components, and guessing wrong would write a task into an events
 *  calendar. */
async function todoCollections() {
  const c = await client();
  return (await c.fetchCalendars()).filter((cal) => cal.components?.includes("VTODO"));
}

/** Todo-capable list names (CLI `lists`). */
export async function listNames(): Promise<string[]> {
  return (await todoCollections()).map(displayName);
}

/** Pick the target list: named match → DEFAULT_LIST → first todo-capable. */
function pickList(collections: any[], listName?: string) {
  if (!collections.length) throw new Error("no todo-capable list found on the account");
  const byName = (n: string) =>
    collections.find((cal) => displayName(cal).toLowerCase() === n.toLowerCase());
  if (listName) {
    const hit = byName(listName);
    if (!hit) {
      throw new Error(
        `no list named "${listName}" — existing lists: ${collections.map(displayName).join(", ")}`,
      );
    }
    return hit;
  }
  return byName(DEFAULT_LIST) ?? collections[0];
}

/** All todos (open + done), every list or one list. NO timeRange: CalDAV
 *  time-range filters exclude todos without DUE (RFC 4791), and Reminders
 *  lists are small — fetch all, filter client-side. Permissive urlFilter so a
 *  non-.ics resource name can't silently vanish. */
export async function listTodos(listName?: string): Promise<FoundTask[]> {
  const c = await client();
  let collections = await todoCollections();
  if (listName) collections = [pickList(collections, listName)];
  const out: FoundTask[] = [];
  for (const cal of collections) {
    let objects: Array<{ data?: any; etag?: string; url: string }> = [];
    try {
      objects = await c.fetchCalendarObjects({
        calendar: cal,
        filters: TODO_FILTERS,
        urlFilter: (url: string) => !!url,
      });
    } catch (e: any) {
      console.error(`[TASKS] fetch failed for ${displayName(cal)}: ${e?.message ?? e}`);
      continue;
    }
    for (const o of objects) {
      if (typeof o.data !== "string") continue;
      for (const t of parseTodos(o.data, displayName(cal))) {
        out.push({ ...t, url: o.url, etag: o.etag, raw: o.data });
      }
    }
  }
  return sortTasks(out);
}

/** Title-substring search (case-insensitive) over all tasks. */
export async function findTodos(query?: string, listName?: string): Promise<FoundTask[]> {
  const all = await listTodos(listName);
  const q = query?.toLowerCase();
  return q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all;
}

export interface NewTodo {
  title: string;
  due?: Date;
  dueDateOnly?: boolean;
  notes?: string;
}

export interface CreateTodoResult {
  uid: string;
  url: string;
  list: string;
}

/** Create a todo in the named list (default "תזכורות"). */
export async function createTodo(
  todo: NewTodo,
  listName?: string,
  nowMs: number = Date.now(),
): Promise<CreateTodoResult> {
  const c = await client();
  const target = pickList(await todoCollections(), listName);
  const uid = `${crypto.randomUUID()}@maor-bot`;
  const iCalString = buildVTodo({ ...todo, uid, dtstamp: new Date(nowMs) });
  const res: any = await c.createCalendarObject({ calendar: target, filename: `${uid}.ics`, iCalString });
  if (res && res.ok === false) {
    throw new Error(`server rejected create: ${res.status} ${res.statusText ?? ""}`.trim());
  }
  return { uid, url: res?.url ?? "", list: displayName(target) };
}

/** Update a task in place (rebuild from merged fields, keep the uid). Refuses
 *  recurring tasks — raw CalDAV edits there risk the whole series. */
export async function updateTodo(
  target: FoundTask,
  patch: TaskPatch,
  nowMs: number = Date.now(),
): Promise<void> {
  if (target.recurring) {
    throw new Error("that task repeats — change it on your phone so the series isn't broken");
  }
  const iCalString = buildVTodo(mergeTask(target, patch, new Date(nowMs)));
  const c = await client();
  const res: any = await c.updateCalendarObject({
    calendarObject: { url: target.url, etag: target.etag, data: iCalString },
  });
  if (res && res.ok === false) {
    throw new Error(`server rejected update: ${res.status} ${res.statusText ?? ""}`.trim());
  }
}

/** Mark a task completed (STATUS/COMPLETED/PERCENT-COMPLETE). */
export async function completeTodo(target: FoundTask, nowMs: number = Date.now()): Promise<void> {
  await updateTodo(target, { done: true, completedAt: new Date(nowMs) }, nowMs);
}

/** Delete a task by its object url/etag. The chat-level confirm (and the
 *  recurring-series warning) happens in CLAUDE.md, not here. */
export async function deleteTodo(target: { url: string; etag?: string }): Promise<void> {
  const c = await client();
  const res: any = await c.deleteCalendarObject({ calendarObject: { url: target.url, etag: target.etag } });
  if (res && res.ok === false) {
    throw new Error(`server rejected delete: ${res.status} ${res.statusText ?? ""}`.trim());
  }
}
