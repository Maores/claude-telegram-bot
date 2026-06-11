# Non-Blocking Update Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The receive loop never awaits long work — button presses ACK instantly on a serialized chain, `/stop` truly interrupts mid-answer (killing the child and draining that chat's queue), and message turns stay strictly ordered per chat.

**Architecture:** A new pure `dispatch.ts` owns triage (`classifyUpdate`) and the two queue primitives (`ChatQueues` per-chat FIFO with epoch-based `drop`, `SerialChain` for callbacks). `poller.ts` keeps `handleMessage`/`handleCallback` internals intact; its loop becomes dispatch-only, `/stop` moves to dispatch level with new stopped-turn semantics (`TurnStopped` → "נעצר ✋", no error reply), and `POLL_SERIAL=1` restores today's sequential behavior as a rollback switch.

**Tech Stack:** Bun + TypeScript, `bun:test`, zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-11-nonblocking-loop-design.md` (final; Maor's three decisions settled 2026-06-12: stop drains queue / callbacks serialized / active by default).

**Conventions:** suite gate = `bun test` checking `${PIPESTATUS[0]}`, never a piped tail's exit. Commits: conventional style + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. Branch: `feat/nonblocking-loop` off main (created in Task 1).

---

### Task 1: `dispatch.ts` — `isStopCommand` (moved) + `classifyUpdate`

**Files:**
- Create: `dispatch.ts`
- Create: `dispatch.test.ts`
- Modify: `poller.ts` (~line 206-214: delete the local `isStopCommand`; add import + re-export)

- [ ] **Step 1.1: Branch**

```bash
git checkout main && git checkout -b feat/nonblocking-loop
```

- [ ] **Step 1.2: Write the failing tests** — create `dispatch.test.ts`:

```ts
import { test, expect } from "bun:test";
import { isStopCommand, classifyUpdate } from "./dispatch";

test("classifyUpdate triages callback > stop > message > ignore", () => {
  expect(classifyUpdate({ update_id: 1, callback_query: {} }, "bot")).toBe("callback");
  expect(classifyUpdate({ update_id: 2, message: { chat: { id: 5 }, text: "/stop" } }, "bot")).toBe("stop");
  expect(classifyUpdate({ update_id: 3, message: { chat: { id: 5 }, text: "/stop@MyBot" } }, "mybot")).toBe("stop");
  expect(classifyUpdate({ update_id: 4, message: { chat: { id: 5 }, text: "hello /stop" } }, "bot")).toBe("message");
  // voice/photo messages have no text — they are messages, not stops
  expect(classifyUpdate({ update_id: 5, message: { chat: { id: 5 } } }, "bot")).toBe("message");
  // update kinds we don't handle (edited_message etc.) are ignored
  expect(classifyUpdate({ update_id: 6 }, "bot")).toBe("ignore");
});

