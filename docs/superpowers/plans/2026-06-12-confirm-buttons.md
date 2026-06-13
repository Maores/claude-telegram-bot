# Confirm Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot-initiated calendar writes and task deletes become tap-to-approve: the claude child registers the exact frozen command, Maor taps [✓ אשר]/[✗ בטל], and approval executes the stored argv instantly — no claude spawn on tap.

**Architecture:** New `pending.ts` (file-backed pending-actions store + the validateArgv security gate) and `confirm.ts` (CLI the bot's claude child calls: propose / approve / cancel / list). `poller.ts` gains a `pa:` callback namespace beside `fu:`, a post-turn pickup that sends one button message per registered proposal (interactive turns AND [AUTO] runs), and tap-execution via direct `Bun.spawn(argv)` — never a shell. `guard.ts` denies `confirm.ts approve` to [AUTO] sessions. CLAUDE.md rewires the calendar/task-delete confirm flows through `confirm.ts`.

**Tech Stack:** Bun + TypeScript, `bun:test`, zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-confirm-buttons-design.md` (approved; Maor's four decisions recorded there).

**Conventions:** suite gate = `bun test 2>&1 | tail -3; echo "SUITE_EXIT:${PIPESTATUS[0]}"` — judge ONLY by `SUITE_EXIT:0` (run via the Bash tool). Commits: conventional style + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer (use a bash heredoc). Branch: `feat/confirm-buttons` (ALREADY created and checked out; the spec commit is on it). Suite baseline before Task 1: 424 passing. Do NOT push.

**Verified facts (do not re-derive):**
- `withFileLock(path, fn, opts?)` is exported from `reminders.ts` (O_EXCL lock, 1.5s timeout, stale-steal) — reuse it for `pending.json`.
- `checkCommand(cmd): GuardVerdict` is exported from `guard.ts`; `checkAutoSession` already blocks `remind.ts add*` for [AUTO] via a command regex — the new denial mirrors it.
- `poller.ts` exports `parseFuCallback`/`fuKeyboard` near line 266; `handleCallback` (~line 1004) currently parses only `fu:`; `streamClaude` (~line 670) merges `opts.env` into the child env; the interactive success path logs `[DONE] replied to ...` (~line 985); the [AUTO] branch of `checkReminders` (~line 1118-1130) calls `streamClaude(fullPrompt, r.chatId, ph.message_id, "sonnet", autoSessionSpawn())`; the nudge/prune block follows it.
- `PROJECT_DIR` is a poller const; `redact()` is imported there already.

---

### Task 1: `pending.ts` — store + `validateArgv` security gate (TDD)

**Files:**
- Create: `pending.ts`
- Create: `pending.test.ts`

- [ ] **Step 1.1: Write the failing tests** — create `pending.test.ts`:

```ts
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
```

- [ ] **Step 1.2: Run** `bun test pending.test.ts` — expect FAIL: `Cannot find module './pending'`.

- [ ] **Step 1.3: Create `pending.ts`:**

```ts
/**
 * pending.ts — the pending-actions store behind the confirm buttons.
 *
 * The bot's claude child REGISTERS a write here (frozen argv + human summary)
 * instead of executing it; the poller sends ✓/✗ buttons and, on approval,
 * executes exactly the stored argv. Security gate: validateArgv (hard
 * allowlist + guard blocklist), no shell anywhere, once-only consumption,
 * 24h expiry. Spec: docs/superpowers/specs/2026-06-12-confirm-buttons-design.md
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./reminders.ts";
import { checkCommand } from "./guard.ts";

export interface PendingAction {
  id: string;
  chatId: number;
  summary: string;
  argv: string[];
  createdAt: number; // epoch seconds
  status: "pending" | "approved" | "cancelled" | "expired";
  turnId: string;
}

export type ConsumeResult =
  | { outcome: "ok"; action: PendingAction }
  | { outcome: "stale" }
  | { outcome: "expired" };

const EXPIRY_S = 24 * 3600; // tappable for 24h (Maor's call, 2026-06-12)
const PRUNE_AFTER_S = 7 * 24 * 3600; // resolved entries linger a week for debugging

function pendingPath(): string {
  return process.env.PENDING_FILE ?? join(import.meta.dir, "pending.json");
}

function loadActions(): PendingAction[] {
  try {
    const data = JSON.parse(readFileSync(pendingPath(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveActions(list: PendingAction[]) {
  const path = pendingPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, path);
}

/** Only these exact (script, subcommand) pairs may ever execute. Email drafts
 *  are deliberately absent — they need a claude session, not a CLI. */
const ALLOWED: Array<{ script: string; subs: string[] }> = [
  { script: "cal.ts", subs: ["add", "edit", "delete"] },
  { script: "todo.ts", subs: ["delete"] },
];

/** The execution gate. Checked at propose time AND again at execution time.
 *  Pure — no I/O. */
export function validateArgv(argv: unknown): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(argv) || argv.length < 4) {
    return { ok: false, reason: "argv must be an array of at least 4 strings" };
  }
  if (!argv.every((a) => typeof a === "string" && a.length > 0 && !a.includes("\0"))) {
    return { ok: false, reason: "argv elements must be non-empty strings" };
  }
  const [a0, a1, a2, a3] = argv as string[];
  if (a0 !== "bun" || a1 !== "run") return { ok: false, reason: "argv must start with: bun run" };
  const rule = ALLOWED.find((r) => r.script === a2);
  if (!rule) return { ok: false, reason: `script not allowlisted: ${a2}` };
  if (!rule.subs.includes(a3)) return { ok: false, reason: `subcommand not allowed: ${a2} ${a3}` };
  const guard = checkCommand((argv as string[]).join(" "));
  if (guard.verdict === "block") return { ok: false, reason: guard.reason ?? "blocked by guard" };
  return { ok: true };
}

