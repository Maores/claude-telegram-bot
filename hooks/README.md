# Hooks — the protection floor

This directory holds the Claude Code PreToolUse hook that enforces the Phase 4
"protection floor" (see `docs/ROADMAP.md`). The rule logic lives in `guard.ts`
at the repo root and is unit-tested in `guard.test.ts`; the hook script here is
the thin adapter that Claude Code runs.

## What `pretooluse-guard.ts` does

Claude Code runs the script once before each tool call it's registered for. The
script reads the hook payload from stdin, applies the guard, and exits `2` to
block (printing the reason to stderr, which Claude sees) or `0` to allow.

It enforces two layers:

1. **Hardline floor** — `guard.checkCommand` runs on every `Bash` command in
   every session, even full-permission ones. It refuses only the unambiguously
   catastrophic: `rm -rf /` / `~` / `$HOME`, `mkfs`, `dd` to a block device,
   fork bombs, `shutdown`/`reboot`/`halt`/`poweroff`, recursive `chmod`/`chown`
   on `/`, writes to `~/.ssh`, writes to the telegram `.env`, writes to
   `guard.ts` or the hook files themselves, `git push --force` to `main`, and
   `curl`/`wget` piped straight into a shell. Commands that merely *mention*
   these as text (`echo "shutdown"`, `grep "rm -rf"`) are left alone.

2. **Least-privilege `[AUTO]` denials** — `guard.checkAutoSession` runs only
   when the spawning process set `CLAUDE_AUTO_SESSION=1` (unattended `[AUTO]`
   reminder runs; the poller sets this). Those sessions additionally may not
   schedule reminders (`remind.ts add*` — a self-replication guard) or create
   Gmail drafts (`create_draft`, matched on the action suffix so the
   per-deployment MCP server id doesn't matter).

**Fail-closed:** if a guard rule throws on a real tool call, the hook denies
rather than allows. A payload it can't parse at all is passed through (exit 0)
so a malformed hook event can never brick the bot.

## How this pairs with the poller's `--disallowedTools`

The poller (`poller.ts`) also passes `--disallowedTools` on the `[AUTO]` spawn,
which blocks `remind.ts add-once` / `add-repeat` at Claude Code's own tool layer
— a first line of defense that doesn't depend on this hook being wired. The hook
is the verified, deployment-independent enforcement: it re-checks reminders
(defense in depth against quoting/whitespace evasion) and is the **only** layer
that reliably blocks Gmail `create_draft`, because that tool's full name is
`mcp__<server-uuid>__create_draft` and the UUID differs per deployment, so it
can't be named in a static `--disallowedTools` value.

## Wiring it on the droplet — NOT applied automatically

> **This PR does not register the hook.** Adding it changes how every `claude -p`
> spawn behaves, so it is left for a deliberate deploy step. Nothing here edits
> `settings.json`.

Merge the following into the bot's Claude Code settings — the project file
`/home/claudebot/claude-bot/.claude/settings.json` is the natural home (it
already carries the `permissions` block):

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|create_draft",
        "hooks": [
          {
            "type": "command",
            "command": "/home/claudebot/.bun/bin/bun run /home/claudebot/claude-bot/hooks/pretooluse-guard.ts"
          }
        ]
      }
    ]
  }
}
```

Notes:

- **`matcher`** is a regex against the tool name. `Bash|create_draft` fires the
  hook for every `Bash` command (the hardline floor + the `[AUTO]` reminder
  block) and for Gmail's `create_draft` (the `[AUTO]` draft block), and for
  nothing else — so unrelated tools (`Read`, `Grep`, …) keep zero overhead. If
  you don't use `[AUTO]` Gmail at all, `"Bash"` alone is enough for the floor.
- **Absolute paths.** Hook commands don't inherit the interactive `PATH`, so
  point at the real `bun` (confirm with `which bun`; it's usually
  `~/.bun/bin/bun`) and at the absolute hook path. Adjust both if the repo or
  user lives elsewhere.
- **Restart required.** The poller must be restarted (tmux `bot` → `start.sh`)
  for the new spawns to pick up the settings.
- **Verify after wiring:** in the chat, ask the bot to run `rm -rf /tmp/x`
  (should succeed) and `rm -rf /` (should be refused with the guard reason).

## Tests

The rules are covered by `guard.test.ts` (golden block/allow table). Run:

```
bun test guard.test.ts
```
