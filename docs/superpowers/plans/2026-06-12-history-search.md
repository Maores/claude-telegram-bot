# History Search CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliberate "what did we decide about X?" digging over the full message archive — `bun run history.ts search "<query>"` (bm25-ranked FTS) + `history.ts context <id>` (surrounding conversation), complementing the automatic per-turn recall.

**Architecture:** Two new query functions in `db.ts` (next to `searchMessages`, reusing `sanitizeFtsQuery` and the `messages_fts` join); `history.ts` is a thin CLI — arg parsing and rendering as exported pure functions, IO only in `main`. The agent learns to reach for it via a CLAUDE.md section.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun:test`. Zero new deps. Branch `feat/history-search` off main. Suite gate = PIPESTATUS, commits with the Claude co-author trailer (read the header of `docs/superpowers/plans/2026-06-12-nonblocking-loop.md` for the exact conventions if unsure).

---

### Task 1: `db.ts` — `searchHistory` + `contextAround`

**Files:**
- Modify: `db.ts` (add below `searchMessages`; read `MessageRow`, `sanitizeFtsQuery`, and `searchMessages` first — mirror their style)
- Modify: `db.test.ts` (append; read its setup helpers first — it builds throwaway DBs)

- [ ] **Step 1.1: Append the failing tests** to `db.test.ts` (adapt the db-construction boilerplate to the file's existing helper pattern — if it has a `mkDb()`/`openDb(":memory:")` idiom, use that):

```ts
// --- searchHistory: deliberate cross-history digging (history.ts CLI) ---------

test("searchHistory ranks matches across all chats and respects limit", () => {
  const db = openDb(":memory:");
  insertMessage(db, { chatId: 1, role: "user", content: "החלטנו לקנות מזגן חדש לסלון", ts: 1_700_000_000, model: "sonnet" });
  insertMessage(db, { chatId: 2, role: "assistant", content: "המזגן הוזמן", ts: 1_700_000_100, model: "sonnet" });
  insertMessage(db, { chatId: 1, role: "user", content: "something unrelated", ts: 1_700_000_200, model: "sonnet" });
  const hits = searchHistory(db, "מזגן", {});
  expect(hits.length).toBe(2);
  expect(hits.every((h) => h.content.includes("מזגן"))).toBe(true);
  expect(searchHistory(db, "מזגן", { limit: 1 }).length).toBe(1);
});

test("searchHistory filters by chat and by days", () => {
  const db = openDb(":memory:");
  const now = 2_000_000_000;
  insertMessage(db, { chatId: 1, role: "user", content: "old banana fact", ts: now - 10 * 86_400, model: "sonnet" });
  insertMessage(db, { chatId: 2, role: "user", content: "fresh banana news", ts: now - 86_400, model: "sonnet" });
  expect(searchHistory(db, "banana", { chatId: 2 }).length).toBe(1);
  expect(searchHistory(db, "banana", { days: 3, now }).length).toBe(1);
  expect(searchHistory(db, "banana", { days: 30, now }).length).toBe(2);
});

test("searchHistory returns [] on empty/garbage queries instead of throwing", () => {
  const db = openDb(":memory:");
  expect(searchHistory(db, "", {})).toEqual([]);
  expect(searchHistory(db, '"*()', {})).toEqual([]);
});

test("contextAround returns the surrounding rows of the SAME chat in order", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 10; i++) {
    insertMessage(db, { chatId: 1, role: i % 2 ? "assistant" : "user", content: `c1 msg ${i}`, ts: 1_700_000_000 + i, model: "sonnet" });
    insertMessage(db, { chatId: 2, role: "user", content: `c2 noise ${i}`, ts: 1_700_000_000 + i, model: "sonnet" });
  }
  const all = recentMessages(db, 1, 10);
  const target = all[5]; // some mid-conversation row of chat 1
  const ctx = contextAround(db, target.id, 2);
  expect(ctx.length).toBe(5); // 2 before + target + 2 after
  expect(ctx.map((r) => r.id)).toEqual([...ctx.map((r) => r.id)].sort((a, b) => a - b)); // chronological
  expect(ctx.every((r) => r.content.startsWith("c1"))).toBe(true); // never leaks other chats
  expect(ctx.some((r) => r.id === target.id)).toBe(true);
});

