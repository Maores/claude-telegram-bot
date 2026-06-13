# Migration runbook — DigitalOcean → Azure for Students

**Why:** the GitHub Student Pack DigitalOcean credits expire **July 31, 2026**. Microsoft
Azure is still a Student Pack compute partner, and **Azure for Students** is the clean
in-Pack replacement: a **free B1s Linux VM** (750 hrs/month = 24/7, $0) for the first year
plus a **$100 credit** (renewable yearly while enrolled), **no credit card required**, and
when the credit runs out Azure *disables* the subscription rather than billing — zero
surprise-charge risk. (Heroku and Codespaces, the other Pack offers, can't host a 24/7
`claude -p` bot — ephemeral filesystem / idle auto-stop.)

Migration is a ~30-minute restore: the full data backup
(`C:\Users\maor4\Backups\telegram-agent\agent-backup-20260613.tar.gz`) and the GitHub repo
(`Maores/claude-telegram-agent`) are all that's needed. Target: **rebuild the droplet
exactly** — same `claudebot` user, same paths — so no code/docs change.

Reference baseline (from the live droplet, 2026-06-13): Bun 1.3.14, Node v20.20.2,
Claude Code 2.1.162; env keys `TELEGRAM_BOT_TOKEN`, `ICLOUD_USER`, `ICLOUD_APP_PASSWORD`,
`GROQ_API_KEY`; allowlist chat id `282408422`.

---

## Step 0 — what only Maor can do (the human-gated parts)
1. **Activate Azure for Students** — go to <https://azure.microsoft.com/free/students> (or via
   <https://education.github.com/pack> → Microsoft Azure). Sign in with a Microsoft account and
   verify student status with the school email **or** the GitHub Student Pack. **No card.**
2. **Create the VM** — Azure Portal → Virtual machines → Create:
   - Image **Ubuntu Server 24.04 LTS (Gen2)**, size **Standard_B1s** (confirm the "free
     services eligible" label), region a low-latency one (e.g. West/North Europe).
   - **Authentication: SSH public key.** Set **Admin username = `claudebot`** (keeps every
     path identical to the droplet).
   - **Inbound ports: none** — the bot is outbound-only (Telegram long-polling). Leave 22 open
     only for your own SSH, ideally source-restricted to your IP.
3. **Claude Pro login** is interactive — Step 5 (you run `claude`, or copy credentials).

Everything else below I can run for you once the VM exists and I have SSH access (same as the
droplet deploys), or you can paste it yourself.

---

## Step 1 — system prep + swap (1 GiB RAM needs headroom for `claude -p`)
```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install git curl unzip
# 2 GB swap so spawning claude children doesn't OOM on a 1 GiB box
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## Step 2 — runtimes: Node 20, Bun, Claude Code
```bash
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # expect v20.x
# Bun (installs to ~/.bun/bin — matches the systemd PATH)
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
# Claude Code CLI (npm path is the supported install; avoids the arm64 native-installer bug)
sudo npm install -g @anthropic-ai/claude-code
claude --version
```

## Step 3 — clone the code
```bash
cd ~ && git clone https://github.com/Maores/claude-telegram-agent.git claude-bot
cd claude-bot && git log --oneline -1   # should be the latest main
bun install                              # zero runtime deps, but installs dev/test deps
```

## Step 4 — restore data + secrets from the backup
From your **Windows machine**, copy the backup up (replace `<VM_IP>`):
```powershell
scp -i <ssh_key> "C:\Users\maor4\Backups\telegram-agent\agent-backup-20260613.tar.gz" claudebot@<VM_IP>:/tmp/
```
Then on the **VM**:
```bash
cd /tmp && tar xzf agent-backup-20260613.tar.gz
B=/tmp/agent-backup-20260613
# runtime state + memory DB into the repo
mkdir -p ~/claude-bot/memory
cp $B/claude-bot/memory/bot.db* ~/claude-bot/memory/ 2>/dev/null || true
cp $B/claude-bot/*.json ~/claude-bot/ 2>/dev/null || true
cp -r $B/claude-bot/history ~/claude-bot/ 2>/dev/null || true
# secrets + allowlist into the channel dir the service reads
mkdir -p ~/.claude/channels/telegram
cp $B/claude-channel/.env ~/.claude/channels/telegram/.env
cp $B/claude-channel/access.json ~/.claude/channels/telegram/access.json
chmod 600 ~/.claude/channels/telegram/.env
# scrub the temp copy (it holds secrets)
rm -rf /tmp/agent-backup-20260613 /tmp/agent-backup-20260613.tar.gz
```

## Step 5 — authenticate Claude with the Pro subscription
```bash
claude   # complete the OAuth login in the browser, then /exit
# Verify a non-interactive run works (this is exactly how the poller calls it):
echo "say OK" | claude -p --model sonnet
```
If you ever run an **arm64** VM instead of B1s: the arm64 OAuth `/login` is buggy — log in on
an x86 machine and copy `~/.claude/.credentials.json` to the VM, then
`claude config set hasCompletedOnboarding true`.

## Step 6 — systemd service (identical to the droplet) + drain drop-in
```bash
sudo tee /etc/systemd/system/telegram-agent.service >/dev/null <<'UNIT'
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
UNIT
# graceful drain (PR #23): SIGTERM drains queues, claude children survive
sudo mkdir -p /etc/systemd/system/telegram-agent.service.d
printf '[Service]\nKillMode=mixed\nTimeoutStopSec=90\n' | sudo tee /etc/systemd/system/telegram-agent.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-agent
sleep 3 && systemctl is-active telegram-agent
journalctl -u telegram-agent -n 8 --no-pager   # expect "[BOT] Poller started as @maores_assistant_bot"
```

## Step 7 — verify, then cut over
- Send the bot a Telegram message → it replies (proves `claude -p` spawns + Pro auth works).
- Tap a reminder/confirm button → works (proves the callback path).
- **Only after the Azure box is verified for a day**, decommission the DigitalOcean droplet
  (Destroy it in the DO panel) so you stop any post-July-31 billing. The backup + repo remain.
- **Two pollers on one bot token = Telegram 409 war.** Stop the DO service
  (`sudo systemctl stop telegram-agent` on the droplet) the moment Azure goes live, before the
  cutover overlaps.

## Step 8 — keep it free
- Set a calendar reminder **~11 months out** to re-verify student status on the Azure for
  Students portal (free tier + $100 credit renew **manually**, not automatically).
- Touch a resource at least every ~90 days so Azure doesn't disable an idle subscription (the
  always-on poller already does this).

---

## Cost reality
- **Year 1:** B1s on the free 750-hr VM tier = **$0**; the $100 credit is untouched spare.
- **B1s = 1 GiB RAM** (same as the droplet today) → the 2 GB swap above is what makes
  `claude -p` comfortable. The roomy 4 GiB **B2s** is ~$30/mo and would burn the $100 credit in
  ~3 months, so don't run it long-term unless you hit real memory pressure.
- **After year 1:** a B1s on pure credit is ~$7.59/mo → the renewed $100/yr covers it with room
  to spare, indefinitely while you're a student.
