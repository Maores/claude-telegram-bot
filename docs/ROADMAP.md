# Roadmap — 24/7 assistant agent

The goal: a 24/7 personal assistant agent on Telegram, feature-rich and
engineered well enough to stand as a portfolio piece. Sequencing principle:
**protect before empowering** — the bot already holds email, calendar, and
shell access on its own server, so the safety floor comes before new limbs;
then daily feel, then autonomy, then the outside world.

Feature analysis behind this ordering: `docs/research/2026-06-10-hermes-feature-survey.md`.

## Done

- **Phase 1 — Recall** (2026-06-09): SQLite + FTS5 message history, relevant
  past messages auto-injected into every prompt.
- **Phase 2 — Guarded memory** (2026-06-10): curated core memory with
  provenance (maor/derived), quarantine, threat scan on write+load, budgets,
  journal, `mem.ts` CLI. Live.
- **Phase 3 — Self-written skills** (2026-06-10): SKILL.md library + FTS index,
  trust gates, top-N suggestion injection, `skill.ts` CLI. **3.1**: stale/archive
  lifecycle curator + pin + absorb (weekly run built, not yet scheduled). Live.
- **Side quests** (2026-06-10): `[AUTO]` reminders (scheduled prompts — nightly
  summary runs on it), Gmail drafts two-step flow (compose → approve → draft in
  real Gmail; no send tool exists by design), bot self-created its first skill.

## Phase 4 — Protection floor — DONE (2026-06-11)

- ~~Hardline command blocklist~~ (`guard.ts` + PreToolUse hook, wired on the
  droplet via server-side settings.local.json; live-verified).
- ~~Least-privilege `[AUTO]` sessions~~ (`--disallowedTools` + guard env flag).
- ~~Secret redaction~~ (`redact.ts` at the `tg()` chokepoint + log lines;
  live-verified — a fired reminder containing a fake key logged as
  `[REDACTED…3456]`). PR #11.

## Phase 5 — Feel — core DONE (2026-06-11)

- ~~Reaction acks + typing~~: 👀 → 👍/👎 + typing bubble. PR #10.
- ~~`/stop`~~ (kills background `[AUTO]` runs immediately; a mid-answer /stop
  is read only after the answer — true interruption needs the non-blocking
  loop, still open below). PR #10.
- ~~Callback-query infra + reminder follow-ups~~: one-time reminders carry
  [בוצע ✓][תזכיר לי שוב]; snooze picks +1h/הערב/מחר; one nudge after an hour;
  collision-proof ids. PR #12.
- Still open in this phase: **confirm buttons** for calendar/email flows and
  **guard approval buttons** (the callback infra is ready for them); the
  **non-blocking message loop** for true mid-answer /stop.

## Phase 6 — Voice

- ~~**Voice notes in**~~ — DONE (2026-06-11, PR #14, deployed): voice bubble →
  Groq-hosted whisper-large-v3-turbo (free tier; the 1 GB droplet can't hold
  the Hebrew-tuned local models) → transcript flows in like a typed message;
  🎤 transcript echo when confidence is low; swappable `transcribe.ts` backend
  keeps the keyless whisper.cpp option alive (DEPLOY.md step 7b).
- **Voice replies out** (later): answers as Telegram voice bubbles via keyless
  TTS.

## Phase 7 — Self-driving

Completes the self-improving story and makes automation cheap.

- ~~**Background review loop**~~ — DONE (2026-06-11, PR #13, pulled forward):
  after replies, a detached haiku session whitelisted to `mem.ts`/`skill.ts`
  persists facts/procedures through the existing gates (15-min cooldown; quiet;
  the nightly summary now carries a "מה למדתי היום" digest line).
- **Scheduler upgrades**: pre-check scripts with a wake gate (watch something,
  wake Claude only on change), `[SILENT]` runs, job chaining — with a fire-time
  injection scan.
- **History search CLI**: deliberate "what did we decide about X?" digging to
  complement automatic recall.
- Install the weekly skills-curator reminder once skills accumulate.

## Phase 8 — Outside world & ops

- **Webhooks**: HMAC-signed events (e.g. GitHub push/CI) trigger the bot.
- **Job-finished alerts**: long server tasks report back when done.
- **`/usage`**: cost/usage analytics from claude's own JSON output.
- **`/update`**: pull + restart from the phone, with crash forensics on boot.

## Deliberately not doing

Multi-user pairing, kanban/worker fleets, browser automation, external memory
providers, image-gen/X-search (extra API keys), programmatic tool calling —
surveyed and rejected as poor fits for a single-user bot (see the survey's §G).
