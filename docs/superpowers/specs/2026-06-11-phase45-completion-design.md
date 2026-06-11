# Phase 4 completion + Phase 5 core + Phase 7 head start — build design

Date: 2026-06-11
Status: approved (brainstorm complete; Maor answered the five design questions)
Roadmap: `docs/ROADMAP.md` — finishes Phase 4 (redaction), builds Phase 5's
buttons + reminder follow-ups, and pulls Phase 7's background review loop
forward. Survey references: `docs/research/2026-06-10-hermes-feature-survey.md`
§A3 (redaction), §D1/D3 (buttons), §C1 (review loop).

## Decisions (Maor, 2026-06-11)

1. Follow-up buttons appear **on the reminder itself AND** an automatic nudge
   fires if untouched for ~1 hour ("Both").
2. "Remind me later" swaps the buttons for **quick snooze picks**:
   [+1 שעה] [הערב 20:00] [מחר 09:00].
3. **One-time reminders only** get follow-ups. Repeating reminders and `[AUTO]`
   jobs are excluded.
4. Review loop is **quiet + nightly digest**: silent saves (quarantine still
   pings as today); the 20:35 daily summary gains a "מה למדתי היום" line.
5. Review loop cadence: **cooldown** — after a reply, at most once per 15
   minutes, on a cheap (haiku-class) model.

## Feature 1 — redaction (`redact.ts`), finishes Phase 4

Two layers, one pure function `redact(text: string): string`:

- **Exact-value layer:** at startup, collect the values of every env var whose
  NAME matches `/TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE/i` (8+ chars
  long). Any literal occurrence of one of those values in outgoing text becomes
  `[REDACTED]`. Zero false positives, catches the bot's actual secrets
  (`TELEGRAM_BOT_TOKEN`, `ICLOUD_APP_PASSWORD`) even when read from a file.
- **Pattern layer:** vendor-prefix regexes — `sk-…`, `ghp_…`/`gho_…`,
  `xox[abps]-…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----` blocks, and
  `Bearer <long-token>` — masked preserving a 4-char tail for identification
  (e.g. `[REDACTED…a1b2]`).

Enforcement chokepoints:

- inside `tg()` for every outgoing `text`/`caption` param — every message the
  bot sends passes through there; and
- a `redactLog()` wrapper used by the poller's `[MSG]`/`[REMIND]`/`[ERR]`
  console lines.

The env snapshot is taken once at import (an LLM-driven `export` can't disable
it mid-session — hermes `agent/redact.py` lesson). Callback data, button labels
and reminder ids are not user content and skip redaction.

## Feature 2 — callback queries + reminder follow-ups (Phase 5 core)

### Poller: callback-query support (shared infra)

- `getUpdates` handling gains an `update.callback_query` branch alongside
  `update.message`: ACK immediately via `answerCallbackQuery` (Telegram shows a
  spinner otherwise), allowlist-check the presser's chat id like messages, then
  route by `callback_data` prefix. Unknown prefixes are ACKed and dropped
  (forward compatibility: calendar confirms, guard approvals later).
- `callback_data` protocol (≤64 bytes, Telegram limit): `fu:<action>:<id>`
  where action ∈ `done | later | s1h | seve | stom`.

### Reminders: follow-up lifecycle (in `reminders.ts` + `reminders.json`)

- `popDue()` callers learn whether each fired reminder was one-time; for those,
  the poller sends the reminder WITH an inline keyboard
  `[בוצע ✓] [תזכיר לי שוב]` and records a followup:
  `{ id, chatId, text, messageId, firedAt, status: "pending", nudged: false }`
  in a `followups` array inside the same JSON file (same atomic write path).
- Button flows (all edit the original message via `editMessageReplyMarkup` /
  `editMessageText`):
  - **בוצע** → status `done`, buttons removed, text gains " — ✓ בוצע".
  - **תזכיר לי שוב** → buttons swap to `[+1 שעה] [הערב 20:00] [מחר 09:00]`.
  - **snooze pick** → `addOnce()` a new one-time reminder with the same text at
    the picked moment (+1h; today 20:00 — if already past, tomorrow 20:00;
    tomorrow 09:00), status `snoozed`, buttons removed, text gains
    " — נדחה ל…". The new reminder gets its own follow-up when IT fires.
  - Pressing a button on an already-resolved follow-up just ACKs (idempotent).
