/**
 * model.ts — cheap model routing, no extra LLM call.
 *
 * Default to a fast model (Sonnet); escalate to Opus only on an explicit trigger
 * or a clear signal. Deliberately NOT an LLM classifier: a per-message routing
 * call would re-pay the `claude -p` startup/connector-init cost on every message,
 * which would dominate the latency we're trying to save.
 */

export type Model = "sonnet" | "opus";

export interface Routed {
  model: Model;
  prompt: string; // message with any /command prefix removed
}

const OPUS_KEYWORDS = ["think hard", "use opus", "ultrathink", "deep dive", "reason carefully"];
const OPUS_PREFIX = /^\/opus\b[ \t]*/i;
const SONNET_PREFIX = /^\/sonnet\b[ \t]*/i;

export function pickModel(text: string): Routed {
  const trimmed = text.trim();

  // Explicit slash prefixes win and are stripped from the prompt.
  if (OPUS_PREFIX.test(trimmed)) return { model: "opus", prompt: trimmed.replace(OPUS_PREFIX, "") };
  if (SONNET_PREFIX.test(trimmed)) return { model: "sonnet", prompt: trimmed.replace(SONNET_PREFIX, "") };

  // Cheap signals that a stronger model is worth it.
  const lower = trimmed.toLowerCase();
  const wantsOpus = OPUS_KEYWORDS.some((k) => lower.includes(k)) || trimmed.includes("```");

  return { model: wantsOpus ? "opus" : "sonnet", prompt: trimmed };
}
