# Redaction + Reminder Follow-ups + Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 4 (secret redaction), build Phase 5's core (callback buttons + reminder follow-ups with done/snooze/nudge), and pull Phase 7's background review loop forward — three PRs, one deploy.

**Architecture:** Three small modules following the house pattern (pure logic + thin poller wiring): `redact.ts` masks secrets at the `tg()` chokepoint; `reminders.ts` gains a sibling `followups.json` lifecycle store consumed by a new `callback_query` branch in the poller; `review.ts` builds a restricted-tool prompt and detached spawn that the poller fires on a 15-min cooldown after replies. Spec: `docs/superpowers/specs/2026-06-11-phase45-completion-design.md`.

**Tech Stack:** Bun + TypeScript, bun:test, Telegram Bot API (`setMessageReaction` patterns already in poller.ts), `claude -p` CLI.

**House rules for every task:** run the FULL suite (`bun test`) before each commit, conventional-commit messages, commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. One deviation from the spec, decided here: follow-ups live in a sibling `followups.json` (not inside `reminders.json`) — the live store is a bare array and reshaping it would touch every existing caller for zero benefit.

---

## PR 1 — `feat/redaction` (branch off current main)

### Task 0: Branch

- [ ] **Step 0.1:** `git checkout main && git pull --ff-only && git checkout -b feat/redaction`

### Task 1: `redact.ts` — the masking logic

**Files:**
- Create: `redact.ts`
- Test: `redact.test.ts`

- [ ] **Step 1.1: Write the failing tests**

```ts
// redact.test.ts
import { test, expect } from "bun:test";
import { redact, collectSecretValues } from "./redact.ts";

test("collectSecretValues picks env vars whose NAME looks secret, 8+ chars only", () => {
  const vals = collectSecretValues({
    TELEGRAM_BOT_TOKEN: "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn",
    ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop",
    SHORT_TOKEN: "abc",            // too short — ignored
    HOME: "/home/claudebot",       // name not secret-ish — ignored
    PATH: "/usr/bin",
  });
  expect(vals).toContain("123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn");
  expect(vals).toContain("abcd-efgh-ijkl-mnop");
  expect(vals).not.toContain("abc");
  expect(vals).not.toContain("/home/claudebot");
});

test("longest secret masks first (a secret containing another masks cleanly)", () => {
  const out = redact("x SECRETLONGvalue123 y", ["SECRETLONG", "SECRETLONGvalue123"]);
  expect(out).toBe("x [REDACTED] y");
});

test("exact env values are masked wherever they appear, multiline included", () => {
  const tok = "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn";
  const out = redact(`first line\ncurl https://api.telegram.org/bot${tok}/send`, [tok]);
  expect(out).not.toContain(tok);
  expect(out).toContain("[REDACTED]");
});

test("vendor patterns are masked with a 4-char identification tail", () => {
  const out = redact("key sk-abcdefghijklmnopqrstuvwxyz123456 here", []);
  expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  expect(out).toContain("[REDACTED…3456]");
});

test("github / slack / aws / bearer / telegram-shaped / private-key all masked", () => {
  const samples = [
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "xoxb-1234567890-ABCDEFGHIJKL",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ];
  for (const s of samples) {
    const out = redact(`x ${s} y`, []);
    expect(out).not.toContain(s);
    expect(out).toContain("[REDACTED");
  }
});

test("clean text and Hebrew pass through untouched", () => {
  const t = "תזכורת: לקנות חלב ב-12:30, עולה 6.90";
  expect(redact(t, [])).toBe(t);
});

