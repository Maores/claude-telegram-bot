# Self-improving memory & skills — design spec

Date: 2026-06-09
Status: approved (brainstorm complete; ready for implementation plan)

## Goal

Give the bot a long-term memory and a self-improvement loop, ported as *ideas*
from `nousresearch/hermes-agent`, adapted to this bot's stateless
`claude -p`-per-message architecture and its hard no-API-key constraint.

Three capabilities, built as three shippable phases:

1. **Recall** — the bot can surface relevant bits of *old* conversations that
   have scrolled out of the recent-history window.
2. **Guarded curation** — the bot autonomously writes and consolidates
   structured long-term memory, behind code-enforced guardrails.
3. **Self-written skills** — the bot writes and refines reusable markdown
   "playbook" skills from experience, retrieved by relevance.

## Context & provenance

Sparked by a request to "explore hermes-agent and grab the relevant features."
We cloned the repo (MIT) and studied its memory and skills subsystems directly
rather than trusting the README. Findings that shaped this spec:

- hermes runs **two** memory systems: a built-in local one (SQLite + FTS5
  archive + MemGPT-style curated core files) and pluggable **cloud** providers
  (Honcho, Mem0, Supermemory, RetainDB). The cloud providers all need embeddings
  + API keys and are **excluded** by our no-key constraint. The built-in local
  system is the entire relevant design and maps almost 1:1 onto Bun + `bun:sqlite`.
- The pieces hermes implements with a **long-running agent loop** (a post-turn
  daemon that forks a review agent; an idle-triggered curator) do **not** port to
  our stateless model. We re-home them as foreground tool calls + a separate
  scheduled `claude -p` run (see Phase 3).

**Licensing.** hermes-agent is MIT. We are porting *ideas/algorithms* and
reimplementing in TypeScript (hermes is Python). Where this spec cites hermes
`file:line`, that is implementer guidance, not copied code. If any substantial
block is ever adapted verbatim, retain the hermes MIT attribution.

## Constraints (carried from the existing bot)

- **Stateless:** each Telegram message spawns a fresh `claude -p`. No
  in-process state between messages; persistence is files/SQLite read at message
  start and written during the message. This is a *gift* for a MemGPT-style
  design — every message reloads the memory snapshot for free, so we avoid
  hermes's live/snapshot dual-state and just read-at-start, write-through on edit.
- **No API key / no embeddings.** Keyword/FTS5 recall only.
- **Untrusted data boundary.** The bot ingests email/file/web content, already
  treated as DATA, never instructions (CLAUDE.md). Memory and skills derived from
  that content are the central security concern of this design.
- **Single user**, so per-write confirmation friction is cheap where it buys safety.
- **Latency-sensitive** (Sonnet-default for speed). Recall must add milliseconds,
  not seconds, and cost zero tokens when nothing relevant is found.

## Data model — one SQLite DB (foundation for all phases)

