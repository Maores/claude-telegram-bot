# Phase 3 (core) — self-written skills: build design

Date: 2026-06-10
Status: approved (brainstorm complete; ready for implementation plan)
Master spec: `2026-06-09-self-improving-memory-design.md` (§Phase 3, §Trust & safety)
Builds on: Phase 2 memory (merged to `main`) and `threats.ts` (reused as-is).

Records the build decisions for Phase 3 on top of the approved master spec.
Where they overlap, the master spec's semantics are authoritative; this doc
settles scope, module boundaries, the data model, and what's deferred.

## Scope decision

Build the **core loop only** (Maor's call, 2026-06-10): the bot creates, finds,
and re-uses its own skills, behind the same code-enforced trust boundary as
memory.

**Deferred to a follow-up (Phase 3.1):** the weekly scheduled `claude -p`
**curator** — automatic lifecycle transitions (active→stale→archived by
timestamp) and LLM dedup that merges duplicate skills into umbrella skills.
`pin` (which only exists to exempt skills from that auto-lifecycle) defers with
it. Manual `archive`/`restore` stay in core.

## Lands dark

Like the Phase 2 build, this phase makes **no change to `poller.ts`** — nothing
touches the live bot. `skill.ts` works for manual/testing use, and the
`skillsIndexBlock()` renderer is built and unit-tested, but the per-message
injection wiring and the CLAUDE.md "save a skill when…" instruction flip on at a
**cutover**, bundled with (or right after) the already-pending Phase 2 memory
cutover. So this build changes nothing the live bot does.

## Module layout

Mirrors the Phase 2 split (`mem.ts` thin CLI over tested `memory.ts`):

- **`db.ts`** (extend) — `initSchema` also creates `skills`, `skills_fts`
  (FTS5 over name+description+tags, + sync triggers). Idempotent `IF NOT EXISTS`.
- **`skills.ts`** (new) — pure logic over a `Database` + a skills directory
  (tests use `:memory:` + a temp dir): SKILL.md frontmatter parse/validate,
  create/view/patch/search/list/archive/restore/activate, the trust scan
  (reuses `threats.ts`), do-NOT-capture hard rejects, and the
  `skillsIndexBlock(db, query, n)` renderer.
- **`skill.ts`** (new) — thin CLI arg-parser delegating to `skills.ts`, same
  shape as `mem.ts` (guarded by `import.meta.main`, `parseFlags`, MemoryError-
  style exit-1 on rejection).
- Tests: `skills.test.ts`.

## Data model — `skills` table

```
skills(
  id INTEGER PK, name TEXT UNIQUE, description TEXT, tags TEXT,
  path TEXT,                       -- the SKILL.md file path under skills/
  provenance TEXT,                 -- maor | derived
  status TEXT,                     -- active | quarantined | archived
  use_count INTEGER DEFAULT 0, last_used_at INTEGER,
  patch_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
  created_by TEXT, created_ts INTEGER, updated_ts INTEGER
)
skills_fts — FTS5(name, description, tags), rowid = skills.id, trigger-synced
```

Skill **bodies live as `SKILL.md` files** in `skills/` (server-only, gitignored,
same trust zone as `bot.db`); the table is just the searchable index + usage.
`status` mirrors memory: active = injectable/searchable; quarantined = held at
the trust boundary (excluded from index + search); archived = soft-deleted (file
moved to `skills/.archive/`, never hard-deleted).

## SKILL.md format (agentskills.io / Anthropic convention)

`---` frontmatter with required `name` (lowercase-hyphen, ≤64 chars, unique) +
`description` (≤1024 chars, phrased "Use when …") + a non-empty markdown body.
Optional `references/` dir. Validated on every write (port of hermes
`skill_manager_tool.py:217-253`); malformed → rejected with a clear error.

## Commands (`skill.ts`)

```
create   --name <slug> --desc "Use when …" --source maor|derived [--tags "a,b"] --body "…"   (or --body-file <path>)
view     <name>                  (prints the body; bumps use_count + last_used_at; active only)
search   <query…>                (FTS5/BM25 over active skills; never quarantined/archived)
list     [--status active|quarantined|archived]
patch    --name <slug> --old "<unique substring>" --new "<text>"   (atomic body edit + .bak snapshot; bumps patch_count)
archive  <name>                  (soft; moves the file to skills/.archive/)
restore  <name>                  (archived → active)
activate <name>                  (quarantined → active; re-scans the body at activation, like promoteMemory)
```

## Trust boundary (identical to memory)

1. **Provenance.** `create --source maor` + clean threat scan → `active`.
   `--source derived` **or** a threat-scan hit (name+description+body scanned at
   `"strict"` via `threats.ts`) → forced `quarantined`, not injected, until
   `activate` — which **re-scans the body** at activation (defense-in-depth,
   same as `promoteMemory`/`restoreMemory`). The CLI trusts the `--source` tag;
   the scan + the activate gate back it up.
2. **do-NOT-capture hard rejects** (mechanizable parts of hermes
   `:124-143`): `create`/`patch` reject content that is a negative tool claim
   ("X is broken / doesn't work" — these calcify into refusals) or a pure
   task-narrative (no reusable procedure). Rejected with an explanatory error.
3. **Index/search show active only.** `skillsIndexBlock` and `search` filter to
   `status='active'`; quarantined and archived skills never reach the prompt.
   `view` serves active skills only (a quarantined skill must be activated
   first), so an unconfirmed derived body can't be pulled into context.
4. **Validation.** Frontmatter rules above; unique name; non-empty body;
   per-field caps. Malformed writes rejected.

## The `<available-skills>` injection (built now, wired at cutover)

`skillsIndexBlock(db, query, n)`: sanitize `query` (reuse `sanitizeFtsQuery`),
FTS5-rank active skills, return the top-N as a fenced block of
`- name — description` lines (improves on hermes, which injects the whole
index). Built and unit-tested in this phase; the poller call + injection is
deferred to the cutover. `n` defaults to a small number (≈5, env-tunable
`SKILLS_TOP_N`).

## Testing (TDD, `:memory:` + temp dir, like `memory.test.ts`)

`skills.test.ts`:
- frontmatter validation (name slug/length, description length + "use when",
  non-empty body) accepts valid / rejects each malformed case;
- create `maor`→active vs `derived`→quarantined; threat-scan (incl. invisible
  unicode in body) forces quarantine; do-NOT-capture rejects;
- `view` returns the body and bumps `use_count`/`last_used_at`; refuses a
  quarantined skill;
- `search` ranks by relevance and excludes quarantined + archived; Hebrew query;
- `patch` substring edit + `.bak` snapshot + `patch_count` bump; ambiguous/none
  substring → error;
- `archive` moves the file to `skills/.archive/` and flips status; `restore`
  reverses; `activate` quarantined→active re-scans (a poisoned body stays
  blocked);
- `skillsIndexBlock` returns top-N active `name — description`, excludes
  quarantined, empty when none.

## Porting sources

hermes clone (MIT) at `%TEMP%\hermes-agent`: `tools/skill_manager_tool.py`
(frontmatter validation, create, do-NOT-capture list), `tools/skill_usage.py`
(use tracking). Ideas reimplemented in TypeScript; `threats.ts` reused directly.

## Out of scope (this phase → Phase 3.1)

The scheduled `claude -p` **curator** (`curator.py` port): automatic
active→stale→archived lifecycle by timestamp, LLM dedup into umbrella skills
(`absorbed_into`), and `pin` to exempt skills from it. Runs outside any message
turn via the existing cron/reminder infra. Built once the core loop is proven.
