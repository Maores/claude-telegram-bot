/**
 * remind.ts — CLI the bot calls (via Bash) to manage reminders.
 *
 *   bun run remind.ts add-once   <chatId> <epochSeconds> <text...>
 *   bun run remind.ts add-repeat <chatId> <HH:MM> <daysCSV> <text...>   (days: 0=Sun..6=Sat)
 *   bun run remind.ts list       <chatId>
 *   bun run remind.ts cancel     <chatId> <id>
 */

import { addOnce, addRepeat, listFor, cancel, fmt } from "./reminders.ts";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [cmd, chatIdRaw, ...rest] = process.argv.slice(2);
const chatId = Number(chatIdRaw);

if (!cmd) die("usage: remind.ts <add-once|add-repeat|list|cancel> <chatId> ...");
if (!Number.isFinite(chatId)) die(`invalid chatId: ${chatIdRaw}`);

const nowSec = Math.floor(Date.now() / 1000);

switch (cmd) {
  case "add-once": {
    const fireAt = Number(rest[0]);
    const text = rest.slice(1).join(" ").trim();
    if (!Number.isFinite(fireAt) || !text) die("usage: add-once <chatId> <epochSeconds> <text>");
    if (fireAt <= nowSec) die("that time is in the past");
    const r = addOnce(chatId, fireAt, text);
    console.log(`OK ${r.id} — one-time at ${fmt(r.fireAt)}: ${r.text}`);
    break;
  }
  case "add-repeat": {
    const m = /^(\d{1,2}):(\d{2})$/.exec(rest[0] ?? "");
    if (!m) die("usage: add-repeat <chatId> <HH:MM> <daysCSV> <text>");
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) die("invalid time");
    const days = (rest[1] ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const text = rest.slice(2).join(" ").trim();
    if (!days.length || !text) die("need days (CSV of 0-6) and text");
    const r = addRepeat(chatId, hour, minute, days, text);
    console.log(`OK ${r.id} — repeats ${rest[0]} on days [${days.join(",")}], next ${fmt(r.fireAt)}: ${r.text}`);
    break;
  }
  case "list": {
    const items = listFor(chatId);
    if (!items.length) {
      console.log("(no reminders)");
      break;
    }
    for (const r of items) {
      console.log(`${r.id}  ${fmt(r.fireAt)}${r.repeat ? "  (repeats)" : ""}  ${r.text}`);
    }
    break;
  }
  case "cancel": {
    const id = rest[0];
    if (!id) die("usage: cancel <chatId> <id>");
    console.log(cancel(chatId, id) ? `cancelled ${id}` : `no reminder with id ${id}`);
    break;
  }
  default:
    die(`unknown command: ${cmd}`);
}