/** Turn ids tie proposals to the claude run that made them. */
export function newTurnId(): string {
  return `t${Date.now()}${Math.floor(Math.random() * 10_000)}`;
}

/** Register a proposal. Throws if the argv fails the gate — the bot should
 *  rephrase, not store a dud. */
export function proposeAction(
  chatId: number,
  summary: string,
  argv: string[],
  turnId: string,
  nowS: number,
): PendingAction {
  const v = validateArgv(argv);
  if (!v.ok) throw new Error(`refused to register: ${v.reason}`);
  return withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a: PendingAction = {
      id: `pa${Date.now()}${Math.floor(Math.random() * 1000)}`,
      chatId,
      summary,
      argv,
      createdAt: nowS,
      status: "pending",
      turnId,
    };
    list.push(a);
    saveActions(list);
    return a;
  });
}

/** Pending proposals registered during one specific turn (the poller's
 *  post-turn pickup). Read-only. */
export function takePending(chatId: number, turnId: string): PendingAction[] {
  return loadActions().filter(
    (a) => a.status === "pending" && a.chatId === chatId && a.turnId === turnId,
  );
}

/** pending → approved/cancelled exactly once; expired when 24h passed.
 *  Anything else (missing / already resolved / already expired) is stale. */
export function consumeAction(id: string, to: "approved" | "cancelled", nowS: number): ConsumeResult {
  return withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a = list.find((x) => x.id === id);
    if (!a || a.status !== "pending") return { outcome: "stale" } as const;
    if (nowS - a.createdAt > EXPIRY_S) {
      a.status = "expired";
      saveActions(list);
      return { outcome: "expired" } as const;
    }
    a.status = to;
    saveActions(list);
    return { outcome: "ok", action: a } as const;
  });
}

/** Housekeeping: expire overdue pendings, drop resolved/expired entries older
 *  than a week. Piggybacks the reminder tick. */
export function pruneActions(nowS: number) {
  withFileLock(pendingPath(), () => {
    const list = loadActions();
    for (const a of list) {
      if (a.status === "pending" && nowS - a.createdAt > EXPIRY_S) a.status = "expired";
    }
    const keep = list.filter(
      (a) => a.status === "pending" || nowS - a.createdAt <= PRUNE_AFTER_S,
    );
    saveActions(keep);
  });
}

/** Open proposals for a chat (CLI `list` + debugging). */
export function listPending(chatId: number): PendingAction[] {
  return loadActions().filter((a) => a.status === "pending" && a.chatId === chatId);
}
```

- [ ] **Step 1.4: Run** `bun test pending.test.ts` — all pass.

- [ ] **Step 1.5: Add `pending.json` to `.gitignore`** (read it first; add a line next to the other runtime stores, e.g. after `followups.json` if listed, otherwise in the runtime-state group):

```
pending.json
```

- [ ] **Step 1.6: Full suite gate** — `SUITE_EXIT:0`.

- [ ] **Step 1.7: Commit**

```bash
git add pending.ts pending.test.ts .gitignore
git commit -m "$(cat <<'EOF'
feat(confirm): pending-actions store + validateArgv security gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: guard — [AUTO] sessions may not approve (TDD)

