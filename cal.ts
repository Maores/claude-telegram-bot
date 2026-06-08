/**
 * cal.ts — CLI the bot calls to read and write the calendar.
 *   bun run cal.ts list <fromISO> <toISO>     (ISO instants, UTC e.g. 2026-06-09T00:00:00Z)
 *   bun run cal.ts add --title "..." --start <ISO|YYYY-MM-DD> [--end <ISO|YYYY-MM-DD>]
 *                      [--all-day] [--cal "<name>"] [--loc "..."] [--desc "..."]
 *   bun run cal.ts calendars                    (list event-capable calendar names)
 *
 * Writes (add) must only be run AFTER the user has explicitly confirmed the change.
 * (edit/delete come next.)
 */
import { listEvents, fmtEvent, createEvent, listCalendarNames } from "./calendar.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

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

/** A date string is either a full ISO instant or a bare YYYY-MM-DD (treated as UTC midnight). */
function parseWhen(raw: string): Date {
  return new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "list") {
    const [from, to] = rest;
    if (!from || !to) throw new Error("usage: cal.ts list <fromISO> <toISO>");
    const events = await listEvents(from, to);
    if (!events.length) console.log("(no events in that range)");
    else for (const e of events) console.log(fmtEvent(e));
  } else if (cmd === "calendars") {
    const names = await listCalendarNames();
    console.log(names.length ? names.join("\n") : "(no event-capable calendars)");
  } else if (cmd === "add") {
    const f = parseFlags(rest);
    const title = str(f.title);
    const startRaw = str(f.start);
    if (!title || !startRaw) {
      throw new Error(
        'usage: cal.ts add --title "..." --start <ISO|YYYY-MM-DD> [--end ...] [--all-day] [--cal "..."] [--loc "..."] [--desc "..."]',
      );
    }
    const allDay = f["all-day"] === true;
    const start = parseWhen(startRaw);
    const endRaw = str(f.end);
    const end = endRaw ? parseWhen(endRaw) : new Date(start.getTime() + (allDay ? DAY : HOUR));
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error("invalid --start/--end date");
    const res = await createEvent(
      { title, start, end, allDay, location: str(f.loc), description: str(f.desc) },
      str(f.cal),
    );
    console.log(`created "${title}" in calendar "${res.calendar}" (uid ${res.uid})`);
  } else {
    throw new Error("usage: cal.ts <list|add|calendars> ...");
  }
} catch (e: any) {
  console.error(`calendar error: ${e?.message ?? e}`);
  process.exit(1);
}
