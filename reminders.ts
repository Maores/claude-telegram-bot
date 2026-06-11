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

// ---------------------------------------------------------------------------
// Reminder follow-ups (Phase 5): "did you actually do it?" lifecycle.
// Stored in a sibling followups.json (the reminders store is a bare array on
// live disk; reshaping it buys nothing). Same atomic-write pattern.
// ---------------------------------------------------------------------------

export type FollowupStatus = "pending" | "done" | "snoozed";
export interface Followup {
  id: string;
  chatId: number;
  text: string; // the reminder text the buttons refer to
  messageId: number; // the message currently carrying the buttons
  firedAt: number; // epoch seconds the reminder fired
  status: FollowupStatus;
  nudged: boolean; // one nudge max, ever
}

const NUDGE_AFTER_S = 3600;
const PRUNE_AFTER_S = 7 * 86_400;

function followupsPath(): string {
  return process.env.FOLLOWUPS_FILE ?? join(import.meta.dir, "followups.json");
}

export function loadFollowups(): Followup[] {
  try {
    const data = JSON.parse(readFileSync(followupsPath(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveFollowups(list: Followup[]) {
  const path = followupsPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, path);
}

export function addFollowup(chatId: number, text: string, messageId: number, firedAt: number): Followup {
  const list = loadFollowups();
  const ids = new Set(list.map((f) => f.id));
  let n = 1;
  while (ids.has("f" + n)) n++;
  const f: Followup = { id: "f" + n, chatId, text, messageId, firedAt, status: "pending", nudged: false };
  list.push(f);
  saveFollowups(list);
  return f;
}

export function getFollowup(id: string): Followup | null {
  return loadFollowups().find((f) => f.id === id) ?? null;
}

/** pending → done/snoozed exactly once; returns null if missing or resolved. */
export function resolveFollowup(id: string, status: "done" | "snoozed"): Followup | null {
  const list = loadFollowups();
  const f = list.find((x) => x.id === id);
  if (!f || f.status !== "pending") return null;
  f.status = status;
  saveFollowups(list);
  return f;
}

/** Point the follow-up at a new message (the nudge takes over the buttons). */
export function rebindFollowup(id: string, newMessageId: number) {
  const list = loadFollowups();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  f.messageId = newMessageId;
  saveFollowups(list);
}

export function markNudged(id: string) {
  const list = loadFollowups();
  const f = list.find((x) => x.id === id);
  if (!f) return;
  f.nudged = true;
  saveFollowups(list);
}

/** Pending, never-nudged follow-ups whose reminder fired >= age ago. */
export function dueNudges(nowEpoch: number, ageSec = NUDGE_AFTER_S): Followup[] {
  return loadFollowups().filter(
    (f) => f.status === "pending" && !f.nudged && f.firedAt + ageSec <= nowEpoch,
  );
}

/** Drop RESOLVED follow-ups older than 7 days. Returns how many were removed. */
export function pruneFollowups(nowEpoch: number): number {
  const list = loadFollowups();
  const keep = list.filter((f) => f.status === "pending" || f.firedAt > nowEpoch - PRUNE_AFTER_S);
  if (keep.length !== list.length) saveFollowups(keep);
  return list.length - keep.length;
}