**Files:**
- Modify: `guard.ts` (inside `checkAutoSession`, after the remind.ts rule ~line 150)
- Modify: `guard.test.ts` (append; read the file first to match its test style)

- [ ] **Step 2.1: Append the failing test** to `guard.test.ts` (adapt assertion helpers to the file's existing style after reading it — the behavior to pin):

```ts
test("[AUTO] sessions may not approve pending actions, but may propose/cancel/list", () => {
  expect(checkAutoSession("Bash", "bun run confirm.ts approve pa123").verdict).toBe("block");
  expect(checkAutoSession("Bash", "cd /x && bun run confirm.ts  approve pa123").verdict).toBe("block");
  expect(checkAutoSession("Bash", "bun run confirm.ts propose --summary x --argv-json '[]'").verdict).toBe("allow");
  expect(checkAutoSession("Bash", "bun run confirm.ts cancel pa123").verdict).toBe("allow");
  expect(checkAutoSession("Bash", "bun run confirm.ts list").verdict).toBe("allow");
});
```

- [ ] **Step 2.2: Run** `bun test guard.test.ts` — expect the new test FAILS (approve currently allowed).

- [ ] **Step 2.3: Implement** — in `checkAutoSession`, directly after the remind.ts block:

```ts
  if (toolName === "Bash" && command && /\bconfirm\.ts\s+approve\b/i.test(command)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions may not approve pending actions" };
  }
```

- [ ] **Step 2.4:** `bun test guard.test.ts` green; full suite gate `SUITE_EXIT:0`; commit:

```bash
git add guard.ts guard.test.ts
git commit -m "$(cat <<'EOF'
feat(guard): [AUTO] sessions may not approve pending actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `confirm.ts` — the CLI the bot calls

**Files:**
- Create: `confirm.ts`

cal.ts/todo.ts CLI conventions (errors to stderr as `confirm error: ...`, exit 1). No unit tests for the CLI (house style); Step 3.2 smoke-checks it.

- [ ] **Step 3.1: Create `confirm.ts`:**

```ts
/**
 * confirm.ts — register and resolve tap-to-approve write proposals.
 *   bun run confirm.ts propose --summary "<one short line>" --argv-json '["bun","run","cal.ts","add",...]'
 *   bun run confirm.ts approve <id>     (the typed-"כן" fallback — executes the stored command)
 *   bun run confirm.ts cancel  <id>
 *   bun run confirm.ts list
 *
 * Chat id comes from $TELEGRAM_CHAT_ID, turn id from $TELEGRAM_TURN_ID (both
 * injected by the poller). After `propose`, the poller sends Maor ✓/✗ buttons
 * automatically — NEVER run the proposed command directly.
 */
import {
  proposeAction,
  consumeAction,
  listPending,
  validateArgv,
  newTurnId,
} from "./pending.ts";

function envChat(): number {
  const n = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isFinite(n) || n === 0) throw new Error("TELEGRAM_CHAT_ID is not set");
  return n;
}

/** Parse `--key value` pairs out of argv (copied from cal.ts conventions). */
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

/** Run a stored argv directly (no shell), capture combined output. */
async function execArgv(argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { code, out: (code === 0 ? out : err || out).trim() };
}

