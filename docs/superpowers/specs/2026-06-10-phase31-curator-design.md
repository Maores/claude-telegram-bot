# Phase 3.1 — weekly skills curator: build design

Date: 2026-06-10
Status: built (same session as design; see `skills.test.ts` "stale lifecycle")
Master spec: `2026-06-09-self-improving-memory-design.md` (§Refinement & lifecycle)
Builds on: Phase 3 core (`skills.ts`, merged + deployed) and the `[AUTO]`
reminder mechanism (reminders whose text starts with `[AUTO] ` run as a Claude
prompt at fire time).

## What ships

1. **Three polish items from the Phase 3 final review** (all gates code-side):
   - `tags` are now threat-scanned at create AND at activate (they reach the
     prompt via the index, so they're scan surface like name/description/body).
   - `patchSkill` is scoped to the BODY: the match runs against the parsed body
     only, and the file is re-rendered from the original frontmatter — a patch
     can no longer corrupt `name:`/`description:` (whose FTS index deliberately
     has no UPDATE trigger).
   - A patch re-runs the create-time gates on the patched body (parse
     validation, do-NOT-capture, threat scan) BEFORE the `.bak` snapshot and
     write — a rejected patch leaves no trace on disk.

2. **`stale` lifecycle** (status set is now active | stale | quarantined |
   archived):
   - Idle clock = `now - (last_used_at ?? created_ts)`.
   - `curate`: active + idle ≥ 30d → `stale`; stale + idle ≥ 90d → `archived`
     (file moved to `skills/.archive/`, never deleted). Env-tunable via
     `SKILL_STALE_DAYS` / `SKILL_ARCHIVE_DAYS`.
   - **One transition per skill per run** — the archive pass walks the
     previously-stale set before the stale pass runs, so even an ancient skill
     takes two weekly runs to reach the archive (no surprise mass-archive on the
     first run over an old library).
   - **Stale skills stay searchable and in the index block, and `view` revives
     them to active.** Decision rationale: if stale skills vanished from search,
     nothing could ever bump their usage and the 30→90d window would just be a
     delayed delete. Keeping them discoverable makes the lifecycle self-healing:
     a genuinely relevant skill resurfaces, gets viewed, and lives. The trust
     boundary is unchanged — stale skills passed the same gates as active ones;
     quarantined/archived remain invisible.

3. **`pin` / `unpin`** — pinned skills are exempt from both curate transitions
   (reported in the curate output as `pinned exempt`). Pin works on active/stale
   only; quarantine is a trust state, not a lifecycle state.

4. **`absorb <narrow> --into <umbrella>`** — the LLM-dedup primitive: archives
   the narrow skill and records `absorbed_into` (new nullable column, additive
   `ALTER TABLE` migration guarded by `PRAGMA table_info`). The curator session
   itself creates/patches the umbrella skill first via the normal gated
   `create`/`patch` commands, then absorbs the narrow ones. Restorable like any
   archived skill.

## Scheduling — reuses the `[AUTO]` reminder infra

No new cron plumbing. The weekly curator is a repeating `[AUTO]` reminder whose
prompt tells the session to run `bun run skill.ts curate`, then review the
active list for duplicates (view → create umbrella → absorb), then send Maor a
short Hebrew report. The deterministic transitions are code (`curateSkills`);
the LLM judgment (what is a duplicate, how to merge) lives in the prompt; every
write it can make still passes the same code-enforced gates as any other skill
write.

## Out of scope

- Auto-archive of quarantined skills (they are Maor's confirmation queue).
- Skill journaling (YAGNI, unchanged from Phase 3 core).
