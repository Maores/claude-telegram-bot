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

## Features / backlog
- [ ] systemd service to replace tmux + `@reboot` cron (`Restart=always`, journald logs).
- [ ] CI/CD: GitHub Actions runs `bun test` on push, auto-deploys to the VPS on green.
- [ ] Migrate history + reminders from JSON files to SQLite (schema + migrations; removes the
  reminders.json write race).
- [ ] RAG long-term memory (embed past messages/notes, retrieve relevant context per query).
- [ ] Voice messages → transcription (Whisper) → reply (optional spoken reply).
- [ ] Image understanding (send a photo → Claude vision).
- [ ] Proactive morning briefing (calendar + unread-email summary + news, pushed at 8am).
- [ ] Multi-user pairing & isolation (use the access.json pairing/groups stub; per-user state).
- [ ] Observability: structured JSON logs, a `/status` command, basic metrics.
- [ ] Security hardening: ufw, fail2ban, secrets out of plaintext, prompt-injection test suite.
- [ ] Usage / cost tracking + per-day rate limiting.
- [ ] Calendar polish: recurring-event editing (this / this-and-future / all), an explicit default
  calendar instead of "first event-capable", and optional event reminders/alarms on create.

## Model strategy (planned)
Bot currently runs **Opus 4.8 (1M context)** — overkill for a chat bot: slow (~1.9s to first token,
plus a thinking phase) and heavy on the Pro quota (a trivial reply measured ~$0.04-equivalent).
Plan: make **Sonnet** the default (fast, plenty for chat), and use a cheap **Haiku** router that
classifies each message and escalates to **Opus** only for genuinely hard tasks.
- Mechanism: pass `--model <name>` to `claude -p` per message.
- Open question: is the Haiku pre-classification worth its added latency, vs. just defaulting to
  Sonnet and letting the user say "use opus for this"? Decide during its design.

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
