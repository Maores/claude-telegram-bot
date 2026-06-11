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

## Phase 4 — Protection floor

The safety story. Mostly testable dark, small diffs, high CV value.

- **Hardline command blocklist** (hook + `guard.ts`): catastrophic shell
  commands (`rm -rf /`, `mkfs`, `dd` to devices, fork bombs, shutdown, SSH/env
  tampering) refused in code, fail closed — even in full-permission mode.
- **Least-privilege `[AUTO]` sessions**: unattended runs can't schedule more
  reminders (self-replication), file drafts, or touch guard/config files.
- **Secret redaction** on the output path: tokens/keys masked before any reply
  or log line leaves the bot.

## Phase 5 — Feel

What makes it pleasant to use, every single day.

- **Reaction acks + typing**: 👀 when it starts working on your message,
  👍/👎 on finish/fail, typing bubble while thinking.
- **`/stop`**: interrupt a runaway answer (today nothing can).
- **Inline buttons** for the existing confirm flows (calendar/email "yes / no /
  change") — needs callback-query support in the poller, which also unlocks
  approval buttons for Phase 4's guard later.
- **Reminder follow-ups** (Maor's request, 2026-06-11): after a reminder fires,
  the bot checks back whether the task actually got done — inline buttons like
  "done ✓" / "remind me again later". "Done" closes the loop; "later"
  reschedules; either way no duplicate reminders pile up on the same topic.
  Design talk pending: when the follow-up fires (immediately vs. after a while),
  snooze intervals, and how it treats repeating reminders. First real consumer
  of the callback-query infra above.

## Phase 6 — Voice

The biggest daily-life upgrade; needs server-side setup (whisper.cpp + ffmpeg).

- **Voice notes in**: speak to the bot; transcript injected like a typed
  message.
- **Voice replies out** (later): answers as Telegram voice bubbles via keyless
  TTS.

## Phase 7 — Self-driving

Completes the self-improving story and makes automation cheap.

- **Background review loop**: after a conversation, a restricted cheap session
  asks "anything worth remembering / saving as a skill?" and writes through the
  existing gates. The storage and the cleaner exist; this is the part that
  fills the box unprompted.
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