test("isStopCommand exact-match semantics survive the move", () => {
  expect(isStopCommand("/stop", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/STOP", "")).toBe(true);
  expect(isStopCommand("/stop@maores_assistant_bot", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/stop@otherbot", "maores_assistant_bot")).toBe(false);
  expect(isStopCommand("/stopwatch", "x")).toBe(false);
  expect(isStopCommand("please /stop", "x")).toBe(false);
});
```

- [ ] **Step 1.3: Run** `bun test dispatch.test.ts` — expect FAIL: `Cannot find module './dispatch'`.

- [ ] **Step 1.4: Create `dispatch.ts`:**

```ts
/**
 * dispatch.ts — update triage + queues for the non-blocking receive loop.
 *
 * The poller's loop must never await long work: callbacks ACK instantly on
 * their own serialized chain, /stop is handled at dispatch (kill + drain),
 * and message turns run in strict per-chat FIFO order so history/recall
 * always see the previous turn completed. Spec:
 * docs/superpowers/specs/2026-06-11-nonblocking-loop-design.md
 */

/** True when `text` is exactly the /stop command (optionally @-mentioning this
 *  bot). Case-insensitive; trims surrounding whitespace. A normal message that
 *  merely contains "/stop" is not a stop command and never interrupts a run.
 *  (Moved verbatim from poller.ts so triage has no import cycle.) */
export function isStopCommand(text: string, botUsername: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "/stop") return true;
  if (botUsername && t === `/stop@${botUsername.toLowerCase()}`) return true;
  return false;
}

/** The slice of a Telegram update that triage needs. */
export interface DispatchUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: unknown;
}

export type UpdateKind = "callback" | "stop" | "message" | "ignore";

/** Triage an update WITHOUT doing any work. /stop outranks "message" so it
 *  interrupts instead of queueing behind the very turn it targets. */
export function classifyUpdate(u: DispatchUpdate, botUsername: string): UpdateKind {
  if (u.callback_query) return "callback";
  if (u.message) return isStopCommand(u.message.text ?? "", botUsername) ? "stop" : "message";
  return "ignore";
}
```

- [ ] **Step 1.5: Rewire `poller.ts`** — delete its local `isStopCommand` function (the block at ~206-214 including its JSDoc) and add at the imports (next to the other local imports):

```ts
import { classifyUpdate, ChatQueues, SerialChain, isStopCommand } from "./dispatch";
export { isStopCommand }; // poller.test.ts and external users keep their import path
```

(`ChatQueues`/`SerialChain` don't exist until Task 2 — for THIS task's commit, import only `classifyUpdate, isStopCommand`; Task 4 extends the import line.)

- [ ] **Step 1.6: Run** `bun test dispatch.test.ts` then the full suite:

```bash
bun test 2>&1 | tail -3; echo "SUITE_EXIT:${PIPESTATUS[0]}"
```
Expected: dispatch tests pass; full suite passes (poller.test.ts's existing isStopCommand tests pass via the re-export); `SUITE_EXIT:0`.

- [ ] **Step 1.7: Commit**

```bash
git add dispatch.ts dispatch.test.ts poller.ts
git commit -m "feat(loop): dispatch.ts triage - classifyUpdate, isStopCommand moved

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `dispatch.ts` — `ChatQueues` + `SerialChain`

**Files:**
- Modify: `dispatch.test.ts` (append)
- Modify: `dispatch.ts` (append)

- [ ] **Step 2.1: Append the failing tests** (extend the import to `{ isStopCommand, classifyUpdate, ChatQueues, SerialChain }`):

```ts
// test helpers: a manually-opened gate + a microtask/timer flush
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, p };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("ChatQueues runs jobs of one chat strictly in order", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g1 = gate();
  q.enqueue(7, async () => { await g1.p; ran.push("a"); });
  q.enqueue(7, async () => { ran.push("b"); });
  await tick();
  expect(ran).toEqual([]); // b must wait for a
  g1.open();
  await tick(); await tick();
  expect(ran).toEqual(["a", "b"]);
});

test("ChatQueues isolates chats from each other", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(1, async () => { await g.p; ran.push("slow-chat1"); });
  q.enqueue(2, async () => { ran.push("fast-chat2"); });
  await tick();
  expect(ran).toEqual(["fast-chat2"]); // chat 2 never waited on chat 1
  g.open();
  await tick();
});

test("a throwing job does not break its chat's chain", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  q.enqueue(3, async () => { throw new Error("boom"); });
  q.enqueue(3, async () => { ran.push("after-boom"); });
  await tick(); await tick();
  expect(ran).toEqual(["after-boom"]);
});

test("drop() skips queued-but-unstarted jobs, not the running one; queue stays usable", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(9, async () => { await g.p; ran.push("running"); });
  q.enqueue(9, async () => { ran.push("queued-1"); });
  q.enqueue(9, async () => { ran.push("queued-2"); });
  await tick();
  expect(q.pending(9)).toBe(2);
  expect(q.drop(9)).toBe(2);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["running"]); // queued-1/2 were dropped
  q.enqueue(9, async () => { ran.push("post-drop"); });
  await tick(); await tick();
  expect(ran).toEqual(["running", "post-drop"]);
});

test("SerialChain runs jobs one at a time, surviving errors", async () => {
  const c = new SerialChain();
  const ran: string[] = [];
  const g = gate();
  c.enqueue(async () => { await g.p; ran.push("first"); });
  c.enqueue(async () => { throw new Error("mid"); });
  c.enqueue(async () => { ran.push("third"); });
  await tick();
  expect(ran).toEqual([]);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["first", "third"]);
});
```

- [ ] **Step 2.2: Run** `bun test dispatch.test.ts` — expect FAIL (missing exports).

- [ ] **Step 2.3: Append the implementation to `dispatch.ts`:**

```ts
/** Per-chat FIFO of message turns: strict order within a chat, chats
 *  independent, one thrown job never breaks the chain. drop() (the /stop
 *  path) invalidates queued-but-unstarted jobs via an epoch bump — the
 *  running job is stopChild's problem, not ours. */
export class ChatQueues {
  private tails = new Map<number, Promise<void>>();
  private epochs = new Map<number, number>();
  private queued = new Map<number, number>();

  enqueue(chatId: number, job: () => Promise<void>): void {
    const epoch = this.epochs.get(chatId) ?? 0;
    this.queued.set(chatId, (this.queued.get(chatId) ?? 0) + 1);
    const tail = this.tails.get(chatId) ?? Promise.resolve();
    const next = tail
      .then(async () => {
        // Reached the head of the queue: no longer "queued".
        this.queued.set(chatId, (this.queued.get(chatId) ?? 1) - 1);
        if ((this.epochs.get(chatId) ?? 0) !== epoch) return; // dropped by /stop
        await job();
      })
      .catch((e: any) => console.error(`[ERR] queued turn (chat ${chatId}): ${e?.message ?? e}`));
    this.tails.set(chatId, next);
  }

  /** Invalidate every queued-but-unstarted job for the chat. Returns how many. */
  drop(chatId: number): number {
    const n = this.queued.get(chatId) ?? 0;
    this.epochs.set(chatId, (this.epochs.get(chatId) ?? 0) + 1);
    return n;
  }

  /** Queued-but-unstarted turns for a chat (observability + tests). */
  pending(chatId: number): number {
    return this.queued.get(chatId) ?? 0;
  }
}

/** One global FIFO for callback queries: each handler ACKs in <1 s, and
 *  serializing them keeps followups.json single-writer within this process
 *  (two rapid button taps can no longer interleave their read-modify-write). */
export class SerialChain {
  private tail: Promise<void> = Promise.resolve();
  enqueue(job: () => Promise<void>): void {
    this.tail = this.tail
      .then(job)
      .catch((e: any) => console.error(`[ERR] callback chain: ${e?.message ?? e}`));
  }
}
```

- [ ] **Step 2.4: Run** `bun test dispatch.test.ts` — all pass; then full suite with the PIPESTATUS gate — `SUITE_EXIT:0`.

- [ ] **Step 2.5: Commit**

```bash
git add dispatch.ts dispatch.test.ts
git commit -m "feat(loop): ChatQueues per-chat FIFO with epoch drop + SerialChain for callbacks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `poller.ts` — stop-aware `inFlight` + `TurnStopped` semantics

**Files:**
- Modify: `poller.ts` (~lines 190-204 inFlight block; `streamClaude` ~539-621; `handleMessage` catch ~793-800)

No new unit tests: this is process-glue around the already-tested primitives (house style — the full suite still gates, and Task 5's PR documents the live-soak checklist). Read each region before editing; line numbers may have drifted.

- [ ] **Step 3.1: Reshape the in-flight registry.** Replace the current block (Map of bare Subprocess + registerChild/unregisterChild, ~lines 190-204) with:

```ts
/** A claude child currently running for a chat, plus whether /stop killed it
 *  (so the turn ends with "נעצר ✋" instead of the generic error reply). */
interface Flight {
  proc: import("bun").Subprocess;
  stopped?: boolean;
}

/** Claude children in flight, keyed by chat id. The poller runs at most one
 *  interactive turn per chat (ChatQueues guarantees it); [AUTO] runs may
 *  overlap and are killable too. */
const inFlight = new Map<number, Flight>();

function registerChild(chatId: number, proc: import("bun").Subprocess): Flight {
  const f: Flight = { proc };
  inFlight.set(chatId, f);
  return f;
}
/** Only clear the slot if it still holds *this* process (avoid a late finisher
 *  wiping a newer run's entry). */
function unregisterChild(chatId: number, proc: import("bun").Subprocess) {
  if (inFlight.get(chatId)?.proc === proc) inFlight.delete(chatId);
}
/** /stop: mark the running child stopped and kill it. True if one existed. */
function stopChild(chatId: number): boolean {
  const f = inFlight.get(chatId);
  if (!f) return false;
  f.stopped = true;
  try {
    f.proc.kill();
  } catch {}
  return true;
}
```

- [ ] **Step 3.2: Fix the one other `inFlight` consumer.** The legacy `/stop` block inside `handleMessage` (~line 672: `const running = inFlight.get(chatId); … running.kill()`) still compiles against the old shape. Update it to use the new helper — it becomes the POLL_SERIAL-mode path and Task 4 leaves it in place:

```ts
  if (isStopCommand(msg.text ?? "", botUsername)) {
    if (stopChild(chatId)) {
      await tg("sendMessage", { chat_id: chatId, text: "נעצר ✋" }).catch(() => {});
    } else {
      await tg("sendMessage", { chat_id: chatId, text: "אין כרגע משימה רצה לעצור." }).catch(() => {});
    }
    return;
  }
```

(Keep the existing explanatory comment above it, amending its last line to: "Reached only in POLL_SERIAL mode — dispatch intercepts /stop otherwise.")

- [ ] **Step 3.3: `TurnStopped` + the stopped render in `streamClaude`.** Add the sentinel next to `SpawnOpts`:

```ts
/** Thrown when /stop killed this turn's child — callers end the turn quietly
 *  ("נעצר ✋" already rendered) instead of sending the generic error reply. */
export class TurnStopped extends Error {
  constructor() {
    super("turn stopped by /stop");
  }
}
```

In `streamClaude`: change `registerChild(chatId, proc);` to `const flight = registerChild(chatId, proc);` and insert IMMEDIATELY after `const code = await proc.exited; const final = parser.finalText();` (BEFORE the `timedOut` branch — a stop-kill must not be misread as timeout or error):

```ts
  if (flight.stopped) {
    await renderer.render(prefix + (final ? final + "\n\n" : "") + "נעצר ✋").catch(() => {});
    throw new TurnStopped();
  }
```

- [ ] **Step 3.4: Handle `TurnStopped` in `handleMessage`'s catch.** The catch currently starts with `console.error`/👎/error-reply. Prepend:

```ts
  } catch (e: any) {
    if (e instanceof TurnStopped) {
      // The stop reply is already rendered; record a quiet history marker so
      // the next turn's context shows the interruption, and skip 👎 + error.
      console.log(`[STOP] turn for ${fromId} stopped mid-answer`);
      try {
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        insertMessage(db, { chatId, role: "user", content: historyNote, ts: now, model });
        insertMessage(db, { chatId, role: "assistant", content: "[stopped]", ts: now, model });
      } catch {}
      return;
    }
    // …existing error path unchanged…
```

(`historyNote`, `model`, `chatId`, `fromId` are all in scope; the `finally` with `cleanupFile` still runs.)

- [ ] **Step 3.5: Run the full suite** with the PIPESTATUS gate — `SUITE_EXIT:0` (no behavior change yet: nothing sets `stopped` except the /stop paths).

- [ ] **Step 3.6: Commit**

```bash
git add poller.ts
git commit -m "feat(loop): stop-aware inFlight + TurnStopped quiet-exit semantics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `poller.ts` — dispatch-only main loop + `handleStopDispatch` + `POLL_SERIAL`

**Files:**
- Modify: `poller.ts` (imports; new instances near `inFlight`; new `handleStopDispatch` after `handleCallback`; main loop ~1168-1195)

- [ ] **Step 4.1: Extend the dispatch import** (from Task 1) to:

```ts
import { classifyUpdate, ChatQueues, SerialChain, isStopCommand } from "./dispatch";
```

and add the instances directly under the `inFlight` block:

```ts
/** Non-blocking dispatch state (spec 2026-06-11): per-chat message FIFOs and
 *  the one serialized callback chain. POLL_SERIAL=1 bypasses both. */
const chatQueues = new ChatQueues();
const cbChain = new SerialChain();
```

- [ ] **Step 4.2: Add `handleStopDispatch`** right after `handleCallback`'s closing brace:

```ts
/** /stop at dispatch level: kill the running child AND drop that chat's
 *  queued turns. Instant — never spawns claude, never enters a queue. */
async function handleStopDispatch(msg: TgMessage) {
  if (!msg.from || !loadAllowList().has(String(msg.from.id))) return;
  const chatId = msg.chat.id;
  const hadRun = stopChild(chatId);
  const dropped = chatQueues.drop(chatId);
  const text =
    hadRun || dropped
      ? `נעצר ✋${dropped ? ` (בוטלו גם ${dropped} הודעות שחיכו בתור)` : ""}`
      : "אין כרגע משימה רצה לעצור.";
  await tg("sendMessage", { chat_id: chatId, text }).catch(() => {});
}
```

- [ ] **Step 4.3: Rewrite the update loop body.** In `main()`, before the `while (true)`:

```ts
  const serialMode = process.env.POLL_SERIAL === "1";
  if (serialMode) console.log("[BOT] POLL_SERIAL=1 — sequential update handling (rollback mode)");
```

Replace the current `for (const u of updates) { … }` body (the awaited handleMessage/handleCallback calls) with:

```ts
    for (const u of updates) {
      offset = u.update_id + 1;
      if (serialMode) {
        // Rollback mode: today's strictly sequential behavior, verbatim.
        if (u.message) {
          try {
            await handleMessage(u.message);
          } catch (e: any) {
            console.error(`[ERR] unhandled: ${e?.message ?? e}`);
          }
        } else if (u.callback_query) {
          try {
            await handleCallback(u.callback_query);
          } catch (e: any) {
            console.error(`[ERR] callback: ${e?.message ?? e}`);
          }
        }
        continue;
      }
      switch (classifyUpdate(u, botUsername)) {
        case "callback":
          // Fire onto the serialized chain — ACK happens inside, instantly.
          cbChain.enqueue(() => handleCallback(u.callback_query!));
          break;
        case "stop":
          // Instant by design; safe to await (no claude, no queue).
          await handleStopDispatch(u.message!);
          break;
        case "message": {
          const m = u.message!;
          chatQueues.enqueue(m.chat.id, () => handleMessage(m));
          break;
        }
        // "ignore": nothing — same as today's else-fallthrough.
      }
    }
```

(The offset advance + `saveOffset` lines stay exactly as they are — the
crash-loss window is unchanged by design, per the spec.)

- [ ] **Step 4.4: Run the full suite** with the PIPESTATUS gate — `SUITE_EXIT:0`.

- [ ] **Step 4.5: Commit**

```bash
git add poller.ts
git commit -m "feat(loop): dispatch-only receive loop - instant callbacks, true /stop, POLL_SERIAL rollback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs + PR (left OPEN)

**Files:**
- Modify: `DEPLOY.md` (env/tuning area of step 7b's table OR the systemd section — add POLL_SERIAL row where the other env vars live)
- Modify: `README.md` (read first; one line in the prose where /stop & buttons are described, mentioning instant buttons + true mid-answer /stop)

- [ ] **Step 5.1: DEPLOY.md** — add to the existing env-var table:

```markdown
| `POLL_SERIAL` | unset | `1` reverts to the old strictly-sequential update loop (rollback switch; expect button lag + queued /stop again) |
```

- [ ] **Step 5.2: README.md** — read it, then extend the feel/feature prose with one sentence in its existing voice, e.g.: "Button presses acknowledge instantly and `/stop` interrupts mid-answer (draining anything queued behind it) — the update loop dispatches to per-chat queues instead of blocking."

- [ ] **Step 5.3: Full suite once more** (PIPESTATUS gate), then commit:

```bash
git add DEPLOY.md README.md
git commit -m "docs(loop): POLL_SERIAL rollback switch + README feel line

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5.4: Push + open the PR — DO NOT MERGE** (Maor reviews in the morning):

```bash
git push -u origin feat/nonblocking-loop
gh pr create --title "feat: non-blocking update loop — instant buttons, true mid-answer /stop" --body "$(cat <<'EOF'
Fixes the reported button-lag bug at its root (the sequential loop blocked callback ACKs behind whole claude turns — up to 240s) and closes the Phase 5 'non-blocking message loop' roadmap item.

Per the approved spec (docs/superpowers/specs/2026-06-11-nonblocking-loop-design.md, decisions settled 2026-06-12):
- new dispatch.ts: classifyUpdate triage, ChatQueues (strict per-chat FIFO, epoch-based drop), SerialChain (callbacks single-file — followups.json stays single-writer)
- /stop handled at dispatch: kills the running child AND drops that chat's queued turns, reports both (נעצר ✋ + count)
- stopped turns end quietly: TurnStopped → placeholder shows נעצר ✋ (with any partial answer), history records [stopped], no 👎/error reply
- POLL_SERIAL=1 env = instant rollback to the old sequential loop
- offset/crash semantics deliberately unchanged

NOT deployed (per overnight ground rules). Suggested live soak after merge+deploy: ask a slow /opus question → tap a reminder button mid-answer (ACK must be instant) → /stop the answer (dies <1s, says נעצר) → send a normal message (queue resumes clean).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; PR state OPEN.

---

## Self-review (run before execution)

1. **Spec coverage:** triage/queues/serial-chain (Tasks 1-2), dispatch-/stop with drain + stopped semantics (Tasks 3-4), POLL_SERIAL (Task 4), docs+soak checklist (Task 5), offset unchanged (4.3 note). Decisions 1-3 all encoded. ✓
2. **Placeholders:** none — every code step carries the code. ✓
3. **Type consistency:** `Flight`/`registerChild` return used by `streamClaude` (3.3); `ChatQueues.pending` used in tests (2.1) and defined (2.3); import line evolution Task 1→4 stated explicitly. ✓
