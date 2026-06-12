/**
 * guard.ts — a hardline blocklist of catastrophic shell commands.
 *
 * This is the Phase 4 "protection floor": a small, fail-closed set of named
 * rules that refuse the handful of commands that can wreck the droplet or the
 * bot's own security, even though the bot otherwise runs claude -p with full
 * permissions. It is enforced by the PreToolUse hook (hooks/pretooluse-guard.ts)
 * and is intentionally narrow — it blocks only the unambiguously catastrophic,
 * never the merely risky, so it stays out of the way of everyday work.
 *
 * Design notes:
 *  - Rules match commands in *command position* (the first word of a pipeline
 *    segment, after an optional `sudo`/path prefix), so a command that merely
 *    *mentions* a dangerous word as data — `echo "shutdown"`, `grep "rm -rf"` —
 *    is left alone.
 *  - Sensitive-path rules (ssh, the telegram .env, guard/hook files) block only
 *    on write intent, so reads still work.
 *  - Pure functions, no IO: the hook does the IO and fails closed if a rule
 *    throws (see hooks/pretooluse-guard.ts).
 */

export type GuardVerdict = { verdict: "allow" | "block"; reason?: string };

// A pipeline/command segment begins at the start of the string or right after a
// shell separator. Plain whitespace does NOT start a new command, which is what
// lets us tell `shutdown ...` (command) from `echo shutdown` (argument).
const SEG = String.raw`(?:^|[;&|(){}\n]+)\s*(?:sudo\s+)?(?:\/?[\w.-]+\/)*`;

/** Build a case-insensitive regex that matches `keyword` in command position. */
function cmdRe(keyword: string): RegExp {
  return new RegExp(SEG + "(?:" + keyword + String.raw`)\b`, "i");
}

// A recursive flag: a short cluster containing r/R (-rf, -fr, -R, -r) or --recursive.
const hasRecursive = (c: string): boolean =>
  /(?:^|\s)-[a-zA-Z]*r[a-zA-Z]*(?=\s|$)/i.test(c) || /\s--recursive(?=\s|$)/i.test(c);

