# Phase 2 — guarded curation: build design

Date: 2026-06-09
Status: approved (brainstorm complete; ready for implementation plan)
Master spec: `2026-06-09-self-improving-memory-design.md` (§Phase 2, §Trust & safety, §Testing)

This doc records the build decisions for Phase 2 on top of the approved master
spec. Where the two overlap, the master spec's guardrail semantics are
authoritative; this doc settles scope, module boundaries, wiring, and the two
deferred items.

## Scope decision

Build **full Phase 2 in one slice** (Maor's call, 2026-06-09): all commands,
provenance quarantine, threat scan on write and load, char budgets with in-band
consolidation, soft-delete + journal, `.bak` drift guard, one-time import, and
the readable mirror.

**Except — two items are deferred** (see "Deferred" below): flipping the live
prompt to DB-backed memory, and the CLAUDE.md instruction that tells the bot to
write memory. Everything in this phase lands *dark*: the bot's runtime behavior
is unchanged until the cutover decision.

## Module layout

Mirrors the repo's existing CLI pattern (`remind.ts` thin CLI over tested
`reminders.ts` logic):

- **`db.ts`** (extend) — `initSchema` also creates `memory`, `memory_fts` (+
  sync triggers), and `journal`. Idempotent `CREATE … IF NOT EXISTS`, same as
  today. No changes to message/recall code.
- **`threats.ts`** (new) — the ported threat scan: `scanThreats(text)` returns
  the matched category or null. ~30 regexes ported from hermes
  `tools/threat_patterns.py` (prompt-injection, exfiltration, secrets) plus
  invisible/bidi unicode (U+200B/U+200C/U+200D, U+202A–U+202E, U+2066–U+2069,
  U+FEFF). Standalone so Phase 3's `skill.ts` reuses it unchanged.
- **`memory.ts`** (new) — pure tested logic: CRUD, provenance routing, budget
  checks, load-time scrub, journal writes, import, mirror export. Every
  function takes a `Database` argument (tests run on `:memory:`); mirror
  functions take a directory argument (tests use a temp dir).
- **`mem.ts`** (new) — thin CLI arg-parser delegating to `memory.ts`, shaped
  like `remind.ts`. Exits non-zero with a one-line error on any rejection so
  the bot sees exactly why a write was refused.
- Tests: `threats.test.ts`, `memory.test.ts`; `db.test.ts` gains schema cases.

## Data model

Per the master spec:

```
memory(id INTEGER PK, kind TEXT, content TEXT, provenance TEXT,
       status TEXT, reason TEXT, created_ts INTEGER, updated_ts INTEGER)
journal(id INTEGER PK, ts INTEGER, actor TEXT, action TEXT,
        target_table TEXT, target_id INTEGER, provenance TEXT,
        reason TEXT, before TEXT, after TEXT)
memory_fts — FTS5(content), rowid = memory.id, trigger-synced like messages_fts
```