test("contextAround of an unknown id returns []", () => {
  const db = openDb(":memory:");
  expect(contextAround(db, 999, 4)).toEqual([]);
});
```

(Extend the test file's import from `./db` with `searchHistory, contextAround`, plus `openDb, insertMessage, recentMessages` if not already imported.)

- [ ] **Step 1.2: Run** `bun test db.test.ts` — expect FAIL (missing exports).

- [ ] **Step 1.3: Implement in `db.ts`** below `searchMessages`:

```ts
export interface HistoryHit extends MessageRow {
  rank: number;
}

/**
 * Deliberate history digging for the history.ts CLI: bm25-ranked FTS over ALL
 * messages (recall's searchMessages is per-chat and window-bounded; this one
 * is the "what did we decide about X?" archive search). Optional chat / days
 * filters. [] on empty query or FTS error — digging must never crash the CLI.
 */
export function searchHistory(
  db: Database,
  query: string,
  opts: { chatId?: number; days?: number; limit?: number; now?: number } = {},
): HistoryHit[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 8;
  const conds: string[] = ["messages_fts MATCH ?"];
  const params: (string | number)[] = [match];
  if (opts.chatId != null) {
    conds.push("m.chat_id = ?");
    params.push(opts.chatId);
  }
  if (opts.days != null) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    conds.push("m.ts >= ?");
    params.push(now - opts.days * 86_400);
  }
  params.push(limit);
  try {
    return db
      .query(
        `SELECT m.id, m.chat_id AS chatId, m.role, m.content, m.ts, m.model, rank
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
          WHERE ${conds.join(" AND ")}
          ORDER BY rank
          LIMIT ?`,
      )
      .all(...params) as HistoryHit[];
  } catch {
    return [];
  }
}

/** The n rows before/after a message WITHIN ITS CHAT, chronological, target
 *  included. [] when the id doesn't exist. */
export function contextAround(db: Database, id: number, around = 4): MessageRow[] {
  const target = db
    .query(`SELECT id, chat_id AS chatId, role, content, ts, model FROM messages WHERE id = ?`)
    .get(id) as MessageRow | null;
  if (!target) return [];
  const before = db
    .query(
      `SELECT id, chat_id AS chatId, role, content, ts, model
         FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
    )
    .all((target as any).chatId, id, around) as MessageRow[];
  const after = db
    .query(
      `SELECT id, chat_id AS chatId, role, content, ts, model
         FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all((target as any).chatId, id, around) as MessageRow[];
  return [...before.reverse(), target, ...after];
}
```

IMPORTANT: before coding, READ `db.ts`'s actual column names (`chat_id` vs `chatId` in `MessageRow`, how `searchMessages` aliases them) and mirror exactly — adjust the SQL above if the real schema differs from this sketch. The TESTS are the contract; the SQL is reference.

- [ ] **Step 1.4: Run** `bun test db.test.ts` — all pass; full suite PIPESTATUS gate — SUITE_EXIT:0.

- [ ] **Step 1.5: Commit** — `feat(history): searchHistory + contextAround archive queries` (+ trailer).

---

### Task 2: `history.ts` CLI

**Files:**
- Create: `history.ts`
- Create: `history.test.ts`

- [ ] **Step 2.1: Failing tests** — `history.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseHistoryArgs, renderHit, renderContextRow } from "./history";

test("parseHistoryArgs: search with flags", () => {
  expect(parseHistoryArgs(["search", "מה החלטנו", "--chat", "5", "--days", "30", "--limit", "3"])).toEqual({
    cmd: "search",
    query: "מה החלטנו",
    chatId: 5,
    days: 30,
    limit: 3,
  });
});

test("parseHistoryArgs: defaults and context form", () => {
  expect(parseHistoryArgs(["search", "banana"])).toEqual({ cmd: "search", query: "banana" });
  expect(parseHistoryArgs(["context", "412", "--around", "2"])).toEqual({ cmd: "context", id: 412, around: 2 });
  expect(parseHistoryArgs(["context", "412"])).toEqual({ cmd: "context", id: 412 });
});