// A catastrophic root target as a standalone argument: /, /*, ~, ~/, $HOME, ${HOME}
// (optionally quoted). A path like /tmp/foo or ./build is deliberately NOT matched.
const hasDangerousRoot = (c: string): boolean =>
  /(?:^|\s)(["']?)(?:\/|~|\$\{?HOME\}?)(?:\/\*?|\*)?\1(?=$|\s|[;&|])/.test(c);

// Write-intent verbs/operators, used only together with a sensitive-path match.
const WRITE_INTENT =
  /(?:>>?|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\binstall\b|\bdd\b|\bchmod\b|\bchown\b|\bln\b)/i;

// Sensitive paths.
const SSH_PATH = /(?:~|\$\{?HOME\}?|\/home\/[\w.-]+|\/root)\/\.ssh\b/i;
const ENV_PATH = /\.claude\/channels\/telegram\/\.env\b/i;
const SELF_PATH = /(?:^|[\s'"=/])(?:guard\.ts|hooks\/pretooluse-guard\.ts|hooks\/[\w.-]+\.ts)\b/i;

interface Rule {
  name: string;
  reason: string;
  test: (cmd: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: "recursive-rm-root",
    reason: "refused: recursive rm targeting / , ~ or $HOME would destroy the system",
    test: (c) => cmdRe("rm").test(c) && hasRecursive(c) && hasDangerousRoot(c),
  },
  {
    name: "mkfs",
    reason: "refused: mkfs would reformat a filesystem",
    test: (c) => new RegExp(SEG + String.raw`mkfs(?:\.\w+)?\b`, "i").test(c),
  },
  {
    name: "dd-to-block-device",
    reason: "refused: dd writing to a block device would overwrite a disk",
    test: (c) =>
      cmdRe("dd").test(c) &&
      /\bof=['"]?\/dev\/(?:sd|nvme|hd|vd|xvd|mmcblk|loop|dm-|disk|sr|fd)\w*/i.test(c),
  },
  {
    name: "fork-bomb",
    reason: "refused: fork bomb would exhaust the process table",
    test: (c) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c),
  },
  {
    name: "power-state",
    reason: "refused: shutdown/reboot/halt/poweroff would take the droplet offline",
    test: (c) => cmdRe("shutdown|reboot|halt|poweroff").test(c),
  },
  {
    name: "recursive-chmod-chown-root",
    reason: "refused: recursive chmod/chown on / would break every permission on the box",
    test: (c) => cmdRe("ch(?:mod|own)").test(c) && hasRecursive(c) && hasDangerousRoot(c),
  },
  {
    name: "ssh-tamper",
    reason: "refused: writing to ~/.ssh could plant an attacker's key or destroy yours",
    test: (c) => SSH_PATH.test(c) && (WRITE_INTENT.test(c) || /sed\s+-i/i.test(c)),
  },
  {
    name: "telegram-env-tamper",
    reason: "refused: writing to the telegram .env could steal or wreck the bot token",
    test: (c) => ENV_PATH.test(c) && WRITE_INTENT.test(c),
  },
  {
    name: "self-tamper",
    reason: "refused: editing guard.ts or the hook files would disable the safety policy",
    test: (c) => SELF_PATH.test(c) && WRITE_INTENT.test(c),
  },
  {
    name: "force-push-main",
    reason: "refused: git push --force to main can erase shared history",
    test: (c) =>
      /\bgit\s+push\b/i.test(c) &&
      /(?:\s)(?:--force(?:-with-lease)?|-[a-zA-Z]*f[a-zA-Z]*)\b/i.test(c) &&
      /[\s:]main\b/i.test(c),
  },
  {
    name: "pipe-to-shell",
    reason: "refused: piping curl/wget straight into a shell runs unreviewed remote code",
    test: (c) =>
      /(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|ksh|fish)\b/i.test(c) ||
      /\b(?:bash|sh|zsh|dash|ksh)\s+-c\s+["']?\$\((?:curl|wget)\b/i.test(c),
  },
];

/** The hardline floor. Returns block (with a reason) for catastrophic commands. */
export function checkCommand(cmd: string): GuardVerdict {
  const c = (cmd ?? "").trim();
  if (!c) return { verdict: "allow" };
  for (const rule of RULES) {
    if (rule.test(c)) return { verdict: "block", reason: rule.reason };
  }
  return { verdict: "allow" };
}

/**
 * Extra least-privilege denials for unattended [AUTO] sessions, layered on top
 * of the hardline floor. An [AUTO] reminder must not be able to (a) schedule
 * more reminders — a self-replication guard — or (b) file Gmail drafts. The
 * Gmail connector's server name is a per-deployment UUID, so we match on the
 * tool's action suffix rather than the full namespaced tool name.
 */
export function checkAutoSession(toolName: string, command: string | undefined): GuardVerdict {
  if (toolName === "Bash" && command) {
    const base = checkCommand(command);
    if (base.verdict === "block") return base;
  }
  if (/(?:^|__)create_draft$/i.test(toolName)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions may not create Gmail drafts" };
  }
  if (toolName === "Bash" && command && /\bremind\.ts\s+add(?:-once|-repeat)?\b/i.test(command)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions may not schedule reminders" };
  }
  if (toolName === "Bash" && command && /\bconfirm\.ts\s+approve\b/i.test(command)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions may not approve pending actions" };
  }
  if (toolName === "Bash" && command && /\bcal\.ts\s+(add|edit|delete)\b/i.test(command)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions propose calendar writes via confirm.ts, not directly" };
  }
  if (toolName === "Bash" && command && /\btodo\.ts\s+delete\b/i.test(command)) {
    return { verdict: "block", reason: "refused: [AUTO] sessions propose task deletions via confirm.ts, not directly" };
  }
  return { verdict: "allow" };
}