- `kind` ∈ `user` (facts about Maor) | `agent` (the bot's operational notes).
- `provenance` ∈ `maor` | `derived`.
- `status` ∈ `active` | `quarantined` | `archived`.
  - `active` = core memory: budgeted, and (post-cutover) injected every turn.
  - `archived` = the archival store: uncapped, searched, never injected.
    `remove` moves rows here (soft-delete) — removed facts stay findable.
  - `quarantined` = held at the trust boundary: not injected, excluded from
    default `search`; visible via `list`.
- `journal` is append-only; every write records `before`/`after` snapshots.
  `actor` defaults to `bot` (a `--actor` flag covers manual/cron use).

## Commands (`mem.ts`)

```
add      --kind user|agent --source maor|derived --content "<text>"
replace  --old "<unique substring>" --new "<text>"        (edit by substring, not id)
remove   --old "<unique substring>" [--reason "<why>"]    (soft → archived)
search   <query>            (FTS5/BM25 over active+archived; never quarantined)
list     [--status active|quarantined|archived] [--kind user|agent]
show     <id> [--raw]       (one entry; --raw bypasses the load scrub — for Maor's
                             inspection of a [BLOCKED] row, per master spec)
promote  <id>               (quarantined → active; budget-checked at promote time)
restore  <id>               (archived → active; budget-checked)
```

`show` is the one addition beyond the brainstormed list — it implements the
master spec's "raw text is kept so Maor can see/delete it" without dumping raw
quarantined text into routine `list` output.

`replace`/`remove` resolve their target by a short substring that is unique
across entries' `content` (hermes `memory_tool.py:349`); zero or multiple
matches → error listing candidates.

## Guardrails

Semantics per master spec §Phase 2; concrete values:

1. **Provenance.** `--source maor` → `status=active`. `--source derived` →
   forced `quarantined` until `promote`. The CLI trusts the tag (it cannot see
   true provenance); the threat scan and journal back it up.
2. **Threat scan on write.** Any hit forces `quarantined` regardless of
   `--source`, with the matched category recorded in `reason`.
3. **Threat scan on load.** Applied on every read path whose output can enter
   the bot's context — `search`, `list`, `show` (without `--raw`), and the
   future prompt injection. A poisoned row renders as
   `[BLOCKED: <category> — id <n>]`; raw text stays in the DB.
4. **Char budgets** (core = `active` rows, per kind): `user` 1375, `agent`
   2200 chars (hermes defaults; env-tunable via `MEM_USER_BUDGET` /
   `MEM_AGENT_BUDGET`). An `add`/`promote`/`restore` that would overflow is
   rejected; the error lists current entries with sizes and instructs:
   consolidate now, this turn (`replace`/`remove`, then retry). No background
   summarizer.
5. **Per-entry cap:** 500 chars (`MEM_ENTRY_MAX`). Validation also enum-checks
   `kind`/`source` and rejects empty content.
6. **Soft-delete + journal.** Nothing is hard-deleted; every mutation journals
   `before`/`after`; `restore` reverses a `remove`.
7. **`.bak` drift guard** (mirror files): before overwriting a mirror, verify
   the on-disk file matches the last export (hash recorded in `meta`). If it
   was edited out-of-band, snapshot it to `<file>.bak.<ts>` first, then write.

## Import and mirror

- **Import:** one-time, marker-guarded (`meta` key `memory_md_imported`),
  journaled. Each non-empty line/bullet of the current `memory/MEMORY.md`
  becomes one `kind=user, provenance=maor, status=active` row. The file itself
  is not modified — the poller keeps reading it during the hold. Import is
  exempt from the per-entry cap and the core budget: it must mirror today's
  reality without data loss even if the file already exceeds the budget. The
  budget then applies to the next write, which is where consolidation gets
  forced.
- **Mirror:** on every successful write, export readable text mirrors —
  `USER.md` (kind=user) and `MEMORY.md` (kind=agent), each listing active rows
  (and a short quarantined section so pending items are visible). **During the
  deferred period mirrors are written to `memory/mirror/`**, never to the live
  `memory/MEMORY.md` — otherwise the export would silently change the live
  prompt through the file the poller reads. Final file naming/location is part
  of the cutover decision.

## Deferred (decide before wiring the poller)

1. **Live-injection cutover** — `poller.ts` `loadMemory()` currently reads the
   flat `memory/MEMORY.md` and is left untouched this phase. The flip to
   DB-backed, load-scanned core injection is a separate decision with three
   candidate rollouts (direct + file fallback / shadow-then-flip / hard
   cutover). Maor explicitly put this on hold (2026-06-09).
2. **CLAUDE.md memory instructions** — the block telling the bot to persist
   facts via `mem.ts` ships together with the cutover, not before; otherwise
   writes accumulate in a store the prompt never shows. Until then `mem.ts`
   exists for manual/testing use.

## Visibility

- Routine `maor` core saves: silent (no chat noise) — post-cutover this only
  matters once the CLAUDE.md block lands.
- Always surface in chat: anything `derived`/quarantined ("I learned X from
  that email — want me to remember it?") and any forced consolidation.

## Testing

TDD on `:memory:` SQLite, matching `db.test.ts` style:

- `threats.test.ts` — per-category positive/negative cases; invisible/bidi
  unicode detection; clean text passes.
- `memory.test.ts` — provenance routing (maor→active, derived→quarantined);
  write-scan forces quarantine; load-scrub renders `[BLOCKED]` and `--raw`
  bypasses it; budget rejection message lists entries (add, promote, restore
  paths); per-entry cap + enum validation; substring resolve (unique / none /
  ambiguous); soft-delete → archived + journaled before/after; promote/restore
  transitions; search excludes quarantined; import once (marker), journaled,
  line-per-row; mirror export content + `.bak` drift guard.
- `db.test.ts` — new tables/triggers exist and are idempotent.

## Porting sources

Hermes clone (MIT) at `%TEMP%\hermes-agent`, verified present 2026-06-09:
`tools/threat_patterns.py` (12 KB), `tools/memory_tool.py` (30 KB),
`hermes_state.py`. Ideas/algorithms are reimplemented in TypeScript; if any
substantial block is adapted verbatim, retain MIT attribution per master spec.