test("empty/undefined-ish input is returned as-is", () => {
  expect(redact("", [])).toBe("");
});
```

- [ ] **Step 1.2:** Run `bun test redact.test.ts` — expect FAIL (module not found).

- [ ] **Step 1.3: Implement `redact.ts`**

```ts
/**
 * redact.ts — masks secrets on the bot's OUTPUT path (Phase 4, survey §A3).
 *
 * Two layers:
 *  1. Exact values of env vars whose NAME looks secret (TOKEN/SECRET/…),
 *     snapshotted at import so a runtime `export REDACT=off` can't disable it
 *     (hermes agent/redact.py lesson). Zero false positives.
 *  2. Vendor-shaped patterns (sk-, ghp_, xox*, AKIA, Bearer, telegram token,
 *     PEM private keys), masked keeping a 4-char tail for identification.
 *
 * Applied by poller.ts inside tg() (every outgoing text/caption) and on its
 * log lines. Pure; tests inject env/secrets explicitly.
 */

const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL/i;

export function collectSecretValues(env: Record<string, string | undefined> = process.env): string[] {
  const vals: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (SECRET_NAME_RE.test(name)) vals.push(value);
  }
  // Longest first so a secret containing a shorter one is masked in one piece.
  return vals.sort((a, b) => b.length - a.length);
}

/** Snapshot at import time — deliberate (cannot be unset mid-session). */
const SECRETS = collectSecretValues();

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, // bearer auth headers
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token shape
];

const tail = (s: string) => `[REDACTED…${s.slice(-4)}]`;

export function redact(text: string, secrets: string[] = SECRETS): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  for (const re of PATTERNS) out = out.replace(re, (m) => tail(m));
  return out;
}
```

- [ ] **Step 1.4:** Run `bun test redact.test.ts` — expect all PASS. Then `bun test` (full suite) — expect all PASS.

- [ ] **Step 1.5:** Commit: `git add redact.ts redact.test.ts && git commit -m "feat(redact): secret masking - exact env values + vendor patterns"` (with the house trailer).

### Task 2: Wire `redact()` into `tg()` and the noisy log lines

**Files:**
- Modify: `poller.ts` — `tg()` (~line 131) and the `[MSG]` / `[REMIND] fired` log lines

- [ ] **Step 2.1:** Add the import near the other local imports at the top of `poller.ts`:

```ts
import { redact } from "./redact";
```

- [ ] **Step 2.2:** In `tg()`, immediately after the signature line `async function tg(method: string, params: Record<string, unknown> = {}): Promise<any> {`, insert:

```ts
  // Outgoing user-visible strings pass through the redactor — the one
  // chokepoint every message the bot sends goes through (Phase 4).
  if (typeof params.text === "string") params = { ...params, text: redact(params.text) };
  if (typeof params.caption === "string") params = { ...params, caption: redact(params.caption) };
```

- [ ] **Step 2.3:** Redact the two chattiest log lines (they echo user/claude content):
  - In `handleMessage`: `console.log(\`[MSG] ${name} (${model})…\`)` → wrap the interpolated string: `console.log(redact(\`[MSG] …\`))` (keep the existing template literal exactly, just wrapped).
  - In `checkReminders`: `console.log(\`[REMIND] fired ${r.id} -> ${r.chatId}: ${r.text}\`)` → same wrap.

- [ ] **Step 2.4:** Run `bun test` — all PASS (wiring is behavior-neutral for clean text). Run `bunx tsc --noEmit` if the repo typechecks cleanly today (it does) — expect no errors.

- [ ] **Step 2.5:** Commit: `git commit -am "feat(redact): apply at the tg() chokepoint + noisy log lines"`.

### Task 3: PR 1

- [ ] **Step 3.1:** `git push -u origin feat/redaction`
- [ ] **Step 3.2:** `gh pr create` — title `feat(redact): secret redaction on the output path (finishes Phase 4)`; body: what's masked, the two chokepoints, test count, "deploy: poller restart required". End body with the house PR footer.
- [ ] **Step 3.3:** `gh pr merge --rebase --delete-branch`

---

## PR 2 — `feat/reminder-followups` (branch off the updated main)

### Task 4: Follow-up store in `reminders.ts`

**Files:**
- Modify: `reminders.ts` (append after `popDue`)
- Test: `reminders.test.ts` (append; existing tests override `REMINDERS_FILE` — follow the same pattern with `FOLLOWUPS_FILE`)

- [ ] **Step 4.1: Write the failing tests** (append to `reminders.test.ts`):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  addFollowup, getFollowup, resolveFollowup, rebindFollowup,
  markNudged, dueNudges, pruneFollowups, loadFollowups, type Followup,
} from "./reminders.ts";

const T0 = 1_781_000_000;

function freshFollowupFile() {
  process.env.FOLLOWUPS_FILE = join(mkdtempSync(join(tmpdir(), "fu-")), "followups.json");
}

test("addFollowup creates a pending, un-nudged follow-up with a fresh id", () => {
  freshFollowupFile();
  const f = addFollowup(282408422, "לקנות חלב", 111, T0);
  expect(f.status).toBe("pending");
  expect(f.nudged).toBe(false);
  expect(f.messageId).toBe(111);
  const again = addFollowup(282408422, "משהו אחר", 112, T0);
  expect(again.id).not.toBe(f.id);
  expect(loadFollowups().length).toBe(2);
});

test("resolveFollowup marks done/snoozed once; second resolve returns null", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  expect(resolveFollowup(f.id, "done")!.status).toBe("done");
  expect(resolveFollowup(f.id, "snoozed")).toBeNull(); // already resolved
  expect(getFollowup(f.id)!.status).toBe("done");
});

