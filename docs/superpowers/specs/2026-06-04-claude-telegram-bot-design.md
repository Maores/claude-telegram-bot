# Claude Telegram bot — design spec

Date: 2026-06-04
Status: approved (streamlined build per user request)

## Goal

A 24/7 personal AI assistant reachable over Telegram that answers using the
local `claude` CLI (Claude Pro subscription, no API key). Runs on a
DigitalOcean droplet. No third-party MCP integrations at launch.

## Context

The original setup guide (`claude-telegram-bot-setup-generic.md`) documents the
full VPS procedure but never provides the core engine `poller.ts` — it assumes
you clone it from a repo that does not exist. This project writes that engine
plus all supporting config, and ships a deploy runbook tailored to the result.

## Architecture

```
Telegram  --getUpdates(long-poll)-->  poller.ts (Bun)
                                         |
                          per allowed text message:
                                         |
              spawn: claude -p --dangerously-skip-permissions
              (cwd = repo, so CLAUDE.md + injected memory apply)
                                         |
                       stdout --> sendMessage (chunked <=4096)
```

Each message spawns a fresh `claude -p` process. There is no persistent Claude
session; continuity comes from conversation history injected into the prompt.

## poller.ts behavior

- Long-poll `getUpdates` with `timeout=30` in a loop that never dies on error
  (network/Telegram failures are caught, backed off, retried).
- Persist the update `offset` to `history/.offset` so restarts neither drop nor
  replay messages. On first run (no offset file), skip existing backlog so the
  bot does not reply to old messages.
- For each text message from an allowed user:
  1. Send a `⏳` placeholder message.
  2. Load `history/<chat_id>.json` (last 10 exchanges) and `memory/MEMORY.md`.
  3. Build a prompt: long-term memory + recent history + the new message.
  4. Spawn `claude -p --dangerously-skip-permissions` (cwd = repo), prompt on
     stdin, with a timeout (default 4 min).
  5. Edit the `⏳` placeholder into the answer's first chunk; send remaining
     chunks as new messages (Telegram hard limit 4096 chars/message).
  6. Append the exchange to history, trimmed to the last 20 messages.
- Allowlist: read `allowFrom` from `access.json` on every message (live edits
  apply without restart). Non-allowlisted senders are logged and ignored.
- Resilience: per-message try/catch sends a friendly error instead of crashing;
  Telegram `429` honors `retry_after`; `409` (conflict) logs and backs off.
- Logs `[BOT] Poller started as @<bot>`, `[MSG] <name>: <text>`,
  `[DONE] replied to <id>` so the runbook's test output matches.
- Zero npm dependencies: built-in `fetch` + Node stdlib + `Bun.spawn`. No
  install step required on the server.
- Replies are plain text in v1 (always delivers). Telegram Markdown rendering
  is a deliberate future enhancement (needs escaping + a fallback).

## Configuration (environment overrides, with defaults)

- `TELEGRAM_BOT_TOKEN` (required) — from BotFather, sourced from server `.env`.
- `ACCESS_FILE` — default `~/.claude/channels/telegram/access.json`.
- `HISTORY_DIR` — default `<repo>/history`.
- `CLAUDE_BIN` — default `claude`.
- `CLAUDE_TIMEOUT_MS` — default `240000`.

## Memory

- Short-term: `history/<chat_id>.json`, last 10 exchanges, managed by poller.
- Long-term: `memory/MEMORY.md`. poller injects it into every prompt; CLAUDE.md
  instructs the bot to update it with durable facts via its file tools. Both
  `history/` and `memory/` are gitignored so `git pull` never clobbers them.

## Files

| File | Purpose | In git |
|------|---------|--------|
| `poller.ts` | The engine | yes |
| `start.sh` | Sets PATH, sources `.env`, runs poller | yes |
| `CLAUDE.md` | Bot identity + permissions + memory rules | yes |
| `access.example.json` | Allowlist template | yes |
| `.claude/settings.json` | Project permissions | yes |
| `package.json`, `tsconfig.json` | Metadata + editor types | yes |
| `.gitignore` | Keep secrets/state out of git | yes |
| `DEPLOY.md` | Ordered VPS runbook | yes |
| `.env` | `TELEGRAM_BOT_TOKEN` | no (server only) |
| `access.json` | Real allowlist | no (server only) |
| `history/`, `memory/` | Runtime state | no (server only) |

## Deployment

VPS (DigitalOcean, Ubuntu 24.04, 1 GB RAM). Division of labor:
- Built locally: all code/config + this repo, pushed to GitHub.
- User-only: create BotFather bot, create droplet, run `claude` OAuth login.
- Server setup: driven over SSH or via the `DEPLOY.md` runbook.
- GitHub: public repo (no secrets committed) clones without auth; private repo
  is supported but needs `gh auth` on the server.

## Out of scope (YAGNI for v1)

- MCP integrations (gws / Todoist / Tavily) — add later per guide Part 9/17.
- Telegram pairing / group support (`dmPolicy`, `groups`, `pending` kept in the
  access.json shape but not enforced).
- Markdown/HTML formatted replies, voice/image messages, streaming responses.

## Verification

- Local: `bun build poller.ts` transpiles without error.
- Real: with a token in `.env` and the sender's ID in `access.json`, the bot
  replies to a Telegram message and logs `[DONE] replied to <id>`.
