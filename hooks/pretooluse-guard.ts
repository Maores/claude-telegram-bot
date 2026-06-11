#!/usr/bin/env bun
/**
 * pretooluse-guard.ts — Claude Code PreToolUse hook for the Telegram bot.
 *
 * Claude Code runs this once before every tool call it is registered for. It
 * reads the hook payload as JSON on stdin, applies guard.ts, and:
 *   - exits 2 (with the reason on stderr) to BLOCK the tool call, or
 *   - exits 0 to allow it.
 *
 * What it enforces:
 *   1. The hardline floor (guard.checkCommand) on every Bash command — refuses
 *      the handful of catastrophic commands (rm -rf /, mkfs, dd to a device,
 *      fork bombs, shutdown, ssh/.env/self tampering, force-push to main,
 *      curl|sh). Applies in every session, even full-permission ones.
 *   2. Extra least-privilege denials (guard.checkAutoSession) ONLY when the
 *      spawning process set CLAUDE_AUTO_SESSION=1 — i.e. unattended [AUTO]
 *      reminder runs. Those sessions additionally may not schedule reminders
 *      (self-replication guard) or create Gmail drafts.
 *
 * Non-Bash tools pass through in normal sessions; the only non-Bash tool this
 * hook ever blocks is Gmail's create_draft, and only inside an [AUTO] session.
 *
 * Fail-closed: if a guard rule throws on a real tool call, the hook denies
 * rather than allows. A payload it cannot parse at all is passed through (exit
 * 0) so a malformed hook event can never brick the bot.
 *
 * This file is wired via settings.json on the droplet — see hooks/README.md.
 * It is intentionally NOT registered automatically by the PR that adds it.
 */
import { checkCommand, checkAutoSession } from "../guard";

function block(reason: string): never {
  console.error(`[guard] ${reason}`);
  process.exit(2);
}

const raw = await Bun.stdin.text();

let input: any;
try {
  input = JSON.parse(raw);
} catch {
  // Unparseable payload — we can't identify a tool call, so don't block.
  process.exit(0);
}

const toolName: string = typeof input?.tool_name === "string" ? input.tool_name : "";
const command: string | undefined =
  typeof input?.tool_input?.command === "string" ? input.tool_input.command : undefined;
const isAuto = process.env.CLAUDE_AUTO_SESSION === "1";

try {
  if (isAuto) {
    const a = checkAutoSession(toolName, command);
    if (a.verdict === "block") block(a.reason ?? "blocked by [AUTO] least-privilege policy");
  }
  if (toolName === "Bash" && typeof command === "string") {
    const v = checkCommand(command);
    if (v.verdict === "block") block(v.reason ?? "blocked by the hardline guard");
  }
} catch (e: any) {
  // Deny on error — the hardline layer fails closed (see the survey's
  // "don't regress" note on fail-open scanners).
  block(`guard error (failing closed): ${e?.message ?? e}`);
}

process.exit(0);