test("dueNudges returns pending follow-ups older than the age, once only", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  expect(dueNudges(T0 + 3599).length).toBe(0); // not old enough
  const due = dueNudges(T0 + 3600);
  expect(due.map((d) => d.id)).toEqual([f.id]);
  markNudged(f.id);
  expect(dueNudges(T0 + 7200).length).toBe(0); // never twice
});

test("resolved follow-ups never nudge; rebind moves the buttons' message", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  rebindFollowup(f.id, 99);
  expect(getFollowup(f.id)!.messageId).toBe(99);
  resolveFollowup(f.id, "snoozed");
  expect(dueNudges(T0 + 9999).length).toBe(0);
});

test("pruneFollowups drops resolved entries older than 7 days, keeps pending", () => {
  freshFollowupFile();
  const a = addFollowup(1, "old done", 1, T0 - 8 * 86_400);
  const b = addFollowup(1, "old pending", 2, T0 - 8 * 86_400);
  resolveFollowup(a.id, "done");
  const removed = pruneFollowups(T0);
  expect(removed).toBe(1);
  expect(getFollowup(a.id)).toBeNull();
  expect(getFollowup(b.id)!.status).toBe("pending");
});
```

- [ ] **Step 4.2:** `bun test reminders.test.ts` — expect FAIL (exports missing).

- [ ] **Step 4.3: Implement** (append to `reminders.ts`):

```ts
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

/** Pending, never-nudged follow-ups whose reminder fired ≥ age ago. */
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
```

- [ ] **Step 4.4:** `bun test` — all PASS.
- [ ] **Step 4.5:** Commit: `feat(reminders): follow-up lifecycle store (pending/done/snoozed + single nudge + prune)`.

### Task 5: Callback helpers in `poller.ts` (pure, exported, tested)

**Files:**
- Modify: `poller.ts` (new section after the /stop section)
- Test: `poller.test.ts` (append)

- [ ] **Step 5.1: Failing tests** (append to `poller.test.ts`; extend the import from `./poller.ts` with `parseFuCallback, fuKeyboard, snoozeKeyboard, snoozeTarget`):

```ts
test("parseFuCallback parses valid data and rejects junk", () => {
  expect(parseFuCallback("fu:done:f3")).toEqual({ action: "done", id: "f3" });
  expect(parseFuCallback("fu:s1h:f12")).toEqual({ action: "s1h", id: "f12" });
  expect(parseFuCallback("fu:nope:f1")).toBeNull();
  expect(parseFuCallback("cal:yes:1")).toBeNull(); // future namespaces are not ours
  expect(parseFuCallback("")).toBeNull();
});