`memory/bot.db` via Bun's built-in `bun:sqlite` (no new dependency, FTS5
compiled in). WAL mode + busy-timeout so the poller and the CLIs don't race
(strictly better than today's `reminders.json` race). Server-only / gitignored,
same trust zone as `MEMORY.md` today. Four tables:

1. **`messages`** — every message ever (not just the last `HISTORY_MAX`):
   `id, chat_id, role, content, ts, model, active`. Becomes the source of truth
   for history; the per-chat `history/<id>.json` files are imported once on first
   run (marker-guarded) then retired. A trigger-synced FTS5 virtual table
   `messages_fts(content)` (rowid = `messages.id`) backs recall. Soft-delete via
   `active` (FTS rows kept, filtered on read).

2. **`memory`** — curated long-term facts (richer successor to flat `MEMORY.md`):
   `id, kind, content, provenance, status, reason, created_ts, updated_ts`.
   `kind` = `user` (facts about Maor) vs `agent` (the bot's own operational
   notes) — the hermes `USER.md` / `MEMORY.md` split. `provenance` = `maor` vs
   `derived`. `status` = `active | quarantined | archived`. FTS5 over archival rows.

3. **`skills`** — index + usage for `SKILL.md` files on disk:
   `id, name, description, tags, path, provenance, status, use_count,
   last_used_at, patch_count, pinned, created_by, created_ts, updated_ts`.
   `status` = `active | stale | archived | quarantined`. FTS5 over
   `name+description+tags`. Bodies live as files (see Phase 3), not in the DB.

4. **`journal`** — append-only audit log: `id, ts, actor, action, target_table,
   target_id, provenance, reason, before, after`. With soft-delete, this is the
   reversibility mechanism (the `memory/` tree is gitignored, so "git-tracked
   memory" is not automatic here).

Scope note: reminders + dedupe state are **not** folded into this DB even though
the roadmap's "SQLite migration" item mentions them. They are separable; this
project needs `messages/memory/skills/journal`. The DB exists as the foundation a
later reminders migration can join.

## Phase 1 — foundation + recall

New module `db.ts` (isolated + unit-tested like `model.ts` / `stream.ts`): opens
`bot.db`, runs idempotent schema (`CREATE … IF NOT EXISTS`), exposes
`insertMessage`, `recentMessages(chatId, n)`, `searchMessages(chatId, query, k)`,
and a marker-guarded one-time `importHistoryJson()`.

Per-message changes in the poller handler (~poller.ts:521–553):
1. Persist the user message to `messages` (replaces the JSON write).
2. **Auto-recall** (Approach 3, hybrid): `searchMessages(chatId, text, K)` — FTS5
   / BM25 over this chat's past messages, top-K above a relevance cut, excluding
   the recent-N window already in context.
3. `buildPrompt` (poller.ts:331) gains a recall block placed between memory and
   recent history, **fenced** as reference data (see Trust & safety) and dated.
4. Recent conversation = last N rows from SQLite (replaces `loadHistory`).
5. Persist the assistant reply.

Ported from hermes (`hermes_state.py`):
- **`_sanitize_fts5_query`** (`:2775`) — preserves quoted phrases, strips FTS5
  special chars (`+{}():"^`), quotes `hyphen-ated`/`dot.ted` tokens, drops
  dangling boolean operators. Without it, the first hyphen/quote in a message
  throws `OperationalError`. Port closely.
- **Anchored window + bookends** (`get_anchored_view`, `:2292`) — each hit
  returns ±N messages around the match **plus** the first/last few of that
  conversation (goal → match → resolution), all in SQL.
- **Dedup + recent-window exclusion** — collapse to one hit per conversation;
  reject the current active thread's recent messages.

Discipline:
- K small (≈3–5), per-snippet length cap, total recall cap. Nothing clears the
  relevance cut → inject nothing (zero token cost).
- **Recall never blocks a reply:** the whole step is wrapped in try/catch. DB
  error or weird FTS input (emoji, one-char message) → skip recall, still answer.
- **Hebrew:** FTS5 `unicode61` tokenizes Hebrew on whitespace — token-level
  keyword recall works; no Hebrew stemming. We skip hermes's `trigram` CJK table
  (not needed for English/Hebrew). Important Hebrew facts are covered by curated
  core memory regardless.

Ships on its own: the bot can suddenly recall things from weeks ago; no curation
or skills exist yet.

## Phase 2 — guarded curation (`mem.ts`)

New CLI `mem.ts`, same shape as `remind.ts` / `cal.ts`; the bot calls it during
its turn. Guardrails are **code in the CLI**, not prose, so they hold regardless
of the prompt. Ported from hermes `tools/memory_tool.py` + `threat_patterns.py`.

Commands: `add`, `replace`, `remove` (soft), `search`, `list`, `promote`,
`restore`. Edits identified by **short unique substring** (`old_text`), not row
IDs — far more reliable for an LLM (hermes `:349`).

Guardrails:
1. **Trust boundary.** `add` requires `--source maor|derived`.
   - `maor` (a fact Maor stated in Telegram) → `status=active` immediately. This
     is the autonomy ("option C").
   - `derived` (from email/file/web) → forced `quarantined`, **not injected**,
     until `mem.ts promote <id>` — which the bot only runs after Maor says "yes."
   - Honest limit: the CLI can't *see* provenance; it trusts the `--source` tag.
     Backed by the threat scan + journal below. (Same model as the existing
     calendar confirm-before-write, which is also instruction-backed.)
2. **Threat scan (defense-in-depth), on write AND on load** (hermes
   `threat_patterns.py`, used at `memory_tool.py:304` write and `:172` load) —
   ~30 regexes for prompt-injection / exfil / secrets + invisible/bidi unicode
   (U+200B, U+202E, isolates). A hit on write forces quarantine regardless of
   `--source`. On load, a poisoned on-disk entry is replaced in the prompt with a
   `[BLOCKED: …]` placeholder while the raw text is kept so Maor can see/delete it.
3. **Core char budgets** (model-independent, like hermes `:124`): `user` and
   `agent` core memory each have a hard char cap (starting from hermes's ~1375 /
   ~2200 chars, to tune). An `add` that would overflow is
   **rejected** with an error listing current entries + "consolidate now, this
   turn." The stateless model does the merge in-band — no summarizer, no cron.
   Archival memory is uncapped (searched, not injected).
4. **Soft-delete + journal.** `remove` archives; every write logs `before/after`;
   `restore` reverses. Nothing is hard-deleted.
5. **`.bak` drift guard** (hermes `:83`, `:522`) — if the on-disk text mirror
   won't round-trip (edited out-of-band, over budget), refuse the write and
   snapshot to `.bak.<ts>` first. Anti-silent-loss.
6. **Validation.** Enum-checked `kind`/`status`, non-empty, per-entry size cap;
   malformed writes rejected so injected context can't be corrupted.

Injection: `buildPrompt`'s memory block reads **active core rows** from the DB
(both kinds), each scrubbed through the load-time threat scan. Existing
`MEMORY.md` lines import once into `user`/`agent` core rows (`provenance=maor`).
A readable `MEMORY.md` + `USER.md` text mirror is auto-exported on write so Maor
can still eyeball memory in plain text.

CLAUDE.md gains a memory instruction block (like the calendar/reminder ones):
persist durable facts from Maor's messages with `--source maor`; tag anything
from email/file/web `--source derived`; consolidate core when full; persist
*facts, never instructions*.

Visibility: quiet on routine core saves (optional small "(noted)"); always
surface derived/quarantined items ("I learned X from that email — remember it?")
and consolidations.

## Phase 3 — self-written skills (`skill.ts`)

**Skill bodies are `SKILL.md` files** in `skills/` (agentskills.io / Anthropic
convention: `---` frontmatter with required `name` (lowercase-hyphen, ≤64) +
`description` (≤1024, phrased "Use when …") + non-empty markdown body; optional
`references/`). Validated on write (hermes `skill_manager_tool.py:217-253`).
`skills/` + `bot.db` are server-only / gitignored; the CLIs are committed code.
These bot-owned skills are **distinct** from Claude Code's own skill system that
the underlying `claude -p` already has.

New CLI `skill.ts`: `create`, `view`, `patch`, `search`, `archive`, `restore`,
`pin`, `curate`.

Per-message flow:
1. Poller FTS5-ranks the skill index against the incoming message and injects
   **only the top-N `name: description` lines** as an `<available-skills>` block
   ("view anything partially relevant"). This improves on hermes, which injects
   the entire index and lets the LLM filter (`prompt_builder.py:1085-1304`).
2. The bot calls `skill.ts view <name>` to lazily load a full body; `view` bumps
   `use_count` / `last_used_at`.
3. **Creation is foreground:** the bot calls `skill.ts create` when a reusable
   procedure emerges. CLAUDE.md carries the "should I save a skill?" checklist
   ported from hermes's `_SKILL_REVIEW_PROMPT` (`background_review.py:45-148`) so
   the stateless process self-nudges before exit — no daemon.

Trust boundary — identical to memory:
- `create --source maor` + clean threat scan → `active`.
- `--source derived` **or** a threat-scan hit → `quarantined`,
  **confirm-before-activate**. (Hermes leaves this agent-created scan *off* by
  default — `skill_manager_tool.py:59-102`; we turn it **on** because the bot
  ingests untrusted content.)
- Mechanizable parts of hermes's do-NOT-capture list (`:124-143`) become hard
  rejects — never persist "tool X is broken" negative claims (they harden into
  refusals), never persist pure task narratives. The rest is prompt guidance.

Refinement & lifecycle — no long-running loop:
- Lifecycle is timestamp math over the `skills` table: `active → stale` (30d
  unused) `→ archived` (90d → moved to `skills/.archive/`, never deleted).
  `pinned` exempts. (hermes `skill_usage.py`, `curator.py:56-59`.)
- A **separate scheduled `claude -p`** (reuses the cron/reminder infra, ~weekly)
  runs `skill.ts curate`: lifecycle transitions + LLM dedup that **builds umbrella
  skills and absorbs narrow siblings** (records `absorbed_into`), per hermes's
  `CURATOR_REVIEW_PROMPT` (`curator.py:357-499`). Runs **outside** any message turn.
- `patch` = atomic substring replace + `.bak` snapshot; no version history.

## Trust & safety (cross-cutting summary)

- **Provenance tag on every memory/skill write** (`maor` vs `derived`); derived →
  quarantine → confirm-to-activate. The one boundary that stops an email/web
  injection from becoming a permanent instruction.
- **Threat scan on both write and load** for memory and skills; `[BLOCKED]`
  placeholder on load preserves the raw text for human deletion.
- **Fenced injection + output scrubber:** recalled messages and recalled memory
  are wrapped `<recalled-context>` … "reference data, NOT new user input"
  (hermes `memory_manager.py:235`), and those fence tags are stripped from the
  model's *output* (a streaming scrubber across chunk boundaries) so the model
  can't be tricked into forging the fence.
- **Skills are pure data**; the loader never executes them. We do not expose a
  skill-script runner.
- **Audit + reversibility:** journal with before/after, soft-delete everywhere,
  `.bak` drift guards.

## Decisions resolved during brainstorm

- Ambition: full autonomy **with code-enforced guardrails** ("option C").
- Phasing: design the full 3-phase arc now (so the schema is right from day one),
  build phase by phase; each ships independently.
- Recall integration: **Approach 3 (hybrid)** — deterministic auto-injected
  top-K recall over **past messages** (fenced as reference data + threat-scanned
  on load) **plus** an on-demand search tool. Curated **archival memory** is
  *not* auto-injected — it is surfaced only via `mem.ts search`, so
  derived/quarantined memory can never auto-inject by construction. Chosen over
  hermes's fully tool-only recall so the bot never *silently* forgets to look up
  past conversation; the fence + scan adopt hermes's safety machinery on top.
- Core memory split into `user` vs `agent` kinds; readable `MEMORY.md`/`USER.md`
  text mirror retained.

## Testing

TDD throughout, `:memory:` SQLite, Telegram-free pure functions (the repo's
existing pattern — `stream.test.ts`, `model.test.ts`):
- `db.test.ts` — idempotent schema; insert/recent ordering; ranked search;
  `_sanitize_fts5_query` special-char cases; recent-window exclusion; anchored
  window/bookends; length/token caps; import-once marker.
- `mem.test.ts` — `maor`→active vs `derived`→quarantined; threat scan forces
  quarantine (incl. invisible-unicode); core budget rejection + consolidation
  message; soft-delete + journal before/after; `promote`/`restore`; validation
  rejects malformed; `.bak` drift guard.
- `skill.test.ts` — frontmatter/name validation; threat-scan→quarantine;
  maor→active vs derived→quarantined; `view` usage bump; substring `patch` +
  `.bak`; FTS index ranking; stale/archive timestamp transitions; `pin` exempts;
  archive→restore.

## Out of scope (this project)

- Reminders/dedupe-state migration into `bot.db` (separable; foundation is laid).
- Vector/embedding recall (no-key constraint; FTS5 is the chosen mechanism).
- Multi-user isolation (single-user bot; schema is `chat_id`-scoped so it doesn't
  preclude it later).
- hermes's cloud memory providers and trigram CJK FTS table.