- **Nudge:** the existing 30-second reminder tick also scans `followups`: any
  `pending` with `firedAt + 60min < now` and `nudged: false` gets ONE nudge —
  a NEW message "עדיין רלוונטי? ⏰ <text>" carrying the same buttons (the
  follow-up's `messageId` switches to the nudge message), `nudged: true`. A
  pending follow-up never nudges twice; `done`/`snoozed` never nudge.
- Retention: resolved follow-ups older than 7 days are pruned on write.

## Feature 3 — background review loop (Phase 7 head start)

- **Trigger:** in `handleMessage`, after the reply is delivered and persisted:
  if `now - lastReviewAt(chatId) ≥ 15 min`, spawn the review DETACHED (never
  awaited, never delays the user; failures only log). In-memory cooldown map —
  a poller restart resetting the clock is acceptable.
- **Spawn:** `claude -p --model haiku` with tools whitelisted to exactly
  `Bash(bun run mem.ts *)` and `Bash(bun run skill.ts *)` (flag syntax verified
  against the installed CLI during implementation, same discipline as
  `--disallowedTools` in PR #9), plus `CLAUDE_AUTO_SESSION=1` so the guard
  hook's least-privilege layer applies. Its stdout is discarded; exit code and
  a one-line result are logged.
- **Prompt** (lives in `review.ts` with the spawn helper, exported + tested):
  the last ~10 exchanges of that chat (from `recentMessages`), then a port of
  hermes's review rules: save durable FACTS about Maor via `mem.ts add`
  (provenance `maor` for things Maor said about himself; `derived` for
  anything that came from outside content — quarantine does the rest); save or
  PATCH skills via `skill.ts` only for reusable procedures that worked;
  corrections from Maor ("תפסיק…", "אל תעשה…", "too verbose") are first-class
  skill/memory material; prefer patching an existing skill over creating a
  near-duplicate (search first); never save one-off narratives or negative
  tool claims (the CLIs reject them anyway); if nothing qualifies, do nothing
  and exit. Hebrew content stays Hebrew.
- **Nightly digest (no code):** during deploy, the r8 daily-summary reminder
  text on the droplet gains: "בסוף, אם נוספו היום זיכרונות או כישורים (בדוק
  בטבלת journal של bot.db מאז חצות), הוסף שורה קצרה: 'מה למדתי היום: …'".
- **Cost note:** haiku-class, ≤1 run per 15 min, only after real conversations
  — worst case a few dozen cheap calls/day, typically a handful.

## Build order (each branch off the previous merge, all TDD)

1. `feat/redaction` — `redact.ts` + tests; wire `tg()` + log lines. PR.
2. `feat/reminder-followups` — callback infra + follow-up lifecycle + nudges +
   tests (clock injected via `now` params, as the codebase already does). PR.
3. `feat/review-loop` — `review.ts` (prompt + spawn opts + cooldown) + poller
   trigger + tests. PR.
4. Deploy once: pull, restart poller, edit r8's prompt server-side, live-verify
   (reminder with buttons end-to-end, redaction probe, review fires after a
   real message).

## Testing

- `redact.test.ts`: env-value masking (incl. value-appears-in-multiline),
  vendor patterns, tail preservation, no-op on clean text, snapshot-at-import.
- `reminders.test.ts` additions: follow-up creation on one-time fire only;
  done/later/snooze transitions; idempotent double-press; single nudge; prune.
- `poller.test.ts` additions: callback_data parse/route helpers; snooze time
  math (evening/tomorrow edge cases); review cooldown gate; review prompt
  contains the rules and the transcript.

## Out of scope (unchanged roadmap items)

Calendar/email confirm buttons (next consumer of the callback infra), guard
approval buttons, non-blocking message loop (true mid-answer /stop), voice,
webhooks, migrating reminders to SQLite.