test("fuKeyboard / snoozeKeyboard carry the follow-up id in callback_data", () => {
  const kb = fuKeyboard("f7") as any;
  const flat = kb.inline_keyboard.flat().map((b: any) => b.callback_data);
  expect(flat).toEqual(["fu:done:f7", "fu:later:f7"]);
  const sk = snoozeKeyboard("f7") as any;
  expect(sk.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([
    "fu:s1h:f7", "fu:seve:f7", "fu:stom:f7",
  ]);
});

test("snoozeTarget: +1h, evening-rolls-to-tomorrow, tomorrow-morning", () => {
  // 2026-06-11 10:00 local
  const morning = Math.floor(new Date(2026, 5, 11, 10, 0, 0).getTime() / 1000);
  expect(snoozeTarget("s1h", morning)).toBe(morning + 3600);
  const eve = new Date(snoozeTarget("seve", morning) * 1000);
  expect([eve.getDate(), eve.getHours()]).toEqual([11, 20]); // today 20:00
  // 2026-06-11 21:30 local — evening already past, rolls to tomorrow 20:00
  const night = Math.floor(new Date(2026, 5, 11, 21, 30, 0).getTime() / 1000);
  const eve2 = new Date(snoozeTarget("seve", night) * 1000);
  expect([eve2.getDate(), eve2.getHours()]).toEqual([12, 20]);
  const tom = new Date(snoozeTarget("stom", night) * 1000);
  expect([tom.getDate(), tom.getHours()]).toEqual([12, 9]);
});
```

- [ ] **Step 5.2:** `bun test poller.test.ts` — FAIL (exports missing).

- [ ] **Step 5.3: Implement** (new section in `poller.ts`, after the /stop helpers):

```ts
// ---------------------------------------------------------------------------
// Inline-button callbacks: reminder follow-ups (phase 5 — feel)
// callback_data protocol (≤64 bytes): "fu:<action>:<followupId>"
// ---------------------------------------------------------------------------

export interface FuCallback {
  action: "done" | "later" | "s1h" | "seve" | "stom";
  id: string;
}

export function parseFuCallback(data: string): FuCallback | null {
  const m = /^fu:(done|later|s1h|seve|stom):([\w-]+)$/.exec(data ?? "");
  return m ? { action: m[1] as FuCallback["action"], id: m[2] } : null;
}

export function fuKeyboard(id: string): unknown {
  return {
    inline_keyboard: [[
      { text: "בוצע ✓", callback_data: `fu:done:${id}` },
      { text: "תזכיר לי שוב", callback_data: `fu:later:${id}` },
    ]],
  };
}

export function snoozeKeyboard(id: string): unknown {
  return {
    inline_keyboard: [[
      { text: "+1 שעה", callback_data: `fu:s1h:${id}` },
      { text: "הערב 20:00", callback_data: `fu:seve:${id}` },
      { text: "מחר 09:00", callback_data: `fu:stom:${id}` },
    ]],
  };
}

/** Snooze target time (epoch s). Evening = today 20:00, or tomorrow if past. */
export function snoozeTarget(action: "s1h" | "seve" | "stom", nowEpoch: number): number {
  if (action === "s1h") return nowEpoch + 3600;
  const now = new Date(nowEpoch * 1000);
  if (action === "seve") {
    const eve = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0, 0);
    const t = Math.floor(eve.getTime() / 1000);
    return t > nowEpoch ? t : t + 86_400;
  }
  const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return Math.floor(tom.getTime() / 1000);
}
```

- [ ] **Step 5.4:** `bun test` — all PASS.
- [ ] **Step 5.5:** Commit: `feat(poller): follow-up callback protocol + keyboards + snooze math`.

### Task 6: Poller wiring — buttons on fire, callback handling, nudges

**Files:**
- Modify: `poller.ts` — the `TgUpdate` interface, `checkReminders()`, the `main()` update loop; new `handleCallback()`.

- [ ] **Step 6.1:** Extend the `TgUpdate` interface (find `interface TgUpdate` near the other Tg types) with:

```ts
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
    data?: string;
  };