test("parseHistoryArgs: junk → null (caller prints usage)", () => {
  expect(parseHistoryArgs([])).toBeNull();
  expect(parseHistoryArgs(["search"])).toBeNull(); // query required
  expect(parseHistoryArgs(["context", "abc"])).toBeNull(); // id must be numeric
  expect(parseHistoryArgs(["nuke", "it"])).toBeNull();
});

test("renderHit: [#id local-time] role: content, truncated at 200", () => {
  const line = renderHit({ id: 7, chatId: 1, role: "user", content: "x".repeat(300), ts: 1_750_000_000, model: "sonnet", rank: -1 } as any);
  expect(line.startsWith("[#7 ")).toBe(true);
  expect(line).toContain("] user: ");
  expect(line.length).toBeLessThan(240);
  expect(line.endsWith("…")).toBe(true);
});

test("renderContextRow marks the target row", () => {
  const row = { id: 7, chatId: 1, role: "assistant", content: "hi", ts: 1_750_000_000, model: "sonnet" } as any;
  expect(renderContextRow(row, 7).startsWith("→")).toBe(true);
  expect(renderContextRow(row, 8).startsWith(" ")).toBe(true);
});
```

- [ ] **Step 2.2: Run** — FAIL (no module). 

- [ ] **Step 2.3: Implement `history.ts`:**

```ts
/**
 * history.ts — deliberate archive digging, complementing automatic recall.
 *
 *   bun run history.ts search "<query>" [--chat <id>] [--days <n>] [--limit <k>]
 *   bun run history.ts context <message-id> [--around <n>]
 *
 * The agent runs these via Bash when Maor asks "what did we say/decide about
 * X?" and the automatic recall block didn't surface it (CLAUDE.md documents
 * this). Pure helpers exported for tests; IO only in main().
 */

import { getDb, searchHistory, contextAround, type HistoryHit, type MessageRow } from "./db";
import { fmt } from "./reminders.ts"; // local-time "YYYY-MM-DD HH:MM"

export interface SearchArgs {
  cmd: "search";
  query: string;
  chatId?: number;
  days?: number;
  limit?: number;
}
export interface ContextArgs {
  cmd: "context";
  id: number;
  around?: number;
}

/** argv (after the script name) → parsed command, or null for usage. */
export function parseHistoryArgs(argv: string[]): SearchArgs | ContextArgs | null {
  const [cmd, ...rest] = argv;
  const num = (s: string | undefined) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  if (cmd === "search") {
    const query = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
    if (!query) return null;
    const out: SearchArgs = { cmd: "search", query };
    for (let i = 1; i < rest.length; i += 2) {
      const v = num(rest[i + 1]);
      if (v == null) return null;
      if (rest[i] === "--chat") out.chatId = v;
      else if (rest[i] === "--days") out.days = v;
      else if (rest[i] === "--limit") out.limit = v;
      else return null;
    }
    return out;
  }
  if (cmd === "context") {
    const id = num(rest[0]);
    if (id == null) return null;
    const out: ContextArgs = { cmd: "context", id };
    if (rest.length > 1) {
      if (rest[1] !== "--around") return null;
      const a = num(rest[2]);
      if (a == null) return null;
      out.around = a;
    }
    return out;
  }
  return null;
}

const truncate = (s: string, max = 200) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** One search hit: `[#id YYYY-MM-DD HH:MM] role: content…` (single line). */
export function renderHit(h: HistoryHit): string {
  return `[#${h.id} ${fmt(h.ts)}] ${h.role}: ${truncate(h.content.replace(/\s+/g, " "))}`;
}

/** One context row; the target line is arrow-marked. */
export function renderContextRow(r: MessageRow, targetId: number): string {
  const mark = r.id === targetId ? "→" : " ";
  return `${mark} [#${r.id} ${fmt(r.ts)}] ${r.role}: ${truncate(r.content.replace(/\s+/g, " "))}`;
}

