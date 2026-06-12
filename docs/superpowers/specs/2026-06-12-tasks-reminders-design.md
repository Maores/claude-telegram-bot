# Natural-language task list → Apple Reminders — design spec

Date: 2026-06-12
Status: approved (all decisions confirmed with Maor in-session).

## Goal
Let the bot manage Maor's real to-do list from chat — add, list, complete, snooze, edit,
delete — by writing VTODOs to his Apple Reminders over the same iCloud CalDAV the calendar
uses, so tasks sync to the iPhone (no bot-local silo).

## Decisions (confirmed 2026-06-12)
1. Scope: full CRUD — add / list / complete / snooze / delete / edit (title + due + notes).
2. Routing vs Telegram reminders: by phrasing. A specific time + "remind me" phrasing →
   `remind.ts` Telegram ping, exactly as today. Task/list phrasing or no time → Apple task.
   The bot asks only when genuinely ambiguous.
3. Confirm gate: only `delete` requires a "yes" in a later message (calendar-style two-step).
   add/complete/snooze/edit run immediately and the bot echoes exactly what changed.
4. Lists: writes default to "תזכורות" with a named `--list` override; reads span all
   todo-capable lists, each task tagged with its list name.

## Approach
Mirror the calendar pair (`calendar.ts`/`cal.ts`) with a new, isolated pair: `tasks.ts`
(library) + `todo.ts` (CLI). The only calendar change is exporting four existing helpers
(the lazy tsdav client factory, RFC-5545 text escaping, the two date formatters) so
`tasks.ts` imports rather than copies them — a mechanical diff, zero behavior change.
A shared `caldav.ts` core was considered and rejected for now (refactors live code for
~40 shared lines); extending `calendar.ts` itself was rejected (two domains, one module).

## Auth / secrets
Nothing new: `ICLOUD_USER` / `ICLOUD_APP_PASSWORD` in the droplet `.env`, Basic auth to
`https://caldav.icloud.com`. Feasibility was live-confirmed 2026-06-08: "תזכורות" is
reachable as a VTODO collection on this account (this needed confirming because Apple's
post-iOS-13 "upgraded" Reminders are not always CalDAV-visible). Live verification can
only happen on the droplet — creds exist nowhere else.

## Components
- `tasks.ts` — VTODO library.
  - Pure (unit-tested): `parseTodos(ics, listName?)` via node-ical (VTODO parsing
    verified in its typings: `due`, `status`, `completed`, `completion`, `priority`,
    `rrule`); `buildVTodo(input)` emitting UID / DTSTAMP / SUMMARY / optional DUE
    (`VALUE=DATE` for date-only, UTC instant for timed) / DESCRIPTION (notes) / STATUS,
    plus COMPLETED + PERCENT-COMPLETE:100 when done; `mergeTask(base, patch, dtstamp)`.
  - Network (thin, live-verified): `listTodos(listName?)`, `findTodos(q?, listName?)`
    (keeps url/etag/raw for writes), `createTodo`, `updateTodo`, `completeTodo`,
    `deleteTodo`. Collections chosen by `components` includes VTODO.
  - Fetches send NO time-range filter: CalDAV time-range queries exclude todos without
    a due date (RFC 4791), and Reminders lists are small — fetch all, filter client-side.
- `todo.ts` — CLI the bot calls, `cal.ts` conventions (parseFlags, resolveOne, stderr
  errors, exit 1):
  - `list [--done | --all] [--list "<name>"]` — open tasks by default; `--done` shows
    only completed, `--all` shows both. Due-ascending, no-due last, 🔁 marks recurring,
    each line tagged `(list)`.
  - `add --title "..." [--due <when>] [--list "..."] [--notes "..."]`
  - `find [--q "..."] [--list "..."]` — prints `[uid]` lines for edit/done/delete.
  - `done (--uid <uid> | --q "...")`
  - `snooze (--uid | --q) --to <when>` — sugar for a due-date edit.
  - `edit (--uid | --q) [--set-title "..."] [--set-due <when> | --clear-due] [--set-notes "..."]`
  - `delete (--uid | --q)` — the bot only runs this after a chat confirm.
  - `lists` — todo-capable list names.
  - `<when>` rules are the calendar's: bare `YYYY-MM-DD` → date-only, else local+offset
    timestamp from `date -d ... +%Y-%m-%dT%H:%M:%S%:z`.
- `CLAUDE.md` — new "Tasks (Apple Reminders)" section: the routing rule, the commands,
  delete-confirm-only, echo-every-change, default list + override, recurring stance.
- `poller.ts` — untouched. No task nudges: the iPhone notifies natively for due
  reminders. (The future morning briefing can consume `listTodos`.)

## Behavior details
- Default list resolution: case-insensitive name match for "תזכורות"; if absent
  (renamed someday), fall back to the first todo-capable collection.
- `done` = STATUS:COMPLETED + COMPLETED:<now> + PERCENT-COMPLETE:100. Completed tasks
  stay on the server (Apple's model); hidden from `list` unless `--done`/`--all`.
  Un-complete is phone-only in v1.
- Recurring (RRULE present in raw): listed with 🔁; `done`/`edit` refused with a
  "change it on the phone" error (completing a recurring master over raw CalDAV risks
  the whole series); `delete` allowed — the chat confirm must warn it removes the series.
- Edits rebuild the VTODO from merged parsed fields (calendar's update approach):
  title/due/notes/status survive; Apple-private extras (sort order, flagged) are
  dropped on edited tasks. Accepted trade-off, same as calendar edits.
- Target resolution: `done` / `snooze` / `edit` resolve against open tasks only
  (re-completing or snoozing a finished task is meaningless); `delete` and `find`
  resolve across all tasks, so a stray completed task can still be removed.
- Errors: `task error: <message>` on stderr, exit 1; server rejections include status;
  a failing collection is logged + skipped, not fatal to the read; resolveOne throws
  "no match" or the multi-match `[uid]` candidate list.

## Testing
- Unit (bun:test, no network): parseTodos fixtures — open / completed / timed due /
  date-only due / recurring / Hebrew titles / escaped text; buildVTodo golden strings
  (CRLF line endings, escaping) + parse(build(x)) roundtrip; mergeTask; the recurring
  detector. Suite gate: `bun test` checked via `${PIPESTATUS[0]}` (repo convention).
- Live (droplet, post-merge + deploy): full arc on a throwaway task —
  `lists` → `add` (appears on iPhone) → `done` → `snooze` → `edit` → `delete`.

## Delivery
One PR on `feat/tasks-reminders`, implemented task-by-task from a written plan
(subagent-driven), PR left open for Maor's review. Deploy after merge, then the live arc.

## Out of scope (v1)
Creating new lists; moving tasks between lists; priorities / flags / subtasks;
un-complete from chat; proactive task nudges; creating or editing recurring tasks
(read + warned delete only); location-based reminders; attachments.