```

- [ ] **Step 6.2:** Extend the reminders import line from `./reminders` to also bring in:
`addOnce, addFollowup, getFollowup, resolveFollowup, rebindFollowup, markNudged, dueNudges, pruneFollowups, fmt`.

- [ ] **Step 6.3:** In `checkReminders()`, replace the plain one-time send (the `else` branch around line ~790, currently `await tg("sendMessage", { chat_id: r.chatId, text: \`⏰ Reminder: ${r.text}\` });`) with:

```ts
        if (r.repeat) {
          await tg("sendMessage", { chat_id: r.chatId, text: `⏰ Reminder: ${r.text}` });
        } else {
          // One-time task reminders carry done/snooze buttons (follow-up loop).
          const fu = addFollowup(r.chatId, r.text, 0, Math.floor(Date.now() / 1000));
          const sent = await tg("sendMessage", {
            chat_id: r.chatId,
            text: `⏰ Reminder: ${r.text}`,
            reply_markup: fuKeyboard(fu.id),
          });
          rebindFollowup(fu.id, sent.message_id);
        }
```

(The surrounding `[AUTO]` branch and the `console.log` stay exactly as they are; this replaces only the plain-ping line.)

- [ ] **Step 6.4:** At the END of `checkReminders()` (after the `for` loop over `due`), add the nudge pass:

```ts
  // One gentle nudge for follow-ups ignored for an hour; prune old resolved ones.
  try {
    const nowS = Math.floor(Date.now() / 1000);
    for (const f of dueNudges(nowS)) {
      const sent = await tg("sendMessage", {
        chat_id: f.chatId,
        text: `עדיין רלוונטי? ⏰ ${f.text}`,
        reply_markup: fuKeyboard(f.id),
      });
      markNudged(f.id);
      rebindFollowup(f.id, sent.message_id);
      console.log(`[REMIND] nudged ${f.id} -> ${f.chatId}`);
    }
    pruneFollowups(nowS);
  } catch (e: any) {
    console.error(`[ERR] nudges: ${e?.message ?? e}`);
  }
```

- [ ] **Step 6.5:** Add `handleCallback` (new function after `handleMessage`):

```ts
/** Inline-button presses. ACK fast, allowlist-check, then route by namespace. */
async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  // Always ACK — otherwise Telegram shows a spinner on the button for minutes.
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (!loadAllowList().has(cq.from.id)) return;
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const parsed = parseFuCallback(cq.data ?? "");
  if (!parsed || chatId == null || messageId == null) return; // unknown namespace — ignore

  const nowS = Math.floor(Date.now() / 1000);
  if (parsed.action === "done") {
    const f = resolveFollowup(parsed.id, "done");
    if (!f) return; // already resolved — the ACK is enough
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${cq.message?.text ?? `⏰ ${f.text}`} — ✓ בוצע`,
    }).catch(() => {});
  } else if (parsed.action === "later") {
    if (getFollowup(parsed.id)?.status !== "pending") return;
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: snoozeKeyboard(parsed.id),
    }).catch(() => {});
  } else {
    const f = resolveFollowup(parsed.id, "snoozed");
    if (!f) return;
    const t = snoozeTarget(parsed.action, nowS);
    addOnce(f.chatId, t, f.text);
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${cq.message?.text ?? `⏰ ${f.text}`} — נדחה ל־${fmt(t)}`,
    }).catch(() => {});
    console.log(`[REMIND] snoozed fu ${f.id} to ${fmt(t)}`);
  }
}
```

(If `loadAllowList()` returns an array rather than a Set in this codebase, use `.includes(cq.from.id)` — match the existing call sites.)

- [ ] **Step 6.6:** In `main()`'s update loop, after the `if (u.message) { … }` block, add:

```ts
      else if (u.callback_query) {
        try {
          await handleCallback(u.callback_query);
        } catch (e: any) {
          console.error(`[ERR] callback: ${e?.message ?? e}`);
        }
      }
```

- [ ] **Step 6.7:** `bun test` + `bunx tsc --noEmit` — all green. (The wiring itself is thin; its logic lives in the tested helpers.)
- [ ] **Step 6.8:** Commit: `feat(poller): reminder follow-ups - buttons on one-time fires, callback routing, single 1h nudge`.

### Task 7: PR 2

- [ ] **Step 7.1:** Push, `gh pr create` — title `feat(reminders): done/snooze follow-up buttons + nudge (Phase 5 core)`; body covers the flow, the followups.json deviation note, test count, deploy note (restart). House footer.
- [ ] **Step 7.2:** `gh pr merge --rebase --delete-branch`.

---

## PR 3 — `feat/review-loop` (branch off the updated main)

### Task 8: `review.ts` — prompt, spawn args, cooldown

**Files:**
- Create: `review.ts`
- Test: `review.test.ts`

- [ ] **Step 8.1: Failing tests**

```ts
// review.test.ts
import { test, expect } from "bun:test";
import { buildReviewPrompt, reviewSpawnArgs, shouldReview, REVIEW_ALLOWED_TOOLS } from "./review.ts";

test("buildReviewPrompt embeds the rules and the transcript in order", () => {
  const p = buildReviewPrompt([
    { role: "user", content: "אני אלרגי לבוטנים" },
    { role: "assistant", content: "רשמתי" },
  ]);
  expect(p).toContain("mem.ts add");
  expect(p).toContain("skill.ts");
  expect(p).toContain("--source derived");
  expect(p.indexOf("[user] אני אלרגי לבוטנים")).toBeLessThan(p.indexOf("[assistant] רשמתי"));
  expect(p).toContain("PATCH an existing");
});

test("reviewSpawnArgs whitelists exactly mem.ts and skill.ts, cheap model, no skip-permissions", () => {
  const args = reviewSpawnArgs();
  expect(args).toContain("--allowedTools");
  for (const t of REVIEW_ALLOWED_TOOLS) expect(args).toContain(t);
  expect(args).toContain("haiku");
  expect(args).not.toContain("--dangerously-skip-permissions"); // whitelist must bind
});

test("shouldReview gates by per-chat cooldown", () => {
  const state = new Map<number, number>();
  expect(shouldReview(1, 1000, state)).toBe(true);
  expect(shouldReview(1, 1000 + 899, state)).toBe(false); // inside 15 min
  expect(shouldReview(2, 1000 + 10, state)).toBe(true); // other chat independent
  expect(shouldReview(1, 1000 + 900, state)).toBe(true); // cooldown elapsed
});
```

- [ ] **Step 8.2:** `bun test review.test.ts` — FAIL.

- [ ] **Step 8.3: Implement `review.ts`**

```ts
/**
 * review.ts — the background self-improvement pass (Phase 7 head start).
 *
 * After the bot replies, the poller may spawn ONE detached, cheap claude -p
 * whose tools are whitelisted to exactly `bun run mem.ts *` and
 * `bun run skill.ts *`. It rereads the recent exchange and persists durable
 * facts / reusable procedures through the SAME guarded CLIs as everything else
 * (derived → quarantine; do-NOT-capture rejects). Quiet by design: its stdout
 * is discarded; the nightly summary surfaces what was learned.
 *
 * No --dangerously-skip-permissions here: in non-interactive mode, tools NOT
 * on the whitelist are denied, which is the point. CLAUDE_AUTO_SESSION=1 keeps
 * the guard hook's least-privilege layer on as defense in depth.
 */

export const REVIEW_COOLDOWN_S = Number(process.env.REVIEW_COOLDOWN_S ?? 900);

export const REVIEW_ALLOWED_TOOLS = [
  "Bash(bun run mem.ts *)",
  "Bash(bun run skill.ts *)",
];

export function reviewSpawnArgs(model = "haiku"): string[] {
  return ["-p", "--model", model, "--allowedTools", ...REVIEW_ALLOWED_TOOLS];
}

const lastReviewAt = new Map<number, number>();

/** True (and stamps the clock) when this chat hasn't been reviewed for 15 min. */
export function shouldReview(
  chatId: number,
  nowEpoch: number,
  state: Map<number, number> = lastReviewAt,
): boolean {
  const last = state.get(chatId) ?? 0;
  if (nowEpoch - last < REVIEW_COOLDOWN_S) return false;
  state.set(chatId, nowEpoch);
  return true;
}

export function buildReviewPrompt(transcript: { role: string; content: string }[]): string {
  return [
    "You are the assistant bot's after-conversation reviewer. Below are the latest exchanges between Maor and the bot.",
    "Your ONLY job: decide whether anything deserves persisting, and persist it with these Bash commands:",
    '  bun run mem.ts add --kind user|agent --source maor|derived --content "<short fact>"',
    "  bun run skill.ts search <query> | view <name> | create --name <slug> --desc \"Use when …\" --source maor --body \"<steps>\" | patch --name <slug> --old \"<substr>\" --new \"<text>\"",
    "Rules:",
    "- Durable facts Maor states about himself (preferences, recurring details) → mem.ts add --kind user --source maor.",
    "- Anything learned from emails/web pages/files (outside content) → --source derived. It will quarantine for Maor's approval — that is correct, do not work around it.",
    "- A procedure that WORKED in this conversation and will clearly repeat → a skill. SEARCH FIRST; PATCH an existing close skill instead of creating a near-duplicate; only then create.",
    '- Corrections from Maor ("תפסיק", "אל תעשה", "too verbose", "answer shorter") are first-class: persist the corrected behavior (memory for preferences; skill patch when a skill caused the mistake).',
    "- Do NOT save one-off task narratives, negative tool claims, secrets, or anything already persisted (the CLIs also reject some of these — respect their refusals, do not rephrase to sneak past).",
    "- Hebrew content stays in Hebrew. Keep every entry short.",
    "- If nothing qualifies: do nothing and finish. Your text output is discarded either way.",
    "",
    "Transcript (oldest first):",
    ...transcript.map((m) => `[${m.role}] ${m.content}`),
  ].join("\n");
}

/** Fire-and-forget review run. Never throws into the caller; logs its exit. */
export function runReview(
  transcript: { role: string; content: string }[],
  opts: { claudeBin: string; cwd: string; env: Record<string, string | undefined> },
): void {
  try {
    const proc = Bun.spawn([opts.claudeBin, ...reviewSpawnArgs()], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...opts.env, CLAUDE_AUTO_SESSION: "1" },
    });
    proc.stdin!.write(buildReviewPrompt(transcript));
    proc.stdin!.end();
    void proc.exited.then(async (code) => {
      const err = code === 0 ? "" : (await new Response(proc.stderr).text()).slice(0, 300);
      console.log(`[REVIEW] exit ${code}${err ? ` — ${err}` : ""}`);
    });
  } catch (e: any) {
    console.error(`[ERR] review spawn: ${e?.message ?? e}`);
  }
}
```

- [ ] **Step 8.4:** `bun test` — all PASS.
- [ ] **Step 8.5:** Commit: `feat(review): background review pass - prompt, restricted spawn, cooldown`.

### Task 9: Verify the `--allowedTools` flag binds in non-interactive mode

- [ ] **Step 9.1:** Run `claude --help 2>&1 | grep -i allowedTools` — expect the flag listed. If absent, STOP and surface to the main session (do not improvise a different mechanism).
- [ ] **Step 9.2:** Live check that the whitelist denies off-list tools (one cheap call):
`echo "Run exactly: ls. Then stop." | claude -p --model haiku --allowedTools "Bash(bun run mem.ts *)"` — expect the reply to indicate it could NOT run `ls` (permission denied / asked to). If `ls` executed, STOP and surface — the whitelist isn't binding and the review loop must not ship.

### Task 10: Poller trigger

**Files:**
- Modify: `poller.ts` — imports + the success tail of `handleMessage` (right after the `[DONE] replied` log / 👍 reaction).

- [ ] **Step 10.1:** Add import: `import { shouldReview, runReview } from "./review";`

- [ ] **Step 10.2:** In `handleMessage`, immediately after `console.log(\`[DONE] replied to ${fromId}\`);` and the success-reaction line, add:

```ts
    // Self-improvement pass (Phase 7): detached, cooldown-gated, never blocks.
    if (shouldReview(chatId, Math.floor(Date.now() / 1000))) {
      try {
        const transcript = recentMessages(db, chatId, 20).map((m) => ({ role: m.role, content: m.content }));
        runReview(transcript, { claudeBin: CLAUDE_BIN, cwd: PROJECT_DIR, env: process.env });
      } catch (e: any) {
        console.error(`[ERR] review: ${e?.message ?? e}`);
      }
    }
```

(`db` here is the same handle `handleMessage` already uses for recall/persist — reuse the existing local variable; `recentMessages` is already imported from `./db`.)

- [ ] **Step 10.3:** `bun test` + `bunx tsc --noEmit` — green.
- [ ] **Step 10.4:** Commit: `feat(poller): fire the review pass after replies (15-min cooldown, detached)`.

### Task 11: PR 3

- [ ] **Step 11.1:** Push, `gh pr create` — title `feat(review): background self-improvement loop (quiet, cooldown-gated, whitelisted tools)`; body: trigger, whitelist + the Task 9 verification result, cost note, deploy note. House footer.
- [ ] **Step 11.2:** `gh pr merge --rebase --delete-branch`.

---

## Task 12 — Deploy (MAIN SESSION ONLY — requires the droplet SSH key)

- [ ] **Step 12.1:** ssh droplet: `git -C ~/claude-bot status --short` (inspect any dirt), then `git -C ~/claude-bot pull --ff-only`.
- [ ] **Step 12.2:** Edit r8's nightly-summary text (reminders.json on the droplet) to append: `בסוף, אם נוספו היום זיכרונות או כישורים חדשים (בדוק בטבלת journal של memory/bot.db מאז חצות), הוסף שורה קצרה: 'מה למדתי היום: …'. אם לא נוסף כלום, דלג על השורה.` — via a small `~/.bun/bin/bun -e` JSON edit or cancel+re-add with the full new text.
- [ ] **Step 12.3:** Restart: `tmux kill-session -t bot; pkill -x bun; tmux new-session -d -s bot /home/claudebot/claude-bot/start.sh`; verify banner + single bun.
- [ ] **Step 12.4:** Live verification: (a) schedule a 1-minute test reminder → message arrives WITH buttons; press בוצע → ✓ stamp; (b) schedule another → press תזכיר לי שוב → snooze row → +1 שעה → new reminder listed; (c) redaction probe — ask the bot (via [AUTO] test or Maor) to print an `sk-…` style fake key → reply shows `[REDACTED…]`; (d) after a real Maor message, droplet log shows `[REVIEW] exit 0` within a minute.

---

## Self-review notes (run after writing — done)

- Spec coverage: redaction (T1–2), chokepoints (T2), follow-up store + prune (T4), protocol/keyboards/snooze math (T5), one-time-only buttons + nudge + callback routing (T6), review prompt/spawn/cooldown (T8), whitelist verification (T9), trigger (T10), r8 digest + deploy + live checks (T12). Deviation from spec recorded in the header (sibling `followups.json`).
- Types consistent: `Followup`, `FuCallback`, `snoozeTarget`, `fuKeyboard` names match across tasks.
- No placeholders; every code step shows the code.
