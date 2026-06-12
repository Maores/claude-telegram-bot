# Deploy runbook — Claude Telegram bot on a DigitalOcean VPS

Ordered steps to take this repo from zero to a 24/7 bot. Commands marked
**(local)** run on your Windows machine; **(server)** run on the droplet over SSH.

Placeholders to replace: `<YOUR_SERVER_IP>`, `<YOUR_TOKEN>`,
`<YOUR_TELEGRAM_USER_ID>`, `<YOUR_NAME>`, `<YOUR_BOT_USERNAME>`, `<YOUR_REGION>`.
The GitHub repo is already created at `Maores/claude-telegram-bot` (public).

---

## Step 0 — Create the Telegram bot and find your user ID (phone/desktop Telegram)

1. Open Telegram, search **@BotFather**, send `/newbot`.
2. Pick a display name, then a username ending in `bot` (e.g. `my_assistant_bot`).
3. BotFather replies with a token like `1234567890:AAH...`. Keep it secret.
4. Message **@userinfobot** and note your numeric **user ID** (e.g. `43965740`).

You now have: bot token, bot username, your Telegram user ID.

---

## Step 1 — Create the droplet (DigitalOcean web console)

- Image: **Ubuntu 24.04 LTS**
- Size: **1 vCPU / 1 GB RAM / 25 GB SSD** (~$6/mo). Do not use the $4 plan —
  Claude needs ~1 GB RAM.
- Region: closest to you (e.g. `fra1`).
- Authentication: **add your SSH public key**.
  - **(local)** show your existing key: `Get-Content ~/.ssh/id_ed25519_chatgpt_bot.pub`
    — paste its contents into DigitalOcean, or just select it if it's already saved
    in your account.
  - To use a fresh key instead: `ssh-keygen -t ed25519`, then show that `.pub`.
- Create, then copy the droplet's public IP into `<YOUR_SERVER_IP>`.

---

## Step 2 — Base server setup (server, as root)

```bash
ssh root@<YOUR_SERVER_IP>

apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git curl tmux
npm install -g @anthropic-ai/claude-code
```

---

## Step 3 — Create the non-root `claudebot` user (server, as root)

Claude's `--dangerously-skip-permissions` is blocked for root, so the bot runs
as `claudebot`.

```bash
useradd -m -s /bin/bash claudebot
passwd claudebot                 # set a password
usermod -aG sudo claudebot

mkdir -p /home/claudebot/.ssh
cp ~/.ssh/authorized_keys /home/claudebot/.ssh/
chown -R claudebot:claudebot /home/claudebot/.ssh
chmod 700 /home/claudebot/.ssh
chmod 600 /home/claudebot/.ssh/authorized_keys
```

Reconnect as `claudebot`:

```bash
exit
ssh claudebot@<YOUR_SERVER_IP>
```

---

