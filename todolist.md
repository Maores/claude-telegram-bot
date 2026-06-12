# Project todo / tracker

Tracker for the Claude Telegram agent — features, bugs, and things to notice.

## Done
- [x] **Streaming responses (Approach A)** — live `💭 thinking…` / `🔍 tool…` status then progressive
  text via `claude -p` stream-json + ~1.5s throttled Telegram edits; handles 4096 overflow and
  "not modified". `stream.ts` parser is unit-tested. Deployed and verified working.
- [x] **Model routing** — default Sonnet, escalate to Opus via `/opus` (stripped) / `/sonnet` /
  keywords / code blocks. Cheap explicit+heuristic routing, no LLM classifier. `model.ts` unit-tested.
  Deployed and verified (noticeably faster default replies).

## Done (calendar)
- **iPhone/iCloud calendar** (CalDAV via `tsdav` + `node-ical`, built ourselves). Creds in server `.env`
  (`ICLOUD_USER` / `ICLOUD_APP_PASSWORD`). All three phases LIVE & verified against the real calendar:
  - [x] Phase 1: connection + read. `calendar.ts` + `cal.ts list`, parser tested.
  - [x] Phase 2: proactive nudges (~15 min before events). Poller scans every 5 min, sends
    `🔔 In N min — <title>`, dedupe via `cal_notified.json`.
  - [x] Phase 3: add / edit / delete — confirm-before-write. `cal.ts add/find/edit/delete`;
    `buildVEvent` (RFC-5545, tested), `createEvent`/`updateEvent`/`deleteEvent`, edit refuses recurring
    events. Verified live with a create→edit→delete arc on a throwaway event.
  - [x] Fixed a timezone bug found during Phase 3 testing: the old `date -u -d '<local>'` idiom in
    CLAUDE.md parsed the input as UTC (events landed 3h off). Switched to the offset form
    `date -d '<local>' +%Y-%m-%dT%H:%M:%S%:z` and added `toUtcZ()` so `listEvents` normalizes any input.
  - [x] Fixed the all-day edit day-shift (2026-06-12, PR #22, found by the tasks-feature review):
    node-ical parses `VALUE=DATE` at local midnight while `buildVEvent` re-emits via UTC-getter
    `fmtDate`, so every chat edit of an all-day event moved it one day back. `parseEvents` now
    normalizes all-day start/end to UTC midnight (the tasks.ts pattern) and `fmtEvent` renders
    all-day days via UTC getters. Live-verified with a create→edit→delete arc on a throwaway event.
    (Masked locally: Bun forces TZ=UTC in tests on Windows.)

## Done (media input)
- [x] **Photo & document understanding** — send a photo or document (PDF, etc.) → it's downloaded from
  Telegram into `./uploads` and its local path handed to Claude, which reads it with its own Read tool
  (Pro plan, no API). Captions are the accompanying words (still honoring `/opus`); text-only messages
  unchanged. Shipped via PR #1 plus a hardening pass — pre-download size cap (~20MB) with a clear message,
  download timeout, delete-after-reply + a startup orphan sweep of `./uploads`, filename injection-hardening,
  Unicode-safe (Hebrew) on-disk names, and an honest decline/notice for media we can't open (video / voice /
  audio / GIF / sticker). `poller.ts` helpers unit-tested (16 new tests; suite 70). Deployed and verified live.

## Roadmap (prioritized 2026-06-08)
Picked from the feature brainstorm. Numbered = urgency order within each group (1 = next up).

### Useful day-to-day
(Photo understanding + PDF/document Q&A shipped — see "Done (media input)" above.)
1. [ ] Email triage + reply drafting — flag emails that look like they need a reply; draft responses on
   request (drafts only, Maor sends). Reuses the nudge-loop pattern.
2. [ ] Spoken replies out — answer with a voice message via TTS (engine or API). Lower priority.

