# Claude Telegram agent

A 24/7 personal AI agent on Telegram, powered by the local `claude` CLI
(Claude Pro subscription — no API key). Each message spawns a fresh
`claude -p` process with your conversation history as context.

## How it works

`poller.ts` (Bun) long-polls Telegram. For each message from an allow-listed
user — text, photo, document, or a voice note (transcribed first via Groq
whisper or a swappable local command, echoed back 🎤 when confidence is low) —
it builds a prompt (long-term memory + automatic keyword recall + recent history + the message), runs
`claude -p --dangerously-skip-permissions` in this directory, and sends
Claude's stdout back to the chat. Button presses acknowledge instantly and
`/stop` interrupts mid-answer — the update loop dispatches to per-chat queues
instead of blocking. For deeper "what did we decide about X?" digging, the
agent can run `bun run history.ts search "<query>"` (BM25 over the full
archive) and `bun run history.ts context <id>` (surrounding conversation) to
pull up specific past exchanges that automatic recall didn't surface.

## Layout

| File | Purpose |
|------|---------|
| `poller.ts` | The long-poll engine (no dependencies) |
| `start.sh` | Loads `.env` and runs the poller on the VPS |
| `CLAUDE.md` | Agent identity, permissions, memory rules |
| `access.example.json` | Allowlist template (real `access.json` is server-only) |
| `.claude/settings.json` | Project permissions |
| `DEPLOY.md` | Step-by-step VPS deployment |
| `docs/superpowers/specs/` | Design spec |

Secrets and runtime state (`.env`, `access.json`, `history/`, `memory/`) are
gitignored and live only on the server.

## Deploy

Follow [DEPLOY.md](DEPLOY.md). Short version: create a Telegram bot account via
@BotFather, push this repo to GitHub, clone it on a DigitalOcean droplet,
authenticate Claude, drop in the token + allowlist, and enable the
`telegram-agent` systemd service.

## Run locally (for testing)

```bash
bun install                 # optional, only for editor types
TELEGRAM_BOT_TOKEN=... ACCESS_FILE=./access.json bun run poller.ts
```