## Step 4 — Install Bun for claudebot (server)

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="/home/claudebot/.bun/bin:$PATH"
bun --version    # confirm it prints a version
```

---

## Step 5 — Get the code onto the server (local push, then server clone)

This repo commits **no secrets** (`.env`, `access.json`, history and memory are
gitignored), so a **public** GitHub repo is the simplest — it clones with no auth.

The repo is already created and pushed at
**https://github.com/Maores/claude-telegram-bot** (public), so there's nothing to do
locally. **(server)** clone it into `~/claude-bot`:

```bash
cd /home/claudebot
git clone https://github.com/Maores/claude-telegram-bot.git claude-bot
cd claude-bot
```

> Prefer a **private** repo? Create it with `--private`, then on the server run
> `gh auth login` (GitHub.com → HTTPS → browser) before `git clone`. You'd
> install gh first: `sudo apt install -y gh`.

---

## Step 6 — Authenticate Claude (server, interactive — only you can do this)

```bash
cd /home/claudebot/claude-bot
claude
# Follow the OAuth flow: open the printed URL in your browser, sign in with your
# Claude Pro account, paste the code back. Then type /exit.
```

Verify headless mode works:

```bash
echo "say hi in 3 words" | claude -p --dangerously-skip-permissions
```

---

## Step 7 — Store the Telegram token (server, never commit this)

```bash
mkdir -p /home/claudebot/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=<YOUR_TOKEN>" > /home/claudebot/.claude/channels/telegram/.env
chmod 600 /home/claudebot/.claude/channels/telegram/.env
```

> If this token also exists on any other machine that polls it, you'll get a
> Telegram **409 conflict**. It must live only here.

---

## Step 7b — Voice notes (optional but recommended)

Voice bubbles are transcribed before Claude sees them (`transcribe.ts`).
Without configuration the bot politely says voice isn't connected yet —
nothing breaks.

**Hosted backend (default, recommended on a 1 GB droplet):**

1. Create a free API key at https://console.groq.com (no card required).
2. Append it to the bot env file:

   ```bash
   echo 'GROQ_API_KEY=gsk_...' >> /home/claudebot/.claude/channels/telegram/.env
   ```

3. Restart the poller (`sudo systemctl restart telegram-agent`). Done —
   `TRANSCRIBE_BACKEND` auto-resolves to `groq` when the key is present.

Tuning (all optional, in the same `.env`):

| var | default | meaning |
|---|---|---|
| `TRANSCRIBE_BACKEND` | auto | `groq` / `local` / `off` (explicit override) |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | hosted whisper variant |
| `VOICE_MAX_SEC` | `300` | longest voice note accepted |
| `VOICE_ECHO_BELOW` | `0.6` | echo the transcript when confidence is below this; `0` = never echo |
| `VOICE_TIMEOUT_MS` | `45000` | transcription timeout |
| `POLL_SERIAL` | unset | `1` reverts to the old strictly-sequential update loop (rollback switch; expect button lag + queued /stop again) |

**Local backend (keyless, deferred — for a bigger droplet someday):**

`TRANSCRIBE_CMD` is a shell command template; `{input}` is replaced with the
quoted audio path, and stdout must be `{"text": "...", "confidence": 0..1?}`
JSON. Example with whisper.cpp (UNVERIFIED — validate when you provision it;
the 1 GB droplet can only hold the `small` model, whose Hebrew is mediocre):

```bash
# one-time: apt install -y ffmpeg jq; build whisper.cpp; download a quantized model
TRANSCRIBE_CMD='wav=$(mktemp --suffix .wav); ffmpeg -y -loglevel error -i {input} -ar 16000 -ac 1 "$wav" && /home/claudebot/whisper.cpp/build/bin/whisper-cli -m /home/claudebot/whisper.cpp/models/ggml-small-q5_1.bin -l auto -np -nt -oj -of "${wav%.wav}" "$wav" >/dev/null && jq -c "{text: ([.transcription[].text] | join(\"\")), confidence: null}" "${wav%.wav}.json"; rm -f "$wav" "${wav%.wav}.json"'
```

A swap file is strongly advised before trying local inference on the 1 GB box.

---

## Step 8 — Create the real allowlist (server)

```bash
cat > /home/claudebot/.claude/channels/telegram/access.json << 'EOF'
{
  "dmPolicy": "pairing",
  "allowFrom": ["<YOUR_TELEGRAM_USER_ID>"],
  "groups": {},
  "pending": {}
}
EOF
```

The bot answers only IDs listed in `allowFrom`.

---

## Step 9 — User-level Claude permissions (server)

Lets the headless bot run without interactive permission prompts.

```bash
mkdir -p /home/claudebot/.claude
cat > /home/claudebot/.claude/settings.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit"]
  }
}
EOF
```

(The project-level `.claude/settings.json` is already in the repo.)

---

## Step 10 — Personalize the bot identity (server or local)

Edit `CLAUDE.md` and replace `<YOUR_NAME>`, `<YOUR_BOT_USERNAME>`, `<YOUR_REGION>`.
If you edit it locally, commit/push and `git pull` on the server.

The poller auto-creates `history/` and `memory/` on first run, so there is
nothing else to set up.

---

## Step 11 — Run it as a systemd service (server)

The poller runs under systemd (since 2026-06-11; it replaced tmux + an
`@reboot` cron after a crash took its logs with it — journald keeps the
evidence and `Restart=always` self-heals). Install the unit:

```bash
sudo tee /etc/systemd/system/telegram-agent.service > /dev/null << 'EOF'
[Unit]
Description=Telegram agent poller (claude-telegram-bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=claudebot
WorkingDirectory=/home/claudebot/claude-bot
EnvironmentFile=/home/claudebot/.claude/channels/telegram/.env
Environment=TZ=Asia/Jerusalem
Environment=PATH=/home/claudebot/.bun/bin:/home/claudebot/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/claudebot/.bun/bin/bun run poller.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-agent
```

(No memory limits on purpose: claude child processes need the 1 GB box's
headroom; the `.env` must stay plain `KEY=VALUE` lines — systemd parses it
directly, no shell quoting.)

Check it:

```bash
systemctl status telegram-agent
sudo journalctl -u telegram-agent -f     # live logs; expect:
# [BOT] Poller started as @<YOUR_BOT_USERNAME>
```

Message your bot from Telegram. Expect `[MSG] …` / `[DONE] …` lines in the
journal. Reboot survival comes from `enable` — no cron entry needed (the old
`@reboot start.sh` line must NOT coexist with the service: two pollers fight
over getUpdates with 409s). `start.sh` remains useful for a one-off
foreground run while debugging.

---

## Updating the bot later (local → server)

```powershell
# (local) after editing code or CLAUDE.md
git add . ; git commit -m "update bot" ; git push
```

```bash
# (server)
cd ~/claude-bot && git fetch origin && git reset --hard origin/main
sudo systemctl restart telegram-agent
sudo journalctl -u telegram-agent -n 5 --no-pager   # confirm the banner
```

---

## Adding integrations later (optional)

You launched with none. To add Google Workspace, Todoist, or Tavily:

```bash
# (server, as claudebot) examples:
claude mcp add -s user todoist --env TODOIST_API_TOKEN=<token> -- npx -y @doist/todoist-ai
claude mcp add -s user tavily  --env TAVILY_API_KEY=<key>     -- npx -y @tavily/mcp-server
claude mcp list   # verify "✓ Connected"
```

Then document the new tool in `CLAUDE.md` (under "Permissions granted" / a new
"Available tools" section) so the bot knows to use it, and restart.

---

## Troubleshooting

- **409 conflict on getUpdates** — another process polls the same token. Make
  sure the token exists only on this server and only one `start.sh`/`bun` runs.
  Reset webhooks if needed:
  ```bash
  TOKEN=<YOUR_TOKEN>
  curl "https://api.telegram.org/bot$TOKEN/deleteWebhook"
  ```
- **Bot receives a message but never replies** — confirm your ID is in
  `access.json` `allowFrom`; check `poller.log`; test `echo hi | claude -p
  --dangerously-skip-permissions` in `~/claude-bot`.
- **`start.sh: /bin/bash^M: bad interpreter`** — the file got CRLF endings. This
  repo's `.gitattributes` forces LF, so re-clone or run `sed -i 's/\r$//'
  start.sh`.
- **Bot stops after reboot** — `systemctl status telegram-agent` and
  `sudo journalctl -u telegram-agent -n 50`; the unit must be `enabled`.
