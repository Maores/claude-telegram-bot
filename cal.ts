/**
 * cal.ts — CLI the bot calls to read the calendar.
 *   bun run cal.ts list <fromISO> <toISO>     (ISO instants, UTC e.g. 2026-06-09T00:00:00Z)
 * (add/edit/delete come in a later phase.)
 */
import { listEvents, fmtEvent } from "./calendar.ts";

const [cmd, from, to] = process.argv.slice(2);

if (cmd !== "list" || !from || !to) {
  console.error("usage: cal.ts list <fromISO> <toISO>");
  process.exit(1);
}

try {
  const events = await listEvents(from, to);
  if (!events.length) console.log("(no events in that range)");
  else for (const e of events) console.log(fmtEvent(e));
} catch (e: any) {
  console.error(`calendar error: ${e?.message ?? e}`);
  process.exit(1);
}
