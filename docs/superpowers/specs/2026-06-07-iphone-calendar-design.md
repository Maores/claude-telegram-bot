# iPhone/iCloud calendar — design spec

Date: 2026-06-07
Status: approved; build it ourselves (tsdav), phased.

## Goal
Let the bot read the user's iCloud calendar, nudge before events, and add/edit/delete
events (with a confirm step before any write).

## Approach
Build on the `tsdav` CalDAV client (+ `node-ical` for parsing) rather than a third-party
MCP server — keeps the Apple app-specific password in our own code (it also reaches iCloud
mail/contacts), covers the background nudges (which an MCP can't), and is the stronger story.

## Auth / secrets
Apple ID + a 16-char app-specific password in the server `.env` (`ICLOUD_USER`,
`ICLOUD_APP_PASSWORD`), gitignored. Server: `https://caldav.icloud.com`, Basic auth.

## Components
- `calendar.ts` — CalDAV wrapper: lazy DAVClient from env; `listEvents(fromISO,toISO)`
  (fetch calendars → fetchCalendarObjects with timeRange+expand → parse `.data`);
  later `createEvent` / `updateEvent` / `deleteEvent` (build/modify iCalendar VEVENTs).
  Pure `parseEvents(ics)` for unit testing.
- `cal.ts` — CLI the bot calls (like remind.ts): `list` now; `add`/`edit`/`delete` later.
- Nudges (phase 2) — a poller interval reads upcoming events and pings ~15 min before each,
  deduping by uid+start in a small gitignored store.
- `CLAUDE.md` — teach the bot the `cal` commands; for writes, ALWAYS draft + get an explicit
  "yes" before running add/edit/delete (deletes especially).

## Behavior (confirmed with user)
All writes (add/edit/delete) require an explicit confirm in chat first.

## Phases (each tested + deployed before the next)
1. **Connection + read** — prove tsdav reads the real iCloud calendar (needs the app password).
2. **Proactive nudges.**
3. **Add / edit / delete** (confirm-first).

## Testing
- Unit: `parseEvents` (timed + all-day fixtures), iCalendar generation (phase 3), nudge dedupe (phase 2).
- Live: real iCloud read in phase 1 once the app-specific password is on the server.

## Out of scope (v1)
Attendees/invites, attachments, multiple-account calendars beyond the user's own, free/busy of others.