const nowS = () => Math.floor(Date.now() / 1000);
const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "propose") {
    const f = parseFlags(rest);
    const summary = str(f.summary);
    const argvJson = str(f["argv-json"]);
    if (!summary || !argvJson) {
      throw new Error('usage: confirm.ts propose --summary "..." --argv-json \'["bun","run","cal.ts",...]\'');
    }
    let argv: unknown;
    try {
      argv = JSON.parse(argvJson);
    } catch {
      throw new Error("--argv-json is not valid JSON");
    }
    const v = validateArgv(argv);
    if (!v.ok) throw new Error(`that command can't be registered — ${v.reason}`);
    const turnId = process.env.TELEGRAM_TURN_ID ?? newTurnId();
    const a = proposeAction(envChat(), summary, argv as string[], turnId, nowS());
    console.log(
      `registered proposal ${a.id} — Maor will get ✓/✗ buttons after your reply. ` +
        `Do NOT run the command yourself; if he approves in text, run: bun run confirm.ts approve ${a.id}`,
    );
  } else if (cmd === "approve") {
    const id = rest[0];
    if (!id) throw new Error("usage: confirm.ts approve <id>");
    const r = consumeAction(id, "approved", nowS());
    if (r.outcome === "stale") throw new Error("that proposal was already handled (or never existed)");
    if (r.outcome === "expired") throw new Error("that proposal expired (24h) — propose it again");
    const v = validateArgv(r.action.argv);
    if (!v.ok) throw new Error(`stored command failed the gate — ${v.reason}`);
    const res = await execArgv(r.action.argv);
    if (res.code !== 0) throw new Error(`the approved command failed: ${res.out.split("\n")[0]}`);
    console.log(`approved ${id} — ${res.out.split("\n")[0]}`);
  } else if (cmd === "cancel") {
    const id = rest[0];
    if (!id) throw new Error("usage: confirm.ts cancel <id>");
    const r = consumeAction(id, "cancelled", nowS());
    if (r.outcome === "stale") throw new Error("that proposal was already handled (or never existed)");
    if (r.outcome === "expired") console.log(`cancelled ${id} (it had already expired)`);
    else console.log(`cancelled ${id}`);
  } else if (cmd === "list") {
    const open = listPending(envChat());
    if (!open.length) console.log("(no open proposals)");
    else for (const a of open) console.log(`[${a.id}] ${a.summary}`);
  } else {
    throw new Error("usage: confirm.ts <propose|approve|cancel|list> ...");
  }
} catch (e: any) {
  console.error(`confirm error: ${e?.message ?? e}`);
  process.exit(1);
}
```

- [ ] **Step 3.2: Smoke-check (Bash tool, no env set in this shell):**

```bash
bun run confirm.ts 2>&1; echo "EXIT:$?"
bun run confirm.ts list 2>&1; echo "EXIT:$?"
TELEGRAM_CHAT_ID=5 PENDING_FILE=/tmp/pa-smoke.json bun run confirm.ts propose --summary "בדיקה" --argv-json '["bun","run","cal.ts","add","--title","x","--start","2026-06-13"]' 2>&1; echo "EXIT:$?"
TELEGRAM_CHAT_ID=5 PENDING_FILE=/tmp/pa-smoke.json bun run confirm.ts list 2>&1; echo "EXIT:$?"
TELEGRAM_CHAT_ID=5 PENDING_FILE=/tmp/pa-smoke.json bun run confirm.ts propose --summary "evil" --argv-json '["bash","-c","true"]' 2>&1; echo "EXIT:$?"
rm -f /tmp/pa-smoke.json /tmp/pa-smoke.json.lock
```

Expected: (1) usage error EXIT:1; (2) `confirm error: TELEGRAM_CHAT_ID is not set` EXIT:1; (3) `registered proposal pa...` EXIT:0; (4) one `[pa...] בדיקה` line EXIT:0; (5) `confirm error: that command can't be registered — script not allowlisted: -c`... (reason text mentions the gate) EXIT:1.

- [ ] **Step 3.3: Full suite gate** — `SUITE_EXIT:0`. Commit:

```bash
git add confirm.ts
git commit -m "$(cat <<'EOF'
feat(confirm): confirm.ts CLI - propose/approve/cancel/list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: poller — `pa:` namespace, post-turn pickup, tap execution (TDD for the pure parts)

**Files:**
- Modify: `poller.ts`
- Modify: `poller.test.ts` (append)

- [ ] **Step 4.1: Append the failing tests** to `poller.test.ts` (extend its import from `./poller` with `parsePaCallback, paKeyboard`):

```ts
test("parsePaCallback accepts ok/no and rejects junk", () => {
  expect(parsePaCallback("pa:ok:pa17812345671")).toEqual({ action: "ok", id: "pa17812345671" });
  expect(parsePaCallback("pa:no:pa17812345671")).toEqual({ action: "no", id: "pa17812345671" });
  expect(parsePaCallback("pa:maybe:x")).toBeNull();
  expect(parsePaCallback("fu:done:x")).toBeNull();
  expect(parsePaCallback("")).toBeNull();
});

