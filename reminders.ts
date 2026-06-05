/**
 * reminders.ts — storage + scheduling logic for Telegram reminders.
 *
 * Pure-ish module shared by:
 *   - remind.ts  (CLI the bot calls to add/list/cancel)
 *   - poller.ts  (fires due reminders on an interval)
 *
 * Times are epoch seconds (absolute instants). Local-time math (for recurring
 * reminders) uses the process timezone — start.sh sets TZ=Asia/Jerusalem.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface Repeat {
  hour: number;
  minute: number;
  days: number[]; // weekday numbers, 0=Sun .. 6=Sat
}
export interface Reminder {
  id: string;
  chatId: number;
  fireAt: number; // epoch seconds of next fire
  text: string;
  repeat: Repeat | null; // null = one-time
}

/** Read the store path lazily so tests can override REMINDERS_FILE at runtime. */
function storePath(): string {
  return process.env.REMINDERS_FILE ?? join(import.meta.dir, "reminders.json");
}

export function loadStore(): Reminder[] {
  try {
    const data = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveStore(list: Reminder[]) {
  const path = storePath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, path); // atomic replace
}

function genId(list: Reminder[]): string {
  const ids = new Set(list.map((r) => r.id));
  let n = 1;
  while (ids.has("r" + n)) n++;
  return "r" + n;
}

/** Next epoch (strictly after nowEpoch) whose local weekday is in `days` at hour:minute. */
export function nextFire(nowEpoch: number, hour: number, minute: number, days: number[]): number {
  const now = new Date(nowEpoch * 1000);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hour, minute, 0, 0);
    const epoch = Math.floor(d.getTime() / 1000);
    if (epoch > nowEpoch && days.includes(d.getDay())) return epoch;
  }
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, hour, minute, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function addOnce(chatId: number, fireAt: number, text: string): Reminder {
  const list = loadStore();
  const r: Reminder = { id: genId(list), chatId, fireAt, text, repeat: null };
  list.push(r);
  saveStore(list);
  return r;
}

export function addRepeat(
  chatId: number,
  hour: number,
  minute: number,
  days: number[],
  text: string,
  nowEpoch = Math.floor(Date.now() / 1000),
): Reminder {
  const list = loadStore();
  const fireAt = nextFire(nowEpoch, hour, minute, days);
  const r: Reminder = { id: genId(list), chatId, fireAt, text, repeat: { hour, minute, days } };
  list.push(r);
  saveStore(list);
  return r;
}

export function listFor(chatId: number): Reminder[] {
  return loadStore()
    .filter((r) => r.chatId === chatId)
    .sort((a, b) => a.fireAt - b.fireAt);
}

export function cancel(chatId: number, id: string): boolean {
  const list = loadStore();
  const idx = list.findIndex((r) => r.chatId === chatId && r.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  saveStore(list);
  return true;
}

/** Return reminders due at/before now; remove one-time, reschedule recurring. */
export function popDue(nowEpoch = Math.floor(Date.now() / 1000)): Reminder[] {
  const list = loadStore();
  const due: Reminder[] = [];
  const keep: Reminder[] = [];
  for (const r of list) {
    if (r.fireAt <= nowEpoch) {
      due.push(r);
      if (r.repeat) {
        keep.push({ ...r, fireAt: nextFire(nowEpoch, r.repeat.hour, r.repeat.minute, r.repeat.days) });
      }
    } else {
      keep.push(r);
    }
  }
  if (due.length) saveStore(keep);
  return due;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Human-readable local time, e.g. "2026-06-06 09:00". */
export function fmt(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
