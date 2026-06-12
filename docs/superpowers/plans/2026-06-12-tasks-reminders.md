# Tasks → Apple Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-CRUD natural-language task list from chat — VTODOs written to Maor's real Apple Reminders ("תזכורות" by default) over the same iCloud CalDAV the calendar uses, so tasks sync to the iPhone.

**Architecture:** New isolated pair mirroring the calendar: `tasks.ts` (pure parse/build/merge core + thin tsdav network wrappers) and `todo.ts` (CLI with `cal.ts` conventions). `calendar.ts` only gains `export` on four existing helpers. `poller.ts` untouched. The bot learns routing + commands from a new CLAUDE.md section.

**Tech Stack:** Bun + TypeScript, `bun:test`, tsdav + node-ical (both already installed; node-ical parses VTODO natively).

**Spec:** `docs/superpowers/specs/2026-06-12-tasks-reminders-design.md` (approved; Maor's four decisions recorded there).

**Conventions:** suite gate = `bun test 2>&1 | tail -3; echo "SUITE_EXIT:${PIPESTATUS[0]}"` — judge by `SUITE_EXIT:0`, never a piped tail's exit. Commits: conventional style + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Branch: `feat/tasks-reminders` off main (created in Task 1). Live iCloud creds exist ONLY on the droplet — nothing in this plan talks to the network; the post-merge live arc is in the PR body.

**Verified facts the implementer must NOT re-litigate:**
- tsdav's `fetchCalendarObjects` defaults its REPORT filter to `VEVENT` (tsdav.js ~line 9642) — todo fetches MUST pass the custom VTODO `filters` shown in Task 4, or iCloud returns zero todos.
- node-ical parses VTODO (typed in `node-ical.d.ts`: `due`, `status`, `completed`, `completion`, `priority`, `rrule`) and marks `VALUE=DATE` dates with `dateOnly === true` on the parsed `Date`.
- `cal.ts` executes its command dispatch at module top level — `todo.ts` must NOT import anything from it (copy the three tiny CLI helpers instead).

---

### Task 1: Branch + export four calendar helpers

**Files:**
- Modify: `calendar.ts` (lines ~26, ~182, ~191, ~205 — add `export` only)

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git pull && git checkout -b feat/tasks-reminders
```

- [ ] **Step 1.2: Add `export` to four declarations in `calendar.ts`** (JSDoc lines above them stay; bodies untouched):

| ~line | before | after |
|---|---|---|
| 26 | `function client() {` | `export function client() {` |
| 182 | `function escapeText(s: string): string {` | `export function escapeText(s: string): string {` |
| 191 | `function fmtUTC(d: Date): string {` | `export function fmtUTC(d: Date): string {` |
| 205 | `function fmtDate(d: Date): string {` | `export function fmtDate(d: Date): string {` |

- [ ] **Step 1.3: Suite gate**

```bash
bun test 2>&1 | tail -3; echo "SUITE_EXIT:${PIPESTATUS[0]}"
```
Expected: `SUITE_EXIT:0`, same test count as main (402) — pure refactor, zero behavior change.

- [ ] **Step 1.4: Commit**

```bash
git add calendar.ts
git commit -m "refactor(calendar): export client/escapeText/fmtUTC/fmtDate for the tasks module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `tasks.ts` — types + `parseTodos` + `fmtTask` + `selectTasks`/`sortTasks` (read-side pure core)

**Files:**
- Create: `tasks.ts`
- Create: `tasks.test.ts`

- [ ] **Step 2.1: Write the failing tests** — create `tasks.test.ts`:

```ts
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
```

- [ ] **Step 2.2: Run** `bun test tasks.test.ts` — expect FAIL: `Cannot find module './tasks'`.

- [ ] **Step 2.3: Create `tasks.ts`** with the read-side core:

```ts
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

/** Parse VTODOs out of an iCalendar string. Pure — no network. [] on bad input. */
export function parseTodos(icsString: string, listName?: string): TaskItem[] {
  let parsed: Record<string, any>;
  try {
    parsed = ical.sync.parseICS(icsString) as Record<string, any>;
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
```

- [ ] **Step 2.4: Run** `bun test tasks.test.ts` — all pass. If the `dueDateOnly` test fails because node-ical didn't set `dateOnly`, STOP and re-read the fixture (the property is set for `VALUE=DATE` — see ical.js ~line 358); do not weaken the assertion.

- [ ] **Step 2.5: Full suite gate** — `SUITE_EXIT:0`.

- [ ] **Step 2.6: Commit**

```bash
git add tasks.ts tasks.test.ts
git commit -m "feat(tasks): VTODO read core - parseTodos, fmtTask, select/sort

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `tasks.ts` — `buildVTodo` + `mergeTask` (write-side pure core)

**Files:**
- Modify: `tasks.ts` (append)
- Modify: `tasks.test.ts` (append)

- [ ] **Step 3.1: Append the failing tests** (extend the import line with `buildVTodo, mergeTask, type TodoInput`):

```ts
const STAMP = new Date("2026-06-12T08:00:00Z");

test("buildVTodo: minimal open todo, CRLF + trailing CRLF", () => {
  const ics = buildVTodo({ uid: "u-1", title: "לקנות חלב", dtstamp: STAMP });
  expect(ics).toBe(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//maor-telegram-bot//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VTODO",
      "UID:u-1",
      "DTSTAMP:20260612T080000Z",
      "SUMMARY:לקנות חלב",
      "STATUS:NEEDS-ACTION",
      "END:VTODO",
      "END:VCALENDAR",
    ].join("\r\n") + "\r\n",
  );
});

test("buildVTodo: timed due / date-only due", () => {
  const timed = buildVTodo({ uid: "u", title: "t", due: new Date("2026-06-15T09:00:00Z"), dtstamp: STAMP });
  expect(timed).toContain("DUE:20260615T090000Z");
  const dateOnly = buildVTodo({ uid: "u", title: "t", due: new Date("2026-06-20T00:00:00Z"), dueDateOnly: true, dtstamp: STAMP });
  expect(dateOnly).toContain("DUE;VALUE=DATE:20260620");
});

test("buildVTodo: done emits STATUS/COMPLETED/PERCENT-COMPLETE", () => {
  const ics = buildVTodo({ uid: "u", title: "t", done: true, completedAt: new Date("2026-06-11T13:00:00Z"), dtstamp: STAMP });
  expect(ics).toContain("STATUS:COMPLETED");
  expect(ics).toContain("COMPLETED:20260611T130000Z");
  expect(ics).toContain("PERCENT-COMPLETE:100");
});

test("buildVTodo: escapes text fields", () => {
  const ics = buildVTodo({ uid: "u", title: "a,b;c\nd", notes: "x;y", dtstamp: STAMP });
  expect(ics).toContain("SUMMARY:a\\,b\\;c\\nd");
  expect(ics).toContain("DESCRIPTION:x\\;y");
});

test("roundtrip: parseTodos(buildVTodo(x)) preserves the fields", () => {
  const ics = buildVTodo({
    uid: "rt-1", title: "Round trip", due: new Date("2026-06-15T09:00:00Z"),
    notes: "note", dtstamp: STAMP,
  });
  const t = parseTodos(ics)[0];
  expect(t.uid).toBe("rt-1");
  expect(t.title).toBe("Round trip");
  expect(t.due?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  expect(t.notes).toBe("note");
  expect(t.done).toBe(false);
});

test("roundtrip: a date-only due survives build → parse → build unchanged", () => {
  const due = new Date(Date.UTC(2026, 5, 20)); // 2026-06-20, UTC midnight
  const first = buildVTodo({ uid: "rt-2", title: "t", due, dueDateOnly: true, dtstamp: STAMP });
  expect(first).toContain("DUE;VALUE=DATE:20260620");
  const reparsed = parseTodos(first)[0];
  const second = buildVTodo(mergeTask(reparsed, { title: "t2" }, STAMP));
  // the edit path must NOT shift the day (local-midnight parse vs UTC fmtDate)
  expect(second).toContain("DUE;VALUE=DATE:20260620");
});

test("mergeTask: patches fields, clears due with null, completes with done", () => {
  const base: TaskItem = {
    uid: "m-1", title: "Old", due: new Date("2026-06-15T09:00:00Z"),
    done: false, recurring: false, notes: "keep",
  };
  const titled = mergeTask(base, { title: "New" }, STAMP);
  expect(titled.title).toBe("New");
  expect(titled.due?.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  expect(titled.notes).toBe("keep");
  expect(titled.dtstamp).toBe(STAMP);

  const cleared = mergeTask(base, { due: null }, STAMP);
  expect(cleared.due).toBeUndefined();

  const moved = mergeTask(base, { due: new Date("2026-06-20T00:00:00Z"), dueDateOnly: true }, STAMP);
  expect(moved.due?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  expect(moved.dueDateOnly).toBe(true);

  const finished = mergeTask(base, { done: true, completedAt: new Date("2026-06-12T07:00:00Z") }, STAMP);
  expect(finished.done).toBe(true);
  expect(finished.completedAt?.toISOString()).toBe("2026-06-12T07:00:00.000Z");
});
```

- [ ] **Step 3.2: Run** `bun test tasks.test.ts` — expect FAIL (missing exports).

- [ ] **Step 3.3: Append to `tasks.ts`:**

```ts
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
```

- [ ] **Step 3.4: Run** `bun test tasks.test.ts` — all pass; then the full suite gate — `SUITE_EXIT:0`.

- [ ] **Step 3.5: Commit**

```bash
git add tasks.ts tasks.test.ts
git commit -m "feat(tasks): VTODO write core - buildVTodo + mergeTask

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `tasks.ts` — network wrappers (collections, list/find, create/update/complete/delete)

**Files:**
- Modify: `tasks.ts` (append)

No new unit tests: these are thin tsdav glue around the tested pure core, matching how calendar.ts's network layer is handled (live-verified on the droplet instead). The full suite still gates.

- [ ] **Step 4.1: Append to `tasks.ts`:**

```ts
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
```

- [ ] **Step 4.2: Full suite gate** — `SUITE_EXIT:0` (type-check via the test run; no behavior change to tested code).

- [ ] **Step 4.3: Commit**

```bash
git add tasks.ts
git commit -m "feat(tasks): network layer - VTODO filters, list/find/create/update/complete/delete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `todo.ts` — the CLI

**Files:**
- Create: `todo.ts`

`cal.ts` conventions throughout, but do NOT import from `cal.ts` (it executes its command dispatch at module top level) — the three small helpers are copied. No unit tests for the CLI (matches cal.ts); Step 5.2 smoke-checks it without creds.

- [ ] **Step 5.1: Create `todo.ts`:**

```ts
/**
 * todo.ts — CLI the bot calls to manage Maor's Apple Reminders tasks.
 *   bun run todo.ts list   [--done | --all] [--list "<name>"]
 *   bun run todo.ts lists
 *   bun run todo.ts add    --title "..." [--due <when>] [--list "<name>"] [--notes "..."]
 *   bun run todo.ts find   [--q "<title substr>"] [--list "<name>"]      (prints [uid] lines)
 *   bun run todo.ts done   (--uid <uid> | --q "...")
 *   bun run todo.ts snooze (--uid <uid> | --q "...") --to <when>
 *   bun run todo.ts edit   (--uid <uid> | --q "...") [--set-title "..."] [--set-due <when> | --clear-due] [--set-notes "..."]
 *   bun run todo.ts delete (--uid <uid> | --q "...")
 *
 * <when> is a local+offset timestamp (date -d '...' +%Y-%m-%dT%H:%M:%S%:z) or a
 * bare YYYY-MM-DD (becomes a date-only due). DELETE must only run AFTER Maor
 * explicitly confirmed in chat; everything else runs immediately and is echoed.
 */
import {
  listTodos,
  findTodos,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
  listNames,
  fmtTask,
  selectTasks,
  type FoundTask,
  type TaskPatch,
  type SelectMode,
} from "./tasks.ts";

// --- copied from cal.ts (cannot import: cal.ts runs its dispatch on import) ---

/** Parse `--key value` pairs and bare `--flag` booleans out of argv. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** A date string is either a full instant (offset/UTC) or a bare YYYY-MM-DD. */
function parseWhen(raw: string): Date {
  return new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
}

// -----------------------------------------------------------------------------

const dateOnlyRaw = (raw: string) => raw.length === 10;

/** Resolve flags to exactly one task from `pool`, or throw with candidates. */
function resolveTask(pool: FoundTask[], uid?: string, q?: string): FoundTask {
  const sel = uid
    ? pool.filter((t) => t.uid === uid)
    : q
      ? pool.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()))
      : [];
  if (sel.length === 0) throw new Error("no matching task (try `find` to see uids)");
  if (sel.length > 1) {
    const list = sel.map((t) => `  [${t.uid}] ${fmtTask(t)}`).join("\n");
    throw new Error(`multiple tasks match — pick one with --uid:\n${list}`);
  }
  return sel[0];
}

/** done/snooze/edit act on open tasks; delete/find act on everything. */
async function resolveOpen(f: Record<string, string | boolean>): Promise<FoundTask> {
  const pool = (await listTodos(str(f.list))).filter((t) => !t.done);
  return resolveTask(pool, str(f.uid), str(f.q));
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "list") {
    const f = parseFlags(rest);
    const mode: SelectMode = f.all === true ? "all" : f.done === true ? "done" : "open";
    const tasks = selectTasks(await listTodos(str(f.list)), mode);
    if (!tasks.length) {
      console.log(mode === "open" ? "(no open tasks)" : mode === "done" ? "(no completed tasks)" : "(no tasks)");
    } else {
      for (const t of tasks) console.log(fmtTask(t));
    }
  } else if (cmd === "lists") {
    const names = await listNames();
    console.log(names.length ? names.join("\n") : "(no task lists)");
  } else if (cmd === "add") {
    const f = parseFlags(rest);
    const title = str(f.title);
    if (!title) {
      throw new Error('usage: todo.ts add --title "..." [--due <when>] [--list "<name>"] [--notes "..."]');
    }
    const dueRaw = str(f.due);
    const due = dueRaw ? parseWhen(dueRaw) : undefined;
    if (due && isNaN(due.getTime())) throw new Error("invalid --due date");
    const res = await createTodo(
      { title, due, dueDateOnly: dueRaw ? dateOnlyRaw(dueRaw) : undefined, notes: str(f.notes) },
      str(f.list),
    );
    console.log(`created "${title}" in list "${res.list}" (uid ${res.uid})`);
  } else if (cmd === "find") {
    const f = parseFlags(rest);
    const matches = await findTodos(str(f.q), str(f.list));
    if (!matches.length) console.log("(no matching tasks)");
    else for (const t of matches) console.log(`[${t.uid}] ${fmtTask(t)}`);
  } else if (cmd === "done") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) throw new Error('usage: todo.ts done (--uid <uid> | --q "...")');
    const target = await resolveOpen(f);
    await completeTodo(target);
    console.log(`completed "${target.title}"`);
  } else if (cmd === "snooze") {
    const f = parseFlags(rest);
    const toRaw = str(f.to);
    if ((!str(f.uid) && !str(f.q)) || !toRaw) {
      throw new Error('usage: todo.ts snooze (--uid <uid> | --q "...") --to <when>');
    }
    const to = parseWhen(toRaw);
    if (isNaN(to.getTime())) throw new Error("invalid --to date");
    const target = await resolveOpen(f);
    await updateTodo(target, { due: to, dueDateOnly: dateOnlyRaw(toRaw) });
    console.log(`snoozed "${target.title}" to ${toRaw}`);
  } else if (cmd === "edit") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) {
      throw new Error('usage: todo.ts edit (--uid <uid> | --q "...") [--set-title "..."] [--set-due <when> | --clear-due] [--set-notes "..."]');
    }
    const patch: TaskPatch = {};
    if (str(f["set-title"]) !== undefined) patch.title = str(f["set-title"]);
    const sd = str(f["set-due"]);
    if (sd && f["clear-due"] === true) throw new Error("edit: --set-due and --clear-due are mutually exclusive");
    if (sd) {
      patch.due = parseWhen(sd);
      patch.dueDateOnly = dateOnlyRaw(sd);
      if (isNaN(patch.due.getTime())) throw new Error("invalid --set-due date");
    } else if (f["clear-due"] === true) {
      patch.due = null;
    }
    if (str(f["set-notes"]) !== undefined) patch.notes = str(f["set-notes"]);
    if (Object.keys(patch).length === 0) {
      throw new Error("edit: nothing to change (use --set-title / --set-due / --clear-due / --set-notes)");
    }
    const target = await resolveOpen(f);
    await updateTodo(target, patch);
    console.log(`updated "${patch.title ?? target.title}" (uid ${target.uid})`);
  } else if (cmd === "delete") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) throw new Error('usage: todo.ts delete (--uid <uid> | --q "...")');
    const pool = await listTodos(str(f.list)); // delete may target completed tasks too
    const target = resolveTask(pool, str(f.uid), str(f.q));
    await deleteTodo(target);
    console.log(`deleted "${target.title}"${target.recurring ? " (recurring — whole series removed)" : ""}`);
  } else {
    throw new Error("usage: todo.ts <list|lists|add|find|done|snooze|edit|delete> ...");
  }
} catch (e: any) {
  console.error(`task error: ${e?.message ?? e}`);
  process.exit(1);
}
```

- [ ] **Step 5.2: Smoke-check without creds** (local machine has no `ICLOUD_USER`, so the client throws — the CLI must fail CLEANLY):

```bash
bun run todo.ts 2>&1; echo "EXIT:$?"
bun run todo.ts lists 2>&1; echo "EXIT:$?"
```
Expected line 1: `task error: usage: todo.ts <list|lists|add|find|done|snooze|edit|delete> ...` then `EXIT:1`.
Expected line 2: `task error: ICLOUD_USER / ICLOUD_APP_PASSWORD not set` then `EXIT:1`.

- [ ] **Step 5.3: Full suite gate** — `SUITE_EXIT:0`.

- [ ] **Step 5.4: Commit**

```bash
git add todo.ts
git commit -m "feat(tasks): todo.ts CLI - list/lists/add/find/done/snooze/edit/delete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs — CLAUDE.md (bot behavior) + README feature line

**Files:**
- Modify: `CLAUDE.md` (insert a new `## Tasks (Apple Reminders)` section directly AFTER the `## Calendar (read & write)` section)
- Modify: `README.md` (read it first; add one feature sentence in its existing voice where the calendar/reminders features are described)

- [ ] **Step 6.1: Insert into `CLAUDE.md`** (after the Calendar section's last line, before `## Long-term memory`):

```markdown
## Tasks (Apple Reminders)
Maor's to-do list is his real iPhone Reminders (synced over the same iCloud CalDAV as the
calendar). Run `bun run todo.ts ...` from your current directory. `<when>` values use the
same `date -d '<local time>' +%Y-%m-%dT%H:%M:%S%:z` idiom as the calendar (bare YYYY-MM-DD
= a date-only due).
- ROUTING — tasks vs Telegram reminders: a request WITH a specific time and "remind me"
  phrasing ("תזכיר לי מחר ב-9...") stays a Telegram reminder via remind.ts, exactly as before.
  Task/list phrasing ("תוסיף לרשימה", "משימה", "task", or no time at all) goes to Apple
  Reminders via todo.ts. If it's genuinely ambiguous, ask one short question.
- READ: `bun run todo.ts list` (open tasks, all lists; `--done` = completed only,
  `--all` = both, `--list "<name>"` = one list). `bun run todo.ts lists` shows list names.
- ADD: `bun run todo.ts add --title "..." [--due <when>] [--list "<name>"] [--notes "..."]`.
  Writes default to "תזכורות"; name another list to override. Run it immediately (no
  confirm) and echo exactly what you added, including due date and list.
- COMPLETE / SNOOZE / EDIT: locate the task (`bun run todo.ts find --q "<substr>"` prints
  `[uid]` lines), then `done`, `snooze --to <when>`, or `edit --set-title/--set-due/
  --clear-due/--set-notes` with `--uid` (or `--q` when unambiguous). Run immediately and
  echo what changed. If several tasks match you'll get the candidate list — ask Maor which.
- DELETE — confirm first (mandatory): never delete on the same message that asks. Reply
  with the exact task line and ask for a clear "yes"; only a LATER message confirming runs
  `bun run todo.ts delete --uid <uid>`. If the task line shows 🔁 it repeats — warn that
  deleting removes the whole series. After any write, tell Maor what changed.
- Recurring (🔁) tasks can be listed and deleted (with the warning) but NOT completed or
  edited from here — tell Maor to change those on his phone.
```

- [ ] **Step 6.2: README.md** — read it, find the features prose (the calendar/voice sentences), and add one sentence in the same voice, e.g.: "It also manages my real Apple Reminders from chat — add, complete, snooze, or edit tasks in natural language and they sync to the iPhone over the same iCloud CalDAV as the calendar."

- [ ] **Step 6.3: Full suite gate** — `SUITE_EXIT:0`.

- [ ] **Step 6.4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(tasks): teach the bot Apple Reminders tasks - routing, commands, delete confirm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Push + PR (left OPEN)

- [ ] **Step 7.1: Push and open the PR — DO NOT MERGE** (Maor reviews):

```bash
git push -u origin feat/tasks-reminders
gh pr create --title "feat: natural-language task list — Apple Reminders over iCloud CalDAV" --body "$(cat <<'EOF'
Closes the roadmap item "Natural-language task list" (smarter memory & data #3, feasibility confirmed 2026-06-08): the bot now manages Maor's REAL Apple Reminders — add / list / complete / snooze / edit / delete from chat, syncing to the iPhone over the same iCloud CalDAV as the calendar. No bot-local silo.

Per the approved spec (docs/superpowers/specs/2026-06-12-tasks-reminders-design.md):
- new tasks.ts: pure VTODO core (parseTodos / buildVTodo / mergeTask / fmtTask, unit-tested incl. Hebrew + escaping + date-only DUE + roundtrip) + thin tsdav wrappers
- explicit VTODO comp-filter on every fetch (tsdav's default filter is VEVENT-only — todos come back empty without it) and NO time-range (RFC 4791 time-range drops DUE-less todos)
- new todo.ts CLI mirroring cal.ts conventions; calendar.ts diff = four `export` keywords
- CLAUDE.md: routing (timed "remind me" stays a Telegram ping; task/list phrasing → Apple), delete-only confirm gate, recurring = read + warned-delete only
- poller untouched — iPhone notifies natively for due reminders

NOT deployed. Live arc on the droplet after merge+deploy (creds live only there):
`bun run todo.ts lists` → `add --title "בדיקה" --due <tomorrow 09:00>` (verify it appears on the iPhone in תזכורות) → `done` → `snooze` → `edit --set-title` → `delete` (confirm flow from chat) → finally one end-to-end chat test: "תוסיף משימה לקנות חלב" via Telegram.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; PR state OPEN.

---

## Self-review (run before execution)

1. **Spec coverage:** decisions 1-4 (full CRUD → Tasks 2-5; routing → Task 6; delete-only confirm → Tasks 5-6; default list + override → Tasks 4-5), no-timeRange + VTODO filter (Task 4), recurring stance (Tasks 4-5-6), rebuild trade-off (Task 4 updateTodo), date-only due (Tasks 2-3-5), target resolution open-vs-all (Task 5), error style (Task 5), testing section (Tasks 2-3 + smoke 5.2), delivery = one open PR (Task 7). ✓
2. **Placeholders:** none — every code step carries complete code. ✓
3. **Type consistency:** `FoundTask extends TaskItem` used by resolveTask/updateTodo; `TaskPatch.due: Date | null` matches mergeTask's null-clears handling and edit's `--clear-due`; `SelectMode` shared by selectTasks and the CLI; `listTodos` returns `FoundTask[]` so both `resolveOpen` and delete's pool typecheck; CLI imports match Task 2/3/4 export names. ✓