test("paKeyboard carries the proposal id in both buttons", () => {
  const kb: any = paKeyboard("pa123");
  const flat = kb.inline_keyboard.flat();
  expect(flat.map((b: any) => b.callback_data)).toEqual(["pa:ok:pa123", "pa:no:pa123"]);
  expect(flat.map((b: any) => b.text)).toEqual(["✓ אשר", "✗ בטל"]);
});
```

- [ ] **Step 4.2: Run** `bun test poller.test.ts` — the two new tests FAIL (missing exports).

- [ ] **Step 4.3: Implement in `poller.ts`** — six edits:

(a) Extend the pending import block (top of file, next to the reminders import):

```ts
import { takePending, consumeAction, validateArgv, pruneActions, newTurnId, type PendingAction } from "./pending.ts";
```

(b) Right after `snoozeKeyboard` (~line 296), add the `pa:` namespace:

```ts
// ---------------------------------------------------------------------------
// Inline-button callbacks: pending-action approvals (confirm buttons)
// callback_data protocol: "pa:<ok|no>:<actionId>"
// ---------------------------------------------------------------------------

export interface PaCallback {
  action: "ok" | "no";
  id: string;
}

export function parsePaCallback(data: string): PaCallback | null {
  const m = /^pa:(ok|no):([\w-]+)$/.exec(data ?? "");
  return m ? { action: m[1] as PaCallback["action"], id: m[2] } : null;
}

export function paKeyboard(id: string): unknown {
  return {
    inline_keyboard: [[
      { text: "✓ אשר", callback_data: `pa:ok:${id}` },
      { text: "✗ בטל", callback_data: `pa:no:${id}` },
    ]],
  };
}
```

(c) After `handleCallback`'s closing brace, add the pickup sender + the pa handler:

```ts
/** Send one ✓/✗ message per proposal the just-finished turn registered. */
async function sendPendingProposals(chatId: number, turnId: string) {
  let actions: PendingAction[] = [];
  try {
    actions = takePending(chatId, turnId);
  } catch (e: any) {
    console.error(`[ERR] pending pickup: ${e?.message ?? e}`);
    return;
  }
  for (const a of actions) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `🔘 ${a.summary}`,
      reply_markup: paKeyboard(a.id),
    }).catch(() => {});
    console.log(redact(`[PA] proposed ${a.id}: ${a.summary}`));
  }
}

/** ✓/✗ tap on a proposal: consume once-only, validate, execute the frozen
 *  argv directly (no shell), and turn the proposal message into the receipt. */
