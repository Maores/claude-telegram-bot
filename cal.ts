/**
 * cal.ts — CLI the bot calls to read and write the calendar.
 *   bun run cal.ts list <fromISO> <toISO>     (instants; offset or UTC, e.g. 2026-06-09T00:00:00+03:00)
 *   bun run cal.ts calendars                    (event-capable calendar names)
 *   bun run cal.ts add    --title "..." --start <when> [--end <when>] [--all-day]
 *                         [--cal "<name>"] [--loc "..."] [--desc "..."]
 *   bun run cal.ts find   --from <when> --to <when> [--q "<title substr>"]   (lists matches with [uid])
 *   bun run cal.ts edit   --from <when> --to <when> (--uid <uid> | --q "...")
 *                         [--set-title "..."] [--set-start <when>] [--set-end <when>]
 *                         [--set-loc "..."] [--set-desc "..."] [--set-all-day]
 *   bun run cal.ts delete --from <when> --to <when> (--uid <uid> | --q "<title substr>")
 *
 * <when> is a local+offset timestamp (date -d '...' +%Y-%m-%dT%H:%M:%S%:z) or a bare YYYY-MM-DD.
 * WRITES (add/edit/delete) must only run AFTER Maor has explicitly confirmed the change.
 */
import {
  listEvents,
  fmtEvent,
  createEvent,
  listCalendarNames,
  findEvents,
  updateEvent,
  deleteEvent,
  type EventPatch,
  type FoundEvent,
} from "./calendar.ts";

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

/** A date string is either a full instant (offset/UTC) or a bare YYYY-MM-DD (UTC midnight). */
function parseWhen(raw: string): Date {
  return new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
}

/** Resolve search flags to exactly one event, or throw with the candidate list. */
async function resolveOne(from: string, to: string, uid?: string, q?: string): Promise<FoundEvent> {
  const matches = await findEvents(from, to, q);
  const sel = uid ? matches.filter((e) => e.uid === uid) : matches;
  if (sel.length === 0) throw new Error("no matching event in that range");
  if (sel.length > 1) {
    const list = sel.map((e) => `  [${e.uid}] ${fmtEvent(e)}`).join("\n");
    throw new Error(`multiple events match — pick one with --uid:\n${list}`);
  }
  return sel[0];
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
        'usage: cal.ts add --title "..." --start <when> [--end ...] [--all-day] [--cal "..."] [--loc "..."] [--desc "..."]',
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
  } else if (cmd === "find") {
    const f = parseFlags(rest);
    const from = str(f.from);
    const to = str(f.to);
    if (!from || !to) throw new Error('usage: cal.ts find --from <when> --to <when> [--q "..."]');
    const matches = await findEvents(from, to, str(f.q));
    if (!matches.length) console.log("(no matching events)");
    else for (const e of matches) console.log(`[${e.uid}] ${fmtEvent(e)}`);
  } else if (cmd === "edit") {
    const f = parseFlags(rest);
    const from = str(f.from);
    const to = str(f.to);
    if (!from || !to || (!str(f.uid) && !str(f.q))) {
      throw new Error("usage: cal.ts edit --from <when> --to <when> (--uid <uid> | --q ...) --set-...");
    }
    const patch: EventPatch = {};
    if (str(f["set-title"]) !== undefined) patch.title = str(f["set-title"]);
    const ss = str(f["set-start"]);
    if (ss) patch.start = parseWhen(ss);
    const se = str(f["set-end"]);
    if (se) patch.end = parseWhen(se);
    if (str(f["set-loc"]) !== undefined) patch.location = str(f["set-loc"]);
    if (str(f["set-desc"]) !== undefined) patch.description = str(f["set-desc"]);
    if (f["set-all-day"] === true) patch.allDay = true;
    if (Object.keys(patch).length === 0) {
      throw new Error("edit: nothing to change (use --set-title / --set-start / --set-end / --set-loc / --set-desc)");
    }
    if ((patch.start && isNaN(patch.start.getTime())) || (patch.end && isNaN(patch.end.getTime()))) {
      throw new Error("invalid --set-start/--set-end date");
    }
    const target = await resolveOne(from, to, str(f.uid), str(f.q));
    await updateEvent(target, patch);
    console.log(`updated "${target.title}" (uid ${target.uid})`);
  } else if (cmd === "delete") {
    const f = parseFlags(rest);
    const from = str(f.from);
    const to = str(f.to);
    if (!from || !to || (!str(f.uid) && !str(f.q))) {
      throw new Error('usage: cal.ts delete --from <when> --to <when> (--uid <uid> | --q "<title substr>")');
    }
    const target = await resolveOne(from, to, str(f.uid), str(f.q));
    await deleteEvent(target);
    console.log(`deleted "${target.title}" (${fmtEvent(target)})`);
  } else {
    throw new Error("usage: cal.ts <list|calendars|add|find|edit|delete> ...");
  }
} catch (e: any) {
  console.error(`calendar error: ${e?.message ?? e}`);
  process.exit(1);
}
