# Project todo / tracker

Tracker for the Claude Telegram bot — features, bugs, and things to notice.

## In progress
- [ ] **Streaming responses (Approach A)** — show `💭 thinking…` / `🔍 tool…` status, then stream
  the answer in progressively. Uses `claude -p --output-format stream-json --include-partial-messages`;
  pushes Telegram message edits on a ~1.5s **throttle** (not per token) to respect edit rate limits;
  handles the 4096-char overflow (continue in a new message) and `429 retry_after`. Design stage.

## Features / backlog
- [ ] **Switch main model off Opus 4.8** — see "Model strategy" below. Speed + quota.
- [ ] iPhone/iCloud calendar via CalDAV (Apple app-specific password + a custom script). The one
  remaining original goal.
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

## Things to notice (deploy/ops gotchas)
- Deploy to the server with `git fetch origin && git reset --hard origin/main` — a plain `git pull`
  breaks on line-ending/mode drift in the server's working tree.
- `git reset --hard` drops `start.sh`'s executable bit → launch via `bash start.sh` (cron uses `/bin/bash`).
- Send multi-line / secret-bearing scripts over SSH base64-encoded (`echo <b64> | base64 -d | bash`);
  piping through PowerShell mangles line endings.
- College wifi "Braude-Edu 5" blocks outbound port 22; SSH from home/hotspot.
- SSH key: locked-down copy at `%TEMP%\id_deploy_droplet` (Copy-Item + `icacls /inheritance:r /grant`).
