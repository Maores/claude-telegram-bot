#!/bin/bash
# Starts the Telegram bot poller on the VPS.
# Sets PATH (bun + claude), loads the bot token from .env, runs the poller.
export PATH="/home/claudebot/.bun/bin:/home/claudebot/.local/bin:/usr/local/bin:$PATH"
export TZ="Asia/Jerusalem"

set -a
source /home/claudebot/.claude/channels/telegram/.env
set +a

cd /home/claudebot/claude-bot
exec bun run poller.ts