function main() {
  const parsed = parseHistoryArgs(process.argv.slice(2));
  if (!parsed) {
    console.log(
      'usage: bun run history.ts search "<query>" [--chat <id>] [--days <n>] [--limit <k>]\n' +
        "       bun run history.ts context <message-id> [--around <n>]",
    );
    process.exit(1);
  }
  const db = getDb();
  if (parsed.cmd === "search") {
    const hits = searchHistory(db, parsed.query, parsed);
    if (!hits.length) {
      console.log("(no matches)");
      return;
    }
    for (const h of hits) console.log(renderHit(h));
    console.log(`\n(${hits.length} hits — drill in with: bun run history.ts context <id>)`);
  } else {
    const rows = contextAround(db, parsed.id, parsed.around ?? 4);
    if (!rows.length) {
      console.log(`(no message #${parsed.id})`);
      return;
    }
    for (const r of rows) console.log(renderContextRow(r, parsed.id));
  }
}

if (import.meta.main) main();
```

(If `db.ts`'s real `MessageRow` field names differ — e.g. `chatId` vs `chat_id` — follow the real ones; tests are the contract.)

- [ ] **Step 2.4: Run** history tests then full suite (PIPESTATUS) — SUITE_EXIT:0.

- [ ] **Step 2.5: Smoke it for real** (the local dev DB may be empty — create a throwaway):

```bash
bun run history.ts search "test" ; bun run history.ts context 1 ; bun run history.ts
```
Expected: graceful "(no matches)" / "(no message #1)" / usage — no stack traces.

- [ ] **Step 2.6: Commit** — `feat(history): history.ts CLI - archive search + context view` (+ trailer).

---

### Task 3: Docs + PR (left OPEN)

- [ ] **Step 3.1: CLAUDE.md** — after the "## Long-term memory" section, add:

```markdown
## History search (deliberate digging)
Automatic recall injects a few relevant past messages each turn. When Maor asks
"מה אמרנו על X?" / "what did we decide about Y?" and the recalled context above
doesn't already answer it, dig deliberately:
- `bun run history.ts search "<query>" [--chat <id>] [--days <n>] [--limit <k>]`
  — bm25 search over the whole archive; each hit starts with its message id.
- `bun run history.ts context <id> [--around <n>]` — the conversation around a
  hit, chronologically.
Quote what you found (with its date) rather than guessing from memory.
```

- [ ] **Step 3.2: README.md** — read it; add one line in its prose mentioning deliberate history search alongside automatic recall.

- [ ] **Step 3.3:** Full suite (PIPESTATUS gate) → commit `docs(history): CLAUDE.md digging instructions + README line` (+ trailer).

- [ ] **Step 3.4: Push + PR — DO NOT MERGE:**

```bash
git push -u origin feat/history-search
gh pr create --title "feat: history search CLI — deliberate archive digging (phase 7)" --body "$(cat <<'EOF'
Roadmap Phase 7 item: deliberate "what did we decide about X?" digging to complement automatic recall.

- db.ts: searchHistory (bm25 over messages_fts, optional --chat/--days filters, never throws) + contextAround (surrounding rows within the same chat)
- history.ts: thin CLI — search + context subcommands, pure arg-parsing/rendering helpers unit-tested
- CLAUDE.md teaches the agent to dig (and quote dates) when recall doesn't already answer; README line

Files are fully disjoint from PR #18 (non-blocking loop) — the two merge in any order.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Confirm OPEN with `gh pr view --json state,url`.

---

## Self-review
1. Spec coverage: search cmd w/ all three flags ✓ (Task 1-2), context ✓, 200-char lines with id+local time ✓ (renderHit), CLAUDE.md + README ✓ (Task 3), disjoint from PR #18 ✓ (db.ts/history.ts/CLAUDE.md/README untouched by the loop branch).
2. Placeholders: none — full code given; the two "follow the real schema" notes are explicit verification instructions, not gaps.
3. Type consistency: HistoryHit extends MessageRow with rank ✓ used by renderHit ✓; parseHistoryArgs return shapes match tests ✓.
