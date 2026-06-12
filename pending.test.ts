import { test, expect, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import {
  proposeAction,
  takePending,
  consumeAction,
  pruneActions,
  validateArgv,
  newTurnId,
  type PendingAction,
} from "./pending";

// Isolate the store per run.
const TEST_FILE = `${import.meta.dir}/pending.test-${process.pid}.json`;
process.env.PENDING_FILE = TEST_FILE;
beforeEach(() => {
  rmSync(TEST_FILE, { force: true });
  rmSync(TEST_FILE + ".lock", { force: true });
});

const CAL_ADD = ["bun", "run", "cal.ts", "add", "--title", "רופא שיניים", "--start", "2026-06-13T15:00:00+03:00"];
const TODO_DEL = ["bun", "run", "todo.ts", "delete", "--uid", "abc@maor-bot"];

test("validateArgv: allowlisted commands pass", () => {
  expect(validateArgv(CAL_ADD).ok).toBe(true);
  expect(validateArgv(["bun", "run", "cal.ts", "edit", "--uid", "x", "--set-title", "y"]).ok).toBe(true);
  expect(validateArgv(["bun", "run", "cal.ts", "delete", "--uid", "x"]).ok).toBe(true);
  expect(validateArgv(TODO_DEL).ok).toBe(true);
});

test("validateArgv: everything off the allowlist refuses", () => {
  expect(validateArgv(["bun", "run", "todo.ts", "add", "--title", "x"]).ok).toBe(false); // sub not allowed
  expect(validateArgv(["bun", "run", "remind.ts", "add-once", "1", "2", "x"]).ok).toBe(false); // script not allowed
  expect(validateArgv(["bun", "run", "../cal.ts", "add"]).ok).toBe(false); // path trick
  expect(validateArgv(["bun", "run", "cal.ts/../guard.ts", "add"]).ok).toBe(false);
  expect(validateArgv(["node", "run", "cal.ts", "add"]).ok).toBe(false); // wrong argv0
  expect(validateArgv(["bun", "x", "cal.ts", "add"]).ok).toBe(false); // wrong argv1
  expect(validateArgv(["bun", "run", "cal.ts"]).ok).toBe(false); // too short
  expect(validateArgv("bun run cal.ts add" as any).ok).toBe(false); // not an array
  expect(validateArgv(["bun", "run", "cal.ts", "add", ""]).ok).toBe(false); // empty element
  expect(validateArgv(["bun", "run", "cal.ts", "add", "x\0y"]).ok).toBe(false); // NUL
});

test("validateArgv: guard blocklist scans the joined argv", () => {
  // rm -rf / style content inside an argument still trips the hardline floor
  const v = validateArgv(["bun", "run", "cal.ts", "add", "--title", "x; rm -rf --no-preserve-root /"]);
  expect(v.ok).toBe(false);
});

test("propose → takePending picks up exactly the turn's pending entries", () => {
  const turn = newTurnId();
  const a = proposeAction(5, "להוסיף: רופא שיניים — מחר 15:00", CAL_ADD, turn, 1000);
  proposeAction(5, "other turn", TODO_DEL, newTurnId(), 1000); // different turn
  proposeAction(6, "other chat", TODO_DEL, turn, 1000); // different chat
  const picked = takePending(5, turn);
  expect(picked.map((p) => p.id)).toEqual([a.id]);
  expect(picked[0].status).toBe("pending");
  expect(picked[0].argv).toEqual(CAL_ADD);
});

test("proposeAction refuses an argv that fails validation", () => {
  expect(() => proposeAction(5, "evil", ["bash", "-c", "true"], newTurnId(), 1000)).toThrow();
});

test("consumeAction: once-only approve, then stale", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  const first = consumeAction(a.id, "approved", 2000);
  expect(first.outcome).toBe("ok");
  if (first.outcome === "ok") expect(first.action.status).toBe("approved");
  expect(consumeAction(a.id, "approved", 2001).outcome).toBe("stale");
  expect(consumeAction(a.id, "cancelled", 2002).outcome).toBe("stale");
  expect(consumeAction("pa-no-such", "approved", 2003).outcome).toBe("stale");
});

test("consumeAction: cancel works and is once-only too", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  expect(consumeAction(a.id, "cancelled", 1500).outcome).toBe("ok");
  expect(consumeAction(a.id, "approved", 1501).outcome).toBe("stale");
});

test("consumeAction: 24h expiry boundary", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  const justInside = consumeAction(a.id, "approved", 1000 + 24 * 3600);
  expect(justInside.outcome).toBe("ok"); // exactly 24h is still valid
  const b = proposeAction(5, "s2", CAL_ADD, newTurnId(), 1000);
  const past = consumeAction(b.id, "approved", 1000 + 24 * 3600 + 1);
  expect(past.outcome).toBe("expired");
  // expired is terminal: a later tap is stale, not expired again
  expect(consumeAction(b.id, "approved", 1000 + 24 * 3600 + 2).outcome).toBe("stale");
});

test("pruneActions: drops old resolved entries, expires old pendings, keeps fresh ones", () => {
  const keep = proposeAction(5, "fresh pending", CAL_ADD, newTurnId(), 1000);
  const old = proposeAction(5, "old pending", CAL_ADD, newTurnId(), 1000);
  const done = proposeAction(5, "old resolved", CAL_ADD, newTurnId(), 1000);
  consumeAction(done.id, "approved", 1001);
  // 8 days later: old pending becomes expired (kept), old resolved dropped, fresh... also old.
  // Use a now where `keep` is still inside expiry: re-propose it late instead.
  const nowS = 1000 + 8 * 24 * 3600;
  const fresh = proposeAction(5, "really fresh", CAL_ADD, newTurnId(), nowS - 10);
  pruneActions(nowS);
  const left = takePending(5, fresh.turnId);
  expect(left.map((p) => p.id)).toEqual([fresh.id]); // only the fresh one is still pending
  expect(consumeAction(old.id, "approved", nowS).outcome).toBe("stale"); // was expired by prune
  expect(consumeAction(keep.id, "approved", nowS).outcome).toBe("stale"); // ditto (also >24h old)
  expect(consumeAction(done.id, "approved", nowS).outcome).toBe("stale"); // dropped entirely
});

test("newTurnId returns unique-ish ids", () => {
  expect(newTurnId()).not.toBe(newTurnId());
});