async function handlePaCallback(
  cq: NonNullable<TgUpdate["callback_query"]>,
  parsed: PaCallback,
  chatId: number,
  messageId: number,
  ack: (text?: string) => Promise<unknown>,
) {
  const r = consumeAction(parsed.id, parsed.action === "ok" ? "approved" : "cancelled", Math.floor(Date.now() / 1000));
  if (r.outcome === "stale") {
    console.log(`[PA] stale ${parsed.id}`);
    await ack("הכפתור הזה כבר טופל");
    return;
  }
  if (r.outcome === "expired") {
    console.log(`[PA] expired ${parsed.id}`);
    await ack("פג תוקף — בקש ממני שוב");
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: `⌛ פג תוקף — ${cq.message?.text ?? ""}`.trim() }).catch(() => {});
    return;
  }
  const a = r.action;
  if (parsed.action === "no") {
    await ack();
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: `✗ בוטל — ${a.summary}` }).catch(() => {});
    console.log(`[PA] cancelled ${a.id}`);
    return;
  }
  const v = validateArgv(a.argv);
  if (!v.ok) {
    // Should be unreachable (validated at propose) — refuse loudly, stay consumed.
    console.error(`[PA] blocked at execution ${a.id}: ${v.reason}`);
    await ack();
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: `⚠️ נחסם — ${a.summary}` }).catch(() => {});
    return;
  }
  await ack();
  const proc = Bun.spawn(a.argv, { cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  const firstLine = (code === 0 ? out : err || out).trim().split("\n")[0] ?? "";
  const text = code === 0 ? `✓ ${a.summary}\n${firstLine}` : `⚠️ נכשל — ${a.summary}\n${firstLine}`;
  await tg("editMessageText", { chat_id: chatId, message_id: messageId, text }).catch(() => {});
  console.log(redact(`[PA] ${code === 0 ? "executed" : "FAILED"} ${a.id}: ${firstLine}`));
}
```

(d) Rewire `handleCallback`'s routing. Its current body starts by parsing `fu:` and logging `[CB]`. Replace the opening lines (from `const parsed = parseFuCallback(...)` through the `if (!parsed || chatId == null || messageId == null)` block) with namespace routing that logs both kinds:

```ts
  const pa = parsePaCallback(cq.data ?? "");
  const parsed = pa ? null : parseFuCallback(cq.data ?? "");
  console.log(
    `[CB] ${pa ? `pa:${pa.action}:${pa.id}` : parsed ? `${parsed.action}:${parsed.id}` : `?:${(cq.data ?? "").slice(0, 24)}`} from ${cq.from.id}`,
  );
  const ack = (text?: string) =>
    tg("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!loadAllowList().has(String(cq.from.id))) {
    await ack();
    return;
  }
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (chatId == null || messageId == null || (!pa && !parsed)) {
    await ack(); // unknown namespace — ignore
    return;
  }
  if (pa) {
    await handlePaCallback(cq, pa, chatId, messageId, ack);
    return;
  }
```

(the existing `fu:` branches continue below unchanged, still using `parsed` and the local `ack`).

(e) Turn-id plumbing + pickup at BOTH claude call sites:

- In `handleMessage`: find the `streamClaude(...)` call (the interactive turn). Immediately before it, add `const turnId = newTurnId();` and merge the env into its SpawnOpts argument — if the call passes an opts object, spread it: `{ ...existingOpts, env: { ...(existingOpts.env ?? {}), TELEGRAM_TURN_ID: turnId } }`; if it passes none, add `{ env: { TELEGRAM_TURN_ID: turnId } }`. Then in the SUCCESS path, immediately BEFORE the `console.log(\`[DONE] replied to ${fromId}\`);` line, add:

```ts
    await sendPendingProposals(chatId, turnId);
```

- In `checkReminders`' [AUTO] branch: replace

```ts
        await streamClaude(fullPrompt, r.chatId, ph.message_id, "sonnet", autoSessionSpawn());
```

with

```ts
        const turnId = newTurnId();
        const auto = autoSessionSpawn();
        await streamClaude(fullPrompt, r.chatId, ph.message_id, "sonnet", {
          ...auto,
          env: { ...(auto.env ?? {}), TELEGRAM_TURN_ID: turnId },
        });
        await sendPendingProposals(r.chatId, turnId);
```

(f) Prune piggyback — in `checkReminders`, next to the existing followup prune call (find `pruneFollowups` near the nudge block), add:

```ts
  try {
    pruneActions(nowS);
  } catch (e: any) {
    console.error(`[ERR] pending prune: ${e?.message ?? e}`);
  }
```

- [ ] **Step 4.4: Run** `bun test poller.test.ts` — new tests pass; full suite gate — `SUITE_EXIT:0`.

- [ ] **Step 4.5: Commit**

```bash
git add poller.ts poller.test.ts
git commit -m "$(cat <<'EOF'
feat(poller): pa: confirm buttons - post-turn proposal pickup + tap execution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLAUDE.md + README

**Files:**
- Modify: `CLAUDE.md` (two sections)
- Modify: `README.md` (read first; one sentence in the features prose)

- [ ] **Step 5.1: Calendar section.** In `## Calendar (read & write)`, replace the entire `- CONFIRM BEFORE EVERY WRITE (mandatory): ...` bullet (it ends with "...tell him what changed.") with:

```markdown
- CONFIRM BEFORE EVERY WRITE (mandatory): never run `cal.ts add/edit/delete` yourself. Build the
  exact command and register it instead:
  `bun run confirm.ts propose --summary "<short Hebrew line: what + when>" --argv-json '["bun","run","cal.ts","add","--title","רופא שיניים","--start","2026-06-13T15:00:00+03:00"]'`
  Maor automatically gets ✓ אשר / ✗ בטל buttons right after your reply — the button does the
  running. In your reply, state the proposal (title, date + LOCAL time, duration, calendar) so the
  buttons have context. If a LATER message approves in TEXT ("כן" / "אשר"), run
  `bun run confirm.ts approve <id>` — never the raw command (one execution path; the buttons then
  show "כבר טופל"). "לא" / ביטול → `bun run confirm.ts cancel <id>`. Open proposals:
  `bun run confirm.ts list`. Proposals expire after 24h. After an approved write executes, the
  button message becomes the receipt.
```

- [ ] **Step 5.2: Tasks section.** In `## Tasks (Apple Reminders)`, replace the `- DELETE — confirm first (mandatory): ...` bullet (through "...tell Maor what changed.") with:

```markdown
- DELETE — confirm first (mandatory): never run `todo.ts delete` yourself. Locate the task
  (`bun run todo.ts find --q "<substr>"`), then register the deletion:
  `bun run confirm.ts propose --summary "<short line: למחוק את '<title>'>" --argv-json '["bun","run","todo.ts","delete","--uid","<uid>"]'`
  Maor gets ✓/✗ buttons automatically. If the task line shows 🔁 it repeats — say in the summary
  that deleting removes the whole series. A text "כן" in a later message →
  `bun run confirm.ts approve <id>` (never the raw command). After any write, tell Maor what changed.
```

- [ ] **Step 5.3: README.md** — read it; in the features prose (near the reminders/buttons sentences), add one sentence in its voice, e.g.: "Writes are tap-to-approve: the bot proposes the exact calendar change or task deletion and a ✓/✗ button press executes or cancels it — the approved command is frozen at proposal time."

- [ ] **Step 5.4: Full suite gate** — `SUITE_EXIT:0`. Commit:

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs(confirm): rewire calendar + task-delete confirmations through confirm.ts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Push + PR (left OPEN)

- [ ] **Step 6.1:**

```bash
git push -u origin feat/confirm-buttons
gh pr create --title "feat: confirm buttons — tap-to-approve calendar writes + task deletes" --body "$(cat <<'EOF'
Phase 5 finale: bot-initiated writes become tap-to-approve. The claude child registers the exact frozen argv (confirm.ts propose) instead of executing; the poller sends ✓ אשר / ✗ בטל buttons after the turn; approval executes the stored command instantly — no claude spawn on tap, no shell anywhere.

Per the approved spec (docs/superpowers/specs/2026-06-12-confirm-buttons-design.md):
- pending.ts: file-backed store (lockfile pattern) + validateArgv gate — hard allowlist (cal.ts add/edit/delete, todo.ts delete only), guard blocklist re-check, once-only consumption, 24h expiry
- confirm.ts CLI: propose / approve (typed-"כן" fallback, same gate) / cancel / list
- poller: pa: callback namespace beside fu:, post-turn pickup (interactive AND [AUTO] runs), tap execution with receipt edits, stale/expired toasts, [PA]/[CB] logging
- guard: [AUTO] sessions may propose but never approve
- threat model: prompt injection at worst yields a visible, allowlisted, frozen proposal that does nothing until Maor taps it

NOT deployed. Live arc after merge+deploy: ask the bot to add a calendar event → tap ✓ (event lands, receipt edits in) → propose again → tap ✗ (cancelled) → double-tap (כבר טופל toast) → typed-"כן" fallback → [AUTO]-proposed write next morning arrives as buttons.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; PR state OPEN. Do NOT merge.

---

## Self-review (run before execution)

1. **Spec coverage:** store+gate (Task 1), [AUTO] approve denial (Task 2), CLI incl. typed-fallback execution (Task 3), pa: namespace + pickup both call sites + tap execution + toasts + prune (Task 4), CLAUDE.md rewiring + README (Task 5), PR-left-open delivery (Task 6). Decisions 1-4 all encoded; expiry boundary pinned by test; [AUTO] pickup covered (4.3e). ✓
2. **Placeholders:** none — every code step carries complete code; the two "adapt to file style" notes (guard.test.ts helpers, README voice) are read-first instructions, not gaps. ✓
3. **Type consistency:** `ConsumeResult` discriminated union used by confirm.ts and handlePaCallback; `PendingAction.turnId` used by takePending/tests; `paKeyboard`/`parsePaCallback` shapes match the poller tests; `newTurnId` exported from pending.ts and used in poller + confirm.ts; `validateArgv` returns `{ok:true}|{ok:false,reason}` consistently. ✓
