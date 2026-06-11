/**
 * review.ts — the background self-improvement pass (Phase 7 head start).
 *
 * After the bot replies, the poller may spawn ONE detached, cheap claude -p
 * whose tools are whitelisted to exactly `bun run mem.ts *` and
 * `bun run skill.ts *`. It rereads the recent exchange and persists durable
 * facts / reusable procedures through the SAME guarded CLIs as everything else
 * (derived → quarantine; do-NOT-capture rejects). Quiet by design: its stdout
 * is discarded; the nightly summary surfaces what was learned.
 *
 * No --dangerously-skip-permissions here: in non-interactive mode, tools NOT
 * on the whitelist are denied, which is the point. CLAUDE_AUTO_SESSION=1 keeps
 * the guard hook's least-privilege layer on as defense in depth.
 */

export const REVIEW_COOLDOWN_S = Number(process.env.REVIEW_COOLDOWN_S ?? 900);

export const REVIEW_ALLOWED_TOOLS = [
  "Bash(bun run mem.ts *)",
  "Bash(bun run skill.ts *)",
];

export function reviewSpawnArgs(model = "haiku"): string[] {
  return ["-p", "--model", model, "--allowedTools", ...REVIEW_ALLOWED_TOOLS];
}

const lastReviewAt = new Map<number, number>();

/** True (and stamps the clock) when this chat hasn't been reviewed for 15 min. */
export function shouldReview(
  chatId: number,
  nowEpoch: number,
  state: Map<number, number> = lastReviewAt,
): boolean {
  const last = state.get(chatId) ?? 0;
  if (nowEpoch - last < REVIEW_COOLDOWN_S) return false;
  state.set(chatId, nowEpoch);
  return true;
}

export function buildReviewPrompt(transcript: { role: string; content: string }[]): string {
  return [
    "You are the assistant bot's after-conversation reviewer. Below are the latest exchanges between Maor and the bot.",
    "Your ONLY job: decide whether anything deserves persisting, and persist it with these Bash commands:",
    '  bun run mem.ts add --kind user|agent --source maor|derived --content "<short fact>"',
    "  bun run skill.ts search <query> | view <name> | create --name <slug> --desc \"Use when …\" --source maor --body \"<steps>\" | patch --name <slug> --old \"<substr>\" --new \"<text>\"",
    "Rules:",
    "- Durable facts Maor states about himself (preferences, recurring details) → mem.ts add --kind user --source maor.",
    "- Anything learned from emails/web pages/files (outside content) → --source derived. It will quarantine for Maor's approval — that is correct, do not work around it.",
    "- A procedure that WORKED in this conversation and will clearly repeat → a skill. SEARCH FIRST; PATCH an existing close skill instead of creating a near-duplicate; only then create.",
    '- Corrections from Maor ("תפסיק", "אל תעשה", "too verbose", "answer shorter") are first-class: persist the corrected behavior (memory for preferences; skill patch when a skill caused the mistake).',
    "- Do NOT save one-off task narratives, negative tool claims, secrets, or anything already persisted (the CLIs also reject some of these — respect their refusals, do not rephrase to sneak past).",
    "- Hebrew content stays in Hebrew. Keep every entry short.",
    "- If nothing qualifies: do nothing and finish. Your text output is discarded either way.",
    "",
    "Transcript (oldest first):",
    ...transcript.map((m) => `[${m.role}] ${m.content}`),
  ].join("\n");
}

/** Fire-and-forget review run. Never throws into the caller; logs its exit. */
export function runReview(
  transcript: { role: string; content: string }[],
  opts: { claudeBin: string; cwd: string; env: Record<string, string | undefined> },
): void {
  try {
    const proc = Bun.spawn([opts.claudeBin, ...reviewSpawnArgs()], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...opts.env, CLAUDE_AUTO_SESSION: "1" },
    });
    proc.stdin!.write(buildReviewPrompt(transcript));
    proc.stdin!.end();
    void proc.exited.then(async (code) => {
      const err = code === 0 ? "" : (await new Response(proc.stderr).text()).slice(0, 300);
      console.log(`[REVIEW] exit ${code}${err ? ` — ${err}` : ""}`);
    });
  } catch (e: any) {
    console.error(`[ERR] review spawn: ${e?.message ?? e}`);
  }
}
