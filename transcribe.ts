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

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

/** One multipart POST to Groq's OpenAI-compatible transcription endpoint.
 *  The Telegram .oga (ogg/opus) uploads as-is — no ffmpeg on this path.
 *  Retries exactly once on network errors and 5xx; 4xx is the caller's
 *  problem (bad key, rate limit) and surfaces immediately. */
export async function groqTranscribe(
  path: string,
  opts: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {},
): Promise<Transcript> {
  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY ?? "";
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? VOICE_TIMEOUT_MS;

  // Read eagerly into a named File: Groq validates by the uploaded filename's
  // extension and rejects Telegram's .oga (same ogg/opus container) — live 400
  // "file must be one of [... ogg opus ...]" 2026-06-11. Bun's FormData ignores
  // the explicit filename argument for lazy Bun.file blobs (the full PATH went
  // out as the name), so only an in-memory File reliably carries "voice.ogg".
  // Voice notes are capped at VOICE_MAX_SEC ≈ a couple of MB — fine to hold.
  const audio = new File([await Bun.file(path).arrayBuffer()], "voice.ogg", {
    type: "audio/ogg",
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Rebuilt per attempt — a FormData body may not be reusable after a send.
    const form = new FormData();
    form.append("file", audio);
    form.append("model", opts.model ?? GROQ_STT_MODEL);
    form.append("response_format", "verbose_json");
    // 4xx and malformed-body errors are final; network/abort errors retry once.
    // The flag (not a message match) decides, so an error thrown mid-body-read
    // can never be misclassified as retryable.
    let final = false;
    try {
      const res = await fetchFn(GROQ_STT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500) {
        lastErr = new Error(`groq HTTP ${res.status}`);
        continue; // retry once on server errors
      }
      if (!res.ok) {
        final = true;
        let body = "(body unreadable)";
        try {
          body = (await res.text()).slice(0, 200);
        } catch {}
        throw new Error(`groq HTTP ${res.status}: ${body}`);
      }
      let data: any;
      try {
        data = await res.json();
      } catch {
        final = true;
        throw new Error("groq returned a malformed body");
      }
      if (typeof data?.text !== "string") {
        final = true;
        throw new Error("groq response has no text field");
      }
      return { text: data.text.trim(), confidence: deriveConfidence(data.segments) };
    } catch (e: any) {
      if (final) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Replace every {input} in the template with the single-quoted path. The
 *  quote-escape ('\'') means a malicious filename cannot break out — though
 *  in practice the poller always passes its own uploads/<ts>-voice.oga path. */
export function buildLocalCommand(template: string, inputPath: string): string {
  const quoted = `'${inputPath.replace(/'/g, `'\\''`)}'`;
  return template.split("{input}").join(quoted);
}

/** Run the operator-configured TRANSCRIBE_CMD (e.g. ffmpeg → whisper.cpp; see
 *  DEPLOY.md) and parse its stdout JSON. Killed after timeoutMs. */
export async function localTranscribe(
  path: string,
  opts: {
    cmd?: string;
    timeoutMs?: number;
    spawnFn?: typeof Bun.spawn;
  } = {},
): Promise<Transcript> {
  const template = opts.cmd ?? process.env.TRANSCRIBE_CMD ?? "";
  if (!template) throw new Error("TRANSCRIBE_CMD is not set");
  const spawnFn = opts.spawnFn ?? Bun.spawn;
  const timeoutMs = opts.timeoutMs ?? VOICE_TIMEOUT_MS;

  const proc = spawnFn(["/bin/sh", "-c", buildLocalCommand(template, path)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // SIGKILL, not the default SIGTERM: a transcriber that traps SIGTERM would
  // otherwise keep exited/stdout open forever and hang the await below.
  const killer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, timeoutMs);
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as any).text(),
      new Response(proc.stderr as any).text().catch(() => ""),
    ]);
    if (code !== 0) {
      throw new Error(`local transcriber exited ${code}: ${err.slice(0, 200)}`);
    }
    return parseLocalOutput(out);
  } finally {
    clearTimeout(killer);
  }
}

/** The poller's single entry point: resolve the backend from env, dispatch.
 *  env/io are injectable for tests; production callers pass nothing. */
export async function transcribeVoice(
  path: string,
  env: Record<string, string | undefined> = process.env,
  io: { fetchFn?: typeof fetch; spawnFn?: typeof Bun.spawn } = {},
): Promise<Transcript> {
  const backend = resolveBackend(env);
  if (backend === "groq") {
    return groqTranscribe(path, { apiKey: env.GROQ_API_KEY, fetchFn: io.fetchFn });
  }
  if (backend === "local") {
    return localTranscribe(path, { cmd: env.TRANSCRIBE_CMD, spawnFn: io.spawnFn });
  }
  throw new Error("voice transcription is not configured");
}