### Smarter memory & data
1. [ ] RAG long-term memory — embed past chats/notes into a vector store, retrieve relevant bits per query.
   Needs an embeddings source (small local model or an embedding API; the claude CLI doesn't expose embeddings).
2. [ ] SQLite migration — move history + reminders + dedupe state from JSON to SQLite (schema + migrations;
   removes the reminders.json write race; foundation for RAG + metrics).
3. [x] Natural-language task list — SHIPPED 2026-06-12 (PR #21), deployed + live-verified on the droplet
   (full add→snooze→edit→done→delete arc against the real "תזכורות" list; tasks sync to the iPhone over
   the calendar's iCloud CalDAV — feasibility confirmed 2026-06-08 held up). `tasks.ts` + `todo.ts`
   mirror the calendar pair; routing: timed "remind me" stays a Telegram ping, task/list phrasing →
   Apple Reminders; only delete is confirm-gated. Gotchas recorded in spec/plan/memory: tsdav's
   VEVENT-only default fetch filter (VTODO needs an explicit comp-filter), no timeRange on todo fetches
   (RFC 4791 drops DUE-less todos), node-ical crash on RRULE-without-DTSTART (Apple's recurring shape),
   and VALUE=DATE local-midnight normalization — the same bug then found and fixed in calendar.ts (PR #22).

### Production maturity (engineering signal)
1. [ ] Security hardening — ufw, fail2ban, secrets out of plaintext, prompt-injection test suite for the
   email/file "untrusted data" boundary.
2. [ ] CI/CD (GitHub Actions) — run `bun test` on every push, auto-deploy to the droplet on green.
3. [ ] Observability — structured JSON logs + a `/status` command (uptime, last error, model usage, metrics).

### הדרכת חבר — Onboarding Guide for Similar Bot — DONE 2026-06-12
Delivered as `docs/FEATURES-INSTALL-GUIDE.md`: ONE fully self-contained doc (Maor's call — no repo
digging needed; everything inline, per-feature isolation via strictly independent sections). 14
features, dependency-ordered menu + install order, key code excerpts, and every live-found gotcha
(.oga/FormData, 409 wars, FTS5 UPDATE trap, timezone, lockfile, hook fail-closed…). The "wizard"
became the doc's usage prompt: the friend's own Claude Code detects what exists, interviews him,
and installs the delta. (The auto-compare CLI idea stayed unbuilt — YAGNI.)
- [x] **Feature-diff onboarding wizard** — חבר הכין סוכן Telegram דומה אך חסרים לו פיצ'רים. יצור מסמך/סקריפט
  אינטראקטיבי שישאל את החבר אילו פיצ'רים כבר קיימים אצלו, ואז יציג רק את ה-delta: פיצ'רים שחסרים,
  ואיפה שיש הבדל — יציג את השינויים שבוצעו כאן יחד עם הסבר למה. הגישה המומלצת:
  1. תעד את כל הפיצ'רים המעניינים שנוספו לפרויקט הזה (לפי git log + CLAUDE.md + todolist).
  2. צור checklist או שאלון קצר שהחבר ממלא (מה כבר יש לו).
  3. הפק "installation delta" — רק ההוראות הרלוונטיות למה שחסר, מסודרות לפי עדיפות.
  (אפשרות: כלי CLI שרץ על ה-repo של החבר ומשווה קבצים אוטומטית)
  (נפתח 2026-06-11)

### Not yet prioritized (from the same brainstorm)
- [x] Voice notes in (speech→text) — SHIPPED 2026-06-11 (PR #14), un-parked from 2026-06-08: speak a voice
  bubble → Groq-hosted whisper-large-v3-turbo transcribes (swappable `transcribe.ts` backend, local
  whisper.cpp path in code for later) → answered like a typed message; 🎤 transcript echo on low confidence.
- [x] Project rename to "Telegram agent" — DONE 2026-06-12 (Maor's explicit go): README/package.json/
  todolist/DEPLOY wording, vault note renamed + `[[Telegram bot]]` links updated, memory descriptions,
  and `gh repo rename` → `Maores/claude-telegram-agent` (GitHub redirects the old URL; droplet remote
  updated). Kept by design: droplet `~/claude-bot` path, local Windows folder, `@maores_assistant_bot`,
  memory-file slugs — tooling is keyed to all four.
- [ ] Morning briefing — 8:00 push: calendar + unread-email summary + weather (and optional headlines).
- [x] systemd service — DONE 2026-06-11: `/etc/systemd/system/telegram-agent.service` (`Restart=always`,
  journald, EnvironmentFile=.env); @reboot cron removed; kill-test verified (SIGKILL → auto-restart in 5s).
  Trigger: the tmux poller died unexplained that evening and took its logs with it. No memory caps —
  claude children need the 1 GB box's headroom.
- [ ] Usage / cost tracking — tokens/cost per message + per day, a `/usage` command, optional daily budget guard.
- [ ] Multi-user pairing & isolation — access.json pairing/groups stub; per-user history/memory/reminders; invite flow.
- [ ] Calendar polish — recurring-event editing (this / this-and-future / all), an explicit default calendar,
  optional event alarms on create.

## Model strategy (done)
Was defaulting to **Opus 4.8 (1M context)** — overkill for a chat bot: slow (~1.9s to first token,
plus a thinking phase) and heavy on the Pro quota. Now **Sonnet** is the default (fast, plenty for
chat) and the bot escalates to **Opus** only on explicit/heuristic signals — `/opus`, keywords
("think hard", "use opus", …), or a fenced code block — via `--model <name>` on `claude -p`.
- Decision: deliberately did NOT add a Haiku pre-classifier router. Reasoning: a classifier would add a
  second `claude` startup + connector-init on every message, and that latency would dominate the savings
  for a chat workload. Cheap explicit+heuristic routing captures nearly all the benefit at no extra cost.
- Result: noticeably faster default replies and lighter quota use. `model.ts` is unit-tested.
- (Interview angle: considered the "smart LLM router" design and rejected it on measured-latency grounds.)

## Bugs & risks
- [x] **כפתורי תגובה לתזכורות לא מגיבים** — fixed in TWO parts. Part 1 (latency): the sequential loop
  blocked callback ACKs behind whole claude turns — fixed by the non-blocking dispatch loop (PR #18,
  2026-06-12). Part 2 (dead presses, דווח 2026-06-12 "after the second check"): deploy restarts ate
  consumed-but-unprocessed updates — the loop saves the Telegram offset at fetch time while handlers run
  async, and `systemctl restart` killed bun mid-handler (pressed → ACKed → never applied; happened twice,
  10:05/10:22 deploys). Fixed by PR #23: graceful SIGTERM drain (idle() on both queues, 80s cap),
  AbortSignal timeout on every tg() fetch (a silent dead socket can no longer hang the loop unlogged),
  [CB] press logging + a visible "כבר טופל" toast on stale presses, and KillMode=mixed +
  TimeoutStopSec=90 on the systemd unit. Drain live-verified in the journal 2026-06-12 10:46.
- [x] **כפתורי follow-up של תזכורת ישנה לא מתנקים** (דווח 2026-06-11) — FIXED same day, PR #15: the nudge
  now strips the original message's keyboard at handover (one live button set per follow-up). Live-verified
  on the droplet with a forced nudge.
- [x] `reminders.json` read-modify-write race (poller vs `remind.ts` CLI) — FIXED 2026-06-11, PR #16:
  cross-process lockfile (`withFileLock` — O_EXCL create, 5s stale-steal, 1.5s timeout then proceed-without,
  so a stuck lock can't brick reminders) around every mutator in `reminders.ts`, both stores. The SQLite
  migration would still supersede this someday.
- [x] **תמלול קולי בשפה שגויה** (דווח 2026-06-12) — FIXED same day (PR #20): whisper auto-detects first;
  if the detected language is outside `VOICE_LANGS` (default `he,en` — so English notes stay untouched),
  ONE re-transcription runs with the primary language forced. Handles both name- and code-style
  `language` fields ("arabic"/"ar"); never loops.
- [ ] Bot task edits rebuild the VTODO and would drop VALARM alert blocks (alerts set on the iPhone).
  Census 2026-06-12: zero VALARM among current reminders, so theoretical for now — if Maor starts using
  alert times, carry VALARM blocks through the rebuild (small; noted in PR #21's known limitations).
- [ ] Telegram replies are plain text only (no Markdown rendering) — possible future polish.
- [ ] Calendar writes are gated only by the bot's confirm-before-write instruction in CLAUDE.md, not
  enforced in code (fine for a single-user bot). Editing a recurring event is refused; deleting a
  recurring master would remove the whole series.
- [ ] `/stop` with an `[AUTO]` run overlapping an interactive turn (same chat) kills whichever child
  registered LAST in the single `inFlight` slot — the other keeps running despite the נעצר reply.
  Pre-existing (predates the non-blocking loop, flagged in its review 2026-06-12); fix = track
  multiple flights per chat. Rare: needs [AUTO] + interactive at the same instant.

## Things to notice (deploy/ops gotchas)
- Deploy to the server with `git fetch origin && git reset --hard origin/main` — a plain `git pull`
  breaks on line-ending/mode drift in the server's working tree.
- `start.sh` is committed executable (mode 100755), so resets keep its +x; it's also launched via
  `bash` and the cron uses `/bin/bash` as belt-and-suspenders.
- Send multi-line / secret-bearing scripts over SSH base64-encoded (`echo <b64> | base64 -d | bash`);
  piping through PowerShell mangles line endings.
- College wifi "Braude-Edu 5" blocks outbound port 22; SSH from home/hotspot.
- SSH key: locked-down copy at `%TEMP%\id_deploy_droplet` (Copy-Item + `icacls /inheritance:r /grant`).
