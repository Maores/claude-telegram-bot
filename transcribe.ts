/**
 * transcribe.ts — voice-note transcription behind one interface (Phase 6).
 *
 * Two swappable backends (hermes survey §B1 "local_command" pattern):
 *  - groq: hosted whisper-large-v3-turbo via the OpenAI-compatible endpoint.
 *    Free tier; excellent Hebrew; the .oga uploads as-is (no ffmpeg).
 *  - local: any shell command template (TRANSCRIBE_CMD with {input}) that
 *    prints {"text": "...", "confidence": 0..1?} JSON — intended for a future
 *    whisper.cpp install on the droplet (see DEPLOY.md). Operator config only,
 *    same trust level as CLAUDE_BIN.
 *
 * Every backend returns { text, confidence|null }; the poller echoes the
 * transcript back to Maor only when confidence is below VOICE_ECHO_BELOW.
 */

export interface Transcript {
  text: string;
  confidence: number | null;
}

/** Parse a numeric env var. Unlike `Number(x ?? d) || d`, an explicit "0" is
 *  respected — VOICE_ECHO_BELOW=0 is the documented "never echo" switch. Empty
 *  and junk values fall back to the default (the REVIEW_COOLDOWN_S lesson). */
export function envNum(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export const VOICE_MAX_SEC = envNum(process.env.VOICE_MAX_SEC, 300);
export const VOICE_ECHO_BELOW = envNum(process.env.VOICE_ECHO_BELOW, 0.6);
export const VOICE_TIMEOUT_MS = envNum(process.env.VOICE_TIMEOUT_MS, 45_000);

export type Backend = "groq" | "local" | "off";

/** Explicit TRANSCRIBE_BACKEND wins; else groq if a key exists, else local if
 *  a command exists, else off. Unknown explicit values fall through to auto. */
export function resolveBackend(
  env: Record<string, string | undefined> = process.env,
): Backend {
  const explicit = (env.TRANSCRIBE_BACKEND ?? "").trim().toLowerCase();
  if (explicit === "groq" || explicit === "local" || explicit === "off") return explicit;
  if (env.GROQ_API_KEY) return "groq";
  if (env.TRANSCRIBE_CMD) return "local";
  return "off";
}

/** Echo the transcript back only when the backend reported low confidence.
 *  Unknown confidence (null) stays quiet; threshold 0 disables the echo. */
export function shouldEchoTranscript(
  confidence: number | null,
  threshold = VOICE_ECHO_BELOW,
): boolean {
  return confidence !== null && confidence < threshold;
}

/** OpenAI-verbose_json-style segment; both Groq and whisper.cpp variants fit. */
export interface Segment {
  avg_logprob?: number;
  start?: number;
  end?: number;
}

/** Duration-weighted mean of exp(avg_logprob), clamped to [0, 1]. Null when the
 *  backend gave us nothing to judge by — the echo logic then stays quiet. */
export function deriveConfidence(segments: Segment[] | undefined): number | null {
  if (!segments?.length) return null;
  let weighted = 0;
  let total = 0;
  for (const s of segments) {
    if (typeof s.avg_logprob !== "number" || !Number.isFinite(s.avg_logprob)) continue;
    const dur = Math.max((s.end ?? 0) - (s.start ?? 0), 0.01);
    weighted += Math.exp(s.avg_logprob) * dur;
    total += dur;
  }
  if (total === 0) return null;
  return Math.min(1, Math.max(0, weighted / total));
}

/** Contract for the local backend: stdout is one JSON object,
 *  {"text": string, "confidence"?: number 0..1}. Anything else throws. */
export function parseLocalOutput(stdout: string): Transcript {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`local transcriber printed non-JSON: ${stdout.slice(0, 120)}`);
  }
  if (typeof parsed?.text !== "string") {
    throw new Error("local transcriber JSON has no text field");
  }
  const c = parsed.confidence;
  const confidence =
    typeof c === "number" && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
  return { text: parsed.text.trim(), confidence };
}
