# Project todo / tracker

Tracker for the Claude Telegram bot — features, bugs, and things to notice.

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

## Roadmap (prioritized 2026-06-08)
Picked from the feature brainstorm. Numbered = urgency order within each group (1 = next up).

### Useful day-to-day
1. [ ] Photo understanding — send a photo → Claude reads/answers via its Read tool (Pro plan, no API).
   Feasibility check first: confirm headless `claude -p` can see a saved image file.
2. [ ] PDF & document Q&A — forward a PDF or point at a Drive doc → summarize / answer questions. Shares
   the "media input" plumbing (receive + download a file) with photo understanding.
3. [ ] Email triage + reply drafting — flag emails that look like they need a reply; draft responses on
   request (drafts only, Maor sends). Reuses the nudge-loop pattern.
4. [ ] Spoken replies out — answer with a voice message via TTS (engine or API). Lower priority.

### Smarter memory & data
1. [ ] RAG long-term memory — embed past chats/notes into a vector store, retrieve relevant bits per query.
   Needs an embeddings source (small local model or an embedding API; the claude CLI doesn't expose embeddings).
2. [ ] SQLite migration — move history + reminders + dedupe state from JSON to SQLite (schema + migrations;
   removes the reminders.json write race; foundation for RAG + metrics).
3. [ ] Natural-language task list — bot-managed to-dos (add/list/complete/snooze). FEASIBILITY CONFIRMED
   (2026-06-08): write to the real Apple Reminders list ("תזכורות", a `VTODO` collection) over the same
   iCloud CalDAV as the calendar, so tasks sync to the iPhone (no silo). Mirrors the calendar plumbing
   (a `buildVTodo` + create/update/delete). Build the iCloud variant, not a bot-local file. ~M.

### Production maturity (engineering signal)
1. [ ] Security hardening — ufw, fail2ban, secrets out of plaintext, prompt-injection test suite for the
   email/file "untrusted data" boundary.
2. [ ] CI/CD (GitHub Actions) — run `bun test` on every push, auto-deploy to the droplet on green.
3. [ ] Observability — structured JSON logs + a `/status` command (uptime, last error, model usage, metrics).

### Not yet prioritized (from the same brainstorm)
- [ ] Voice notes in (speech→text) — PARKED 2026-06-08: iPhone dictation already turns Maor's speech into
  text before sending, so the bot needn't transcribe. Researched design on file if revisited (faster-whisper
  + ivrit.ai `whisper-large-v3-turbo-ct2`, INT8, a warm Python worker, and a ~4GB droplet bump).
- [ ] Morning briefing — 8:00 push: calendar + unread-email summary + weather (and optional headlines).
- [ ] systemd service — replace tmux + `@reboot` cron (`Restart=always`, journald logs, resource limits).
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
- [ ] `reminders.json` has a read-modify-write race between the poller and `remind.ts` (mitigated by
  atomic temp+rename writes, not eliminated). The SQLite migration would remove it.
- [ ] Telegram replies are plain text only (no Markdown rendering) — possible future polish.
- [ ] Calendar writes are gated only by the bot's confirm-before-write instruction in CLAUDE.md, not
  enforced in code (fine for a single-user bot). Editing a recurring event is refused; deleting a
  recurring master would remove the whole series.

## Things to notice (deploy/ops gotchas)
- Deploy to the server with `git fetch origin && git reset --hard origin/main` — a plain `git pull`
  breaks on line-ending/mode drift in the server's working tree.
- `start.sh` is committed executable (mode 100755), so resets keep its +x; it's also launched via
  `bash` and the cron uses `/bin/bash` as belt-and-suspenders.
- Send multi-line / secret-bearing scripts over SSH base64-encoded (`echo <b64> | base64 -d | bash`);
  piping through PowerShell mangles line endings.
- College wifi "Braude-Edu 5" blocks outbound port 22; SSH from home/hotspot.
- SSH key: locked-down copy at `%TEMP%\id_deploy_droplet` (Copy-Item + `icacls /inheritance:r /grant`).
