# Claude Telegram bot

A 24/7 personal AI assistant on Telegram, powered by the local `claude` CLI
(Claude Pro subscription — no API key). Each message spawns a fresh
`claude -p` process with your conversation history as context.

## Features

- Voice notes: speak instead of typing — transcribed (Groq whisper, swappable local backend) and answered like text, with a 🎤 transcript echo when confidence is low.

## How it works

`poller.ts` (Bun) long-polls Telegram. For each text message from an
allow-listed user it builds a prompt (long-term memory + recent history + the
message), runs `claude -p --dangerously-skip-permissions` in this directory, and
sends Claude's stdout back to the chat.

## Layout

| File | Purpose |
|------|---------|
| `poller.ts` | The long-poll engine (no dependencies) |
| `start.sh` | Loads `.env` and runs the poller on the VPS |
| `CLAUDE.md` | Bot identity, permissions, memory rules |
| `access.example.json` | Allowlist template (real `access.json` is server-only) |
| `.claude/settings.json` | Project permissions |
| `DEPLOY.md` | Step-by-step VPS deployment |
| `docs/superpowers/specs/` | Design spec |

Secrets and runtime state (`.env`, `access.json`, `history/`, `memory/`) are
gitignored and live only on the server.

## Deploy

Follow [DEPLOY.md](DEPLOY.md). Short version: create a Telegram bot via
@BotFather, push this repo to GitHub, clone it on a DigitalOcean droplet,
authenticate Claude, drop in the token + allowlist, and run `start.sh` in tmux.

## Run locally (for testing)

```bash
bun install                 # optional, only for editor types
TELEGRAM_BOT_TOKEN=... ACCESS_FILE=./access.json bun run poller.ts
```
