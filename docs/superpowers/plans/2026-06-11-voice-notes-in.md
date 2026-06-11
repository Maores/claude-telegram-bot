# Voice Notes In (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maor sends a Telegram voice bubble; the bot transcribes it (Groq hosted whisper by default, swappable local command backend) and answers as if it were typed, echoing the transcript only when confidence is low.

**Architecture:** A new `transcribe.ts` module owns everything audio→text behind a `{ text, confidence }` interface, with backend resolution from env (`groq` / `local` / `off`). `poller.ts` gains a voice branch that gates on duration/size, downloads via the existing helper, transcribes, then feeds the transcript through the untouched typed-message flow; a `renderPrefix` option on `streamClaude` paints the 🎤 echo line into every streamed edit. `redact.ts` learns the Groq key shape.

**Tech Stack:** Bun (zero npm deps), `bun:test`, Telegram Bot API, Groq OpenAI-compatible `audio/transcriptions` endpoint.

**Spec:** `docs/superpowers/specs/2026-06-11-voice-notes-design.md` (approved 2026-06-11).

**Conventions used throughout:** tests are flat `test()` blocks from `bun:test` testing exported pure functions; network and process spawns are injected (`fetchFn`, `spawnFn`) never mocked globally; numeric env vars must survive empty-string values (the `REVIEW_COOLDOWN_S` lesson, commit 1aba006); run the whole suite with `bun test` from the repo root; commit messages follow `feat(scope): …` / `test(scope): …` style with the Claude co-author trailer.

---

### Task 0: Feature branch

**Files:** none

- [ ] **Step 0.1: Branch off main**

```bash
git checkout main && git pull && git checkout -b feat/voice-notes
```

Expected: `Switched to a new branch 'feat/voice-notes'`. (If `git pull` fails because the network blocks GitHub too, continue from local main — it is at `c5a9653` or later.)

---

### Task 1: `transcribe.ts` — config helpers (`envNum`, `resolveBackend`, `shouldEchoTranscript`)

**Files:**
- Create: `transcribe.test.ts`
- Create: `transcribe.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `transcribe.test.ts` with exactly:

```ts
import { test, expect } from "bun:test";
import {
  envNum,
  resolveBackend,
  shouldEchoTranscript,
} from "./transcribe";

// --- envNum: numeric env parsing that survives empty strings ------------------

test("envNum returns the default for undefined and empty/whitespace strings", () => {
  expect(envNum(undefined, 300)).toBe(300);
  expect(envNum("", 300)).toBe(300);
  expect(envNum("   ", 300)).toBe(300);
});

test("envNum accepts an explicit 0 (unlike the `|| default` idiom)", () => {
  expect(envNum("0", 0.6)).toBe(0);
});

test("envNum falls back to the default on junk", () => {
  expect(envNum("abc", 45000)).toBe(45000);
});

test("envNum parses normal numbers", () => {
  expect(envNum("120", 300)).toBe(120);
  expect(envNum("0.4", 0.6)).toBe(0.4);
});

// --- resolveBackend: explicit env wins, then key, then cmd, then off ----------

test("resolveBackend honors an explicit TRANSCRIBE_BACKEND", () => {
  expect(resolveBackend({ TRANSCRIBE_BACKEND: "groq" })).toBe("groq");
  expect(resolveBackend({ TRANSCRIBE_BACKEND: "local", GROQ_API_KEY: "k" })).toBe("local");
  expect(resolveBackend({ TRANSCRIBE_BACKEND: "off", GROQ_API_KEY: "k", TRANSCRIBE_CMD: "c" })).toBe("off");
  expect(resolveBackend({ TRANSCRIBE_BACKEND: " GROQ " })).toBe("groq"); // trims + case-insensitive
});

test("resolveBackend auto-selects groq when only the key is present", () => {
  expect(resolveBackend({ GROQ_API_KEY: "gsk_x" })).toBe("groq");
});

test("resolveBackend auto-selects local when only the command is present", () => {
  expect(resolveBackend({ TRANSCRIBE_CMD: "whisper {input}" })).toBe("local");
});

test("resolveBackend prefers groq when both key and command are present", () => {
  expect(resolveBackend({ GROQ_API_KEY: "k", TRANSCRIBE_CMD: "c" })).toBe("groq");
});

test("resolveBackend is off when nothing is configured", () => {
  expect(resolveBackend({})).toBe("off");
});

test("resolveBackend treats an unknown explicit value as not-set (falls through)", () => {
  expect(resolveBackend({ TRANSCRIBE_BACKEND: "banana", GROQ_API_KEY: "k" })).toBe("groq");
});

// --- shouldEchoTranscript: echo only on low confidence -------------------------

test("shouldEchoTranscript echoes below the threshold only", () => {
  expect(shouldEchoTranscript(0.3, 0.6)).toBe(true);
  expect(shouldEchoTranscript(0.6, 0.6)).toBe(false); // at threshold = no echo
  expect(shouldEchoTranscript(0.9, 0.6)).toBe(false);
});

test("shouldEchoTranscript never echoes when confidence is unknown", () => {
  expect(shouldEchoTranscript(null, 0.6)).toBe(false);
});

test("shouldEchoTranscript with threshold 0 disables the echo entirely", () => {
  expect(shouldEchoTranscript(0.0001, 0)).toBe(false);
  expect(shouldEchoTranscript(0, 0)).toBe(false);
});
```

- [ ] **Step 1.2: Run the tests — expect failure**

Run: `bun test transcribe.test.ts`
Expected: FAIL — `Cannot find module './transcribe'`.

- [ ] **Step 1.3: Create `transcribe.ts` with the minimal implementation**

```ts
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
```

- [ ] **Step 1.4: Run the tests — expect pass**

Run: `bun test transcribe.test.ts`
Expected: all tests pass.

- [ ] **Step 1.5: Run the full suite, then commit**

Run: `bun test`
Expected: every existing test still passes.

```bash
git add transcribe.ts transcribe.test.ts
git commit -m "feat(voice): transcribe.ts config helpers - envNum, resolveBackend, echo threshold

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `transcribe.ts` — `deriveConfidence` and `parseLocalOutput`

**Files:**
- Modify: `transcribe.test.ts` (append)
- Modify: `transcribe.ts` (append)

- [ ] **Step 2.1: Append the failing tests to `transcribe.test.ts`**

Extend the import at the top of `transcribe.test.ts` to:

```ts
import {
  envNum,
  resolveBackend,
  shouldEchoTranscript,
  deriveConfidence,
  parseLocalOutput,
} from "./transcribe";
```

Append:

```ts
// --- deriveConfidence: duration-weighted mean of exp(avg_logprob) -------------

test("deriveConfidence is null for missing or empty segments", () => {
  expect(deriveConfidence(undefined)).toBeNull();
  expect(deriveConfidence([])).toBeNull();
});

test("deriveConfidence is null when no segment has avg_logprob", () => {
  expect(deriveConfidence([{ start: 0, end: 2 }])).toBeNull();
});

test("deriveConfidence on one segment is exp(avg_logprob)", () => {
  const c = deriveConfidence([{ avg_logprob: Math.log(0.8), start: 0, end: 2 }]);
  expect(c).toBeCloseTo(0.8, 5);
});

test("deriveConfidence weights segments by duration", () => {
  // 1s at 0.9 and 3s at 0.5 → (0.9*1 + 0.5*3) / 4 = 0.6
  const c = deriveConfidence([
    { avg_logprob: Math.log(0.9), start: 0, end: 1 },
    { avg_logprob: Math.log(0.5), start: 1, end: 4 },
  ]);
  expect(c).toBeCloseTo(0.6, 5);
});

test("deriveConfidence clamps into [0, 1] and survives missing start/end", () => {
  const c = deriveConfidence([{ avg_logprob: 0.5 }]); // exp(0.5) ≈ 1.65 → clamp 1
  expect(c).toBe(1);
});

// --- parseLocalOutput: the local-command JSON contract -------------------------

test("parseLocalOutput parses text and clamps confidence", () => {
  expect(parseLocalOutput('{"text": " שלום ", "confidence": 0.7}')).toEqual({
    text: "שלום",
    confidence: 0.7,
  });
  expect(parseLocalOutput('{"text": "hi", "confidence": 7}')).toEqual({
    text: "hi",
    confidence: 1,
  });
});

test("parseLocalOutput defaults a missing or junk confidence to null", () => {
  expect(parseLocalOutput('{"text": "hi"}')).toEqual({ text: "hi", confidence: null });
  expect(parseLocalOutput('{"text": "hi", "confidence": "high"}')).toEqual({
    text: "hi",
    confidence: null,
  });
});

test("parseLocalOutput throws on non-JSON stdout", () => {
  expect(() => parseLocalOutput("whisper: command not found")).toThrow(/non-JSON/);
});

test("parseLocalOutput throws when the text field is missing", () => {
  expect(() => parseLocalOutput('{"transcript": "hi"}')).toThrow(/no text field/);
});
```

- [ ] **Step 2.2: Run — expect the new tests to fail**

Run: `bun test transcribe.test.ts`
Expected: FAIL — `deriveConfidence is not exported` (or equivalent).

- [ ] **Step 2.3: Append the implementation to `transcribe.ts`**

```ts
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
    if (typeof s.avg_logprob !== "number") continue;
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
```

- [ ] **Step 2.4: Run — expect pass**

Run: `bun test transcribe.test.ts`
Expected: all pass.

- [ ] **Step 2.5: Commit**

```bash
git add transcribe.ts transcribe.test.ts
git commit -m "feat(voice): confidence derivation + local-command output contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `transcribe.ts` — `groqTranscribe` (injected fetch)

**Files:**
- Modify: `transcribe.test.ts` (append)
- Modify: `transcribe.ts` (append)

- [ ] **Step 3.1: Append the failing tests**

Extend the import list with `groqTranscribe`. Append:

```ts
// --- groqTranscribe: hosted whisper via OpenAI-compatible endpoint ------------
// fetchFn is injected; no network. The audio file itself is never read by the
// fake, so a nonexistent path is fine (Bun.file is lazy).

function groqOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("groqTranscribe sends auth, model, verbose_json — and parses the reply", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return groqOk({
      text: " תזכיר לי מחר ",
      segments: [{ avg_logprob: Math.log(0.9), start: 0, end: 2 }],
    });
  }) as typeof fetch;

  const tr = await groqTranscribe("uploads/none.oga", { apiKey: "gsk_test", fetchFn });
  expect(tr.text).toBe("תזכיר לי מחר");
  expect(tr.confidence).toBeCloseTo(0.9, 5);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect((calls[0].init.headers as any).authorization).toBe("Bearer gsk_test");
  const form = calls[0].init.body as FormData;
  expect(form.get("model")).toBe("whisper-large-v3-turbo");
  expect(form.get("response_format")).toBe("verbose_json");
  expect(form.get("file")).not.toBeNull();
});

test("groqTranscribe yields null confidence when segments are absent", async () => {
  const fetchFn = (async () => groqOk({ text: "hi" })) as typeof fetch;
  const tr = await groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn });
  expect(tr).toEqual({ text: "hi", confidence: null });
});

test("groqTranscribe retries once on a 5xx and then succeeds", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    if (n === 1) return new Response("boom", { status: 500 });
    return groqOk({ text: "ok" });
  }) as typeof fetch;
  const tr = await groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn });
  expect(tr.text).toBe("ok");
  expect(n).toBe(2);
});

test("groqTranscribe does NOT retry a 4xx (e.g. 429) and throws with the status", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response('{"error": "rate limit"}', { status: 429 });
  }) as typeof fetch;
  await expect(groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn })).rejects.toThrow(
    /groq HTTP 429/,
  );
  expect(n).toBe(1);
});

test("groqTranscribe retries once on a network error, then surfaces it", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  await expect(groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn })).rejects.toThrow(
    /ECONNREFUSED/,
  );
  expect(n).toBe(2);
});

test("groqTranscribe throws without an api key", async () => {
  const fetchFn = (async () => groqOk({ text: "x" })) as typeof fetch;
  await expect(
    groqTranscribe("uploads/none.oga", { apiKey: "", fetchFn }),
  ).rejects.toThrow(/GROQ_API_KEY/);
});

test("groqTranscribe throws on a 200 whose body has no text field", async () => {
  const fetchFn = (async () => groqOk({ uh: "oh" })) as typeof fetch;
  await expect(groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn })).rejects.toThrow(
    /no text field/,
  );
});
```

- [ ] **Step 3.2: Run — expect failure**

Run: `bun test transcribe.test.ts`
Expected: FAIL — `groqTranscribe is not exported`.

- [ ] **Step 3.3: Append the implementation**

Add `import { basename } from "node:path";` as the first import line of `transcribe.ts`, then append:

```ts
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

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Rebuilt per attempt — a FormData body may not be reusable after a send.
    const form = new FormData();
    form.append("file", Bun.file(path), basename(path) || "voice.oga");
    form.append("model", opts.model ?? GROQ_STT_MODEL);
    form.append("response_format", "verbose_json");
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
        throw new Error(`groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data: any = await res.json();
      if (typeof data?.text !== "string") throw new Error("groq response has no text field");
      return { text: data.text.trim(), confidence: deriveConfidence(data.segments) };
    } catch (e: any) {
      // 4xx and malformed-body errors are final; network/abort errors retry once.
      if (e instanceof Error && /groq HTTP 4\d\d|no text field/.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

- [ ] **Step 3.4: Run — expect pass**

Run: `bun test transcribe.test.ts`
Expected: all pass.

- [ ] **Step 3.5: Commit**

```bash
git add transcribe.ts transcribe.test.ts
git commit -m "feat(voice): groq backend - whisper-large-v3-turbo, one retry on 5xx/network

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `transcribe.ts` — `localTranscribe` (injected spawn) + `transcribeVoice` dispatch

**Files:**
- Modify: `transcribe.test.ts` (append)
- Modify: `transcribe.ts` (append)

- [ ] **Step 4.1: Append the failing tests**

Extend the import list with `buildLocalCommand`, `localTranscribe`, `transcribeVoice`. Append:

```ts
// --- localTranscribe: configurable command template (hermes local_command) ----

test("buildLocalCommand substitutes a shell-quoted path for every {input}", () => {
  expect(buildLocalCommand("whisper {input} -o {input}.json", "/up/a.oga")).toBe(
    "whisper '/up/a.oga' -o '/up/a.oga'.json",
  );
  // a single-quote in the path cannot break out of the quoting
  expect(buildLocalCommand("cat {input}", "/up/a'b.oga")).toBe("cat '/up/a'\\''b.oga'");
});

function fakeProc(stdout: string, code = 0, stderr = "") {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(code),
    kill() {},
  };
}

test("localTranscribe runs the template through /bin/sh and parses stdout JSON", async () => {
  const argvSeen: string[][] = [];
  const spawnFn = ((argv: string[]) => {
    argvSeen.push(argv);
    return fakeProc('{"text": "שלום עולם", "confidence": 0.4}');
  }) as unknown as typeof Bun.spawn;

  const tr = await localTranscribe("/up/v.oga", { cmd: "wsp {input}", spawnFn });
  expect(tr).toEqual({ text: "שלום עולם", confidence: 0.4 });
  expect(argvSeen[0][0]).toBe("/bin/sh");
  expect(argvSeen[0][1]).toBe("-c");
  expect(argvSeen[0][2]).toBe("wsp '/up/v.oga'");
});

test("localTranscribe throws when the command exits non-zero, including stderr", async () => {
  const spawnFn = (() => fakeProc("", 127, "wsp: not found")) as unknown as typeof Bun.spawn;
  await expect(localTranscribe("/up/v.oga", { cmd: "wsp {input}", spawnFn })).rejects.toThrow(
    /exited 127.*not found/s,
  );
});

test("localTranscribe throws when TRANSCRIBE_CMD is not configured", async () => {
  await expect(localTranscribe("/up/v.oga", { cmd: "" })).rejects.toThrow(/TRANSCRIBE_CMD/);
});

// --- transcribeVoice: dispatch by resolved backend ------------------------------

test("transcribeVoice throws a clear error when no backend is configured", async () => {
  await expect(transcribeVoice("/up/v.oga", {})).rejects.toThrow(/not configured/);
});

test("transcribeVoice dispatches to local when only a command is configured", async () => {
  const spawnFn = (() => fakeProc('{"text": "hi"}')) as unknown as typeof Bun.spawn;
  const tr = await transcribeVoice("/up/v.oga", { TRANSCRIBE_CMD: "wsp {input}" }, { spawnFn });
  expect(tr.text).toBe("hi");
});

test("transcribeVoice dispatches to groq when a key is configured", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ text: "hey" }), { status: 200 })) as typeof fetch;
  const tr = await transcribeVoice("/up/v.oga", { GROQ_API_KEY: "k" }, { fetchFn });
  expect(tr.text).toBe("hey");
});
```

- [ ] **Step 4.2: Run — expect failure**

Run: `bun test transcribe.test.ts`
Expected: FAIL — `buildLocalCommand is not exported`.

- [ ] **Step 4.3: Append the implementation**

```ts
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
  const killer = setTimeout(() => {
    try {
      proc.kill();
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
```

- [ ] **Step 4.4: Run — expect pass**

Run: `bun test transcribe.test.ts`
Expected: all pass.

- [ ] **Step 4.5: Run the full suite, then commit**

Run: `bun test`
Expected: all pass.

```bash
git add transcribe.ts transcribe.test.ts
git commit -m "feat(voice): local command backend + transcribeVoice dispatch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `redact.ts` — Groq key pattern

**Files:**
- Modify: `redact.test.ts` (append)
- Modify: `redact.ts:32-40` (PATTERNS array)

- [ ] **Step 5.1: Append the failing tests to `redact.test.ts`**

First check the existing import line at the top of `redact.test.ts`; make sure it includes both `redact` and `collectSecretValues` (add whichever is missing). Append:

```ts
test("redact masks a Groq-shaped key keeping the 4-char tail", () => {
  const out = redact("auth with gsk_AbCdEfGhIjKlMnOpQrStUvWx1234 please", []);
  expect(out).not.toContain("gsk_AbCdEfGhIjKlMnOpQrStUvWx1234");
  expect(out).toContain("[REDACTED…1234]");
});

test("collectSecretValues picks up GROQ_API_KEY by its name", () => {
  // layer 1 already covers the real key: the NAME matches /API_KEY/.
  expect(collectSecretValues({ GROQ_API_KEY: "supersecretvalue" })).toContain("supersecretvalue");
});
```

- [ ] **Step 5.2: Run — expect exactly one failure**

Run: `bun test redact.test.ts`
Expected: the `collectSecretValues` test already PASSES (the name matches `API_KEY`); the `gsk_` pattern test FAILS. This confirms layer 1 coverage and that layer 2 needs the new pattern.

- [ ] **Step 5.3: Add the pattern**

In `redact.ts`, inside the `PATTERNS` array, after the GitHub-tokens line, add:

```ts
  /\bgsk_[A-Za-z0-9]{20,}\b/g, // Groq API keys
```

- [ ] **Step 5.4: Run — expect pass**

Run: `bun test redact.test.ts`
Expected: all pass.

- [ ] **Step 5.5: Commit**

```bash
git add redact.ts redact.test.ts
git commit -m "feat(redact): mask Groq-shaped keys (gsk_...) on the output path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `poller.ts` — voice types, `voiceInfo`, prompt/history wrappers, unsupported-list change

**Files:**
- Modify: `poller.test.ts` (append + edit one existing test)
- Modify: `poller.ts:80-100` (types), `poller.ts:372-381` (unsupportedMediaKind), near `buildPrompt` (wrappers)

- [ ] **Step 6.1: Edit the existing unsupported-voice test and append the new tests**

In `poller.test.ts`, REPLACE the existing test `"unsupportedMediaKind labels a voice message"` (around line 138) with:

```ts
test("unsupportedMediaKind no longer labels voice — phase 6 reads it", () => {
  expect(
    unsupportedMediaKind({ message_id: 1, chat: { id: 1 }, voice: { file_id: "v", duration: 3 } }),
  ).toBeNull();
});
```

Extend the `./poller.ts` import list with `voiceInfo`, `voicePromptText`, `voiceHistoryNote`. Append:

```ts
// --- voiceInfo: describe a voice bubble without downloading (phase 6) ---------

test("voiceInfo returns null when there is no voice", () => {
  expect(voiceInfo({ message_id: 1, chat: { id: 1 }, text: "hi" })).toBeNull();
});

test("voiceInfo extracts file id, duration, and size", () => {
  const info = voiceInfo({
    message_id: 1,
    chat: { id: 1 },
    voice: { file_id: "v9", duration: 42, mime_type: "audio/ogg", file_size: 130_000 },
  });
  expect(info).toEqual({ fileId: "v9", duration: 42, size: 130_000 });
});

test("voiceInfo defaults a missing duration to 0", () => {
  const info = voiceInfo({ message_id: 1, chat: { id: 1 }, voice: { file_id: "v" } as any });
  expect(info?.duration).toBe(0);
});

// --- voice prompt/history wrappers ---------------------------------------------

test("voicePromptText marks the medium so Claude reads mishearings charitably", () => {
  const p = voicePromptText("תקבע לי תור לרופא");
  expect(p).toContain("voice note");
  expect(p).toContain("transcript");
  expect(p.endsWith("תקבע לי תור לרופא")).toBe(true);
});

test("voiceHistoryNote stores a compact searchable marker", () => {
  expect(voiceHistoryNote("call the bank")).toBe("[voice] call the bank");
});
```

- [ ] **Step 6.2: Run — expect failures**

Run: `bun test poller.test.ts`
Expected: FAIL — the edited unsupported test (voice still labeled) and missing exports.

- [ ] **Step 6.3: Implement in `poller.ts`**

(a) Replace the `TgMessage`'s `voice?: TgFile;` line and add a `TgVoice` interface above `TgMessage`:

```ts
interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}
```

and inside `TgMessage` change the media comment block to:

```ts
  voice?: TgVoice;
  // Media we recognize but can't open yet — used only to decline honestly.
  video?: TgFile;
  video_note?: TgFile;
  audio?: TgFile;
  animation?: TgFile;
  sticker?: TgFile;
```

(the `voice` line moves OUT of the "can't open" group, above the comment).

(b) In `unsupportedMediaKind`, delete the line `if (msg.voice) return "a voice message";`.

(c) Below `unsupportedMediaKind`, add:

```ts
/** Describe a voice bubble (file id, duration, size) WITHOUT downloading it,
 *  so the caller can gate on duration/size first. Null when not a voice msg. */
export function voiceInfo(
  msg: TgMessage,
): { fileId: string; duration: number; size?: number } | null {
  if (!msg.voice) return null;
  return {
    fileId: msg.voice.file_id,
    duration: msg.voice.duration ?? 0,
    size: msg.voice.file_size,
  };
}
```

(d) Right after `buildPrompt`, add:

```ts
/** What Claude sees for a voice note: the medium is named so it can read
 *  obvious mishearings charitably; the transcript stays the user's words. */
export function voicePromptText(transcript: string): string {
  return `[The user sent a voice note; this is its transcript — answer it like a typed message.]\n${transcript}`;
}

/** What history/recall stores for a voice note (file is transient). */
export function voiceHistoryNote(transcript: string): string {
  return `[voice] ${transcript}`;
}
```

- [ ] **Step 6.4: Run — expect pass**

Run: `bun test poller.test.ts`
Expected: all pass.

- [ ] **Step 6.5: Commit**

```bash
git add poller.ts poller.test.ts
git commit -m "feat(voice): poller voice types, voiceInfo gate helpers, prompt/history wrappers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `poller.ts` — `renderPrefix` on `streamClaude`

**Files:**
- Modify: `poller.ts:527-621` (SpawnOpts + streamClaude)

No new unit test: `streamClaude` spawns a real claude process and is exercised live (house style — same as the rest of the streaming path). The full suite still gates the commit.

- [ ] **Step 7.1: Extend `SpawnOpts`**

Add a field to the `SpawnOpts` interface (after `env`):

```ts
  /** Prepended to every Telegram render of this reply (and counted toward the
   *  4096-char chunking), but NOT part of the returned/stored answer text.
   *  Used for the 🎤 low-confidence transcript echo. */
  renderPrefix?: string;
```

- [ ] **Step 7.2: Apply the prefix at the three render sites in `streamClaude`**

At the top of `streamClaude`'s body (after the `const proc = Bun.spawn(...)` block is fine, but cleanest immediately before `const parser = new StreamParser();`):

```ts
  const prefix = opts.renderPrefix ?? "";
```

Then change the three `renderer.render(...)` calls:

- in `flush`: `renderer.render(prefix + displayText(parser.state()))`
- in the `timedOut` branch: `await renderer.render(prefix + final).catch(() => {});`
- the final render: `renderer.render(prefix + (final || "(no reply)"))`

The function still RETURNS bare `final` — the echo is presentation only; history stores the clean answer.

- [ ] **Step 7.3: Run the full suite**

Run: `bun test`
Expected: all pass (no behavior change when `renderPrefix` is unset — the default `""` concatenates to identity).

- [ ] **Step 7.4: Commit**

```bash
git add poller.ts
git commit -m "feat(voice): renderPrefix spawn option - echo line painted into streamed edits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `poller.ts` — the voice branch in `handleMessage`

**Files:**
- Modify: `poller.ts:653-806` (handleMessage), `poller.ts:1-14` (header comment)

This is handler glue around already-tested units (gates, download, transcribe, wrappers, prefix). No new unit tests — the full suite plus the live checklist (Task 10) cover it. Read the surrounding code before editing; line numbers may have drifted.

- [ ] **Step 8.1: Add the imports**

In the import block at the top of `poller.ts`, add:

```ts
import { resolveBackend, transcribeVoice, shouldEchoTranscript, VOICE_MAX_SEC } from "./transcribe";
```

- [ ] **Step 8.2: Insert the voice stage after the /stop block**

Directly after the `/stop` command block (it ends with `return; }` around line 682), and BEFORE the `// Identify a readable photo/document…` comment, insert:

```ts
  // Voice notes (phase 6): transcribe, then treat exactly like a typed message.
  // Gates run BEFORE the download; the ack fires early because transcription
  // adds latency before the ⏳ placeholder appears.
  const voice = voiceInfo(msg);
  let voiceText: string | null = null;
  let voiceConfidence: number | null = null;
  if (voice) {
    if (resolveBackend() === "off") {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "עוד לא מחובר אצלי תמלול קולי, אז אני לא יכול להאזין להקלטות כרגע.",
      }).catch(() => {});
      return;
    }
    if (voice.duration > VOICE_MAX_SEC) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `ההקלטה ארוכה מדי בשבילי — אני מתמלל עד ${Math.floor(VOICE_MAX_SEC / 60)} דקות.`,
      }).catch(() => {});
      return;
    }
    if (isTooLarge(voice.size)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "That file is too large for me to fetch — Telegram caps bot downloads at ~20 MB.",
      }).catch(() => {});
      return;
    }
    void setReaction(chatId, msg.message_id, REACTION_START);
    void sendTyping(chatId);

    let audioPath: string;
    try {
      audioPath = await downloadFile(voice.fileId, "voice.oga");
    } catch (e: any) {
      console.error(`[ERR] download voice from ${fromId}: ${e?.message ?? e}`);
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ I couldn't download that file from Telegram. Please try again.",
      }).catch(() => {});
      return;
    }
    try {
      const tr = await transcribeVoice(audioPath);
      voiceText = tr.text;
      voiceConfidence = tr.confidence;
    } catch (e: any) {
      console.error(`[ERR] transcribe voice from ${fromId}: ${e?.message ?? e}`);
      void setReaction(chatId, msg.message_id, outcomeReaction(false));
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ לא הצלחתי לתמלל את ההקלטה הפעם. אפשר לנסות שוב או לכתוב לי.",
      }).catch(() => {});
      return;
    } finally {
      // The audio is transient either way — transcribed or failed.
      cleanupFile(audioPath);
    }
    if (!voiceText.trim()) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "לא קלטתי מילים בהקלטה 🎤 אפשר לנסות שוב?",
      }).catch(() => {});
      return;
    }
  }
```

- [ ] **Step 8.3: Feed the transcript into the typed-message flow**

Four surgical edits in the rest of `handleMessage`:

(a) The model routing line becomes:

```ts
  const { model, prompt: userMsg } = pickModel(voiceText ?? words);
```

(b) The `messageForClaude` chain gets a voice branch FIRST:

```ts
  let messageForClaude = userMsg;
  let historyNote = userMsg;
  if (voiceText !== null) {
    messageForClaude = voicePromptText(userMsg);
    historyNote = voiceHistoryNote(userMsg);
  } else if (attachment) {
    // … existing attachment branch unchanged …
```

(c) The log label line becomes:

```ts
  const label = voiceText !== null ? "a voice note" : attachment?.kind ?? unsupported;
```

(d) The ack lines are guarded so the voice path doesn't double-fire (it already acked before transcription):

```ts
  if (voiceText === null) {
    void setReaction(chatId, msg.message_id, REACTION_START);
    void sendTyping(chatId);
  }
```

(e) The `streamClaude` call gains the echo prefix:

```ts
    const echoPrefix =
      voiceText !== null && shouldEchoTranscript(voiceConfidence) ? `🎤 «${userMsg}»\n\n` : "";
    const answer =
      (await streamClaude(
        buildPrompt(history, name, messageForClaude, recall, loadMemory(), skills),
        chatId,
        placeholderId,
        model,
        echoPrefix ? { renderPrefix: echoPrefix } : {},
      )).trim() || "(no output)";
```

(f) The "nothing readable and nothing said" decline guard must not swallow a
successful transcription (voice messages have empty `words` and a null
`attachment`, but the transcript IS the message). Change:

```ts
  if (!attachment && !words) {
```

to:

```ts
  if (!attachment && !words && voiceText === null) {
```

(This edit was missing from the original plan and was caught by the Task 8
spec review trace — without it every transcribed voice note fell into the
decline reply and the transcript was discarded.)

- [ ] **Step 8.4: Update the honest-decline copy and the file header**

(a) In the `!attachment && !words` decline (text-only fallback messages around line 714-717), update both strings:

```ts
    const text = unsupported
      ? `I can't open ${unsupported} yet — I can read text, images, documents (PDFs, etc.), and voice notes.`
      : "I can read text, images, documents (PDFs, etc.), and voice notes right now — but not this kind of message yet.";
```

(b) In the file header comment (lines 9-11), replace:

```
 * Text, photos, and documents are supported: attachments are downloaded from
 * Telegram into ./uploads and their local path is handed to Claude, which reads
 * them with its own file tools. Other kinds (voice, stickers, …) are declined.
```

with:

```
 * Text, photos, documents, and voice notes are supported: attachments are
 * downloaded from Telegram into ./uploads — files are handed to Claude by path,
 * voice is transcribed first (transcribe.ts) and flows in as a typed message.
 * Other kinds (video, stickers, …) are declined honestly.
```

- [ ] **Step 8.5: Run the full suite**

Run: `bun test`
Expected: all pass (the suite imports poller.ts and transcribe.ts, so any TS syntax slip in the new branch fails loudly here).

- [ ] **Step 8.6: Commit**

```bash
git add poller.ts
git commit -m "feat(voice): handleMessage voice branch - gate, transcribe, inject as typed message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs — DEPLOY.md voice section + README feature line

**Files:**
- Modify: `DEPLOY.md` (new section after the token step, i.e. after "Step 7 — Store the Telegram token")
- Modify: `README.md` (read it first; add voice notes to the feature list)

- [ ] **Step 9.1: Add the DEPLOY.md section**

Insert after the Step 7 token block (renumber nothing — use a lettered step):

```markdown
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

3. Restart the poller (tmux `bot` window → Ctrl-C → `./start.sh`). Done —
   `TRANSCRIBE_BACKEND` auto-resolves to `groq` when the key is present.

Tuning (all optional, in the same `.env`):

| var | default | meaning |
|---|---|---|
| `TRANSCRIBE_BACKEND` | auto | `groq` / `local` / `off` (explicit override) |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | hosted whisper variant |
| `VOICE_MAX_SEC` | `300` | longest voice note accepted |
| `VOICE_ECHO_BELOW` | `0.6` | echo the transcript when confidence is below this; `0` = never echo |
| `VOICE_TIMEOUT_MS` | `45000` | transcription timeout |

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
```

- [ ] **Step 9.2: Update README.md**

Read `README.md` first. Add a single feature bullet alongside the existing capability list, matching its tone, e.g.:

```markdown
- Voice notes: speak instead of typing — transcribed (Groq whisper, swappable local backend) and answered like text, with a 🎤 transcript echo when confidence is low.
```

- [ ] **Step 9.3: Run the suite one last time, commit**

Run: `bun test`
Expected: all pass.

```bash
git add DEPLOY.md README.md
git commit -m "docs(voice): DEPLOY.md voice section (groq setup + deferred local), README feature line

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: PR + deferred deploy checklist

**Files:** none (process)

- [ ] **Step 10.1: Push and open the PR**

```bash
git push -u origin feat/voice-notes
gh pr create --title "feat: voice notes in — transcribe and answer like text (phase 6)" --body "$(cat <<'EOF'
Phase 6 (voice notes in) per docs/superpowers/specs/2026-06-11-voice-notes-design.md.

- transcribe.ts: swappable backend behind { text, confidence } — groq (whisper-large-v3-turbo, free tier) active; local TRANSCRIBE_CMD path implemented, droplet provisioning deferred
- poller: voice branch — duration/size gates pre-download, early 👀 ack, transcript flows through the normal typed-message pipeline ([voice] history rows, recall/skills intact)
- low-confidence transcript echo (🎤 «…») painted into streamed edits via renderPrefix; stored answer stays clean
- every failure path replies honestly and never spawns claude
- redact.ts masks gsk_ keys; GROQ_API_KEY already covered by name
- DEPLOY.md step 7b: groq setup now, whisper.cpp example for later

Deploy is a separate step (SSH to the droplet is network-gated): add GROQ_API_KEY to .env, pull, restart, then the live checklist in the plan.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10.2: Deferred deploy + live verification (when SSH reachable)**

Not part of the PR. On a network that reaches the droplet:

1. `ssh claudebot@157.230.112.96` — `cd ~/claude-bot && git status` FIRST (the bot hot-patches itself), reconcile if dirty.
2. Maor creates the Groq key; append `GROQ_API_KEY=…` to `/home/claudebot/.claude/channels/telegram/.env`.
3. `git pull`, restart the poller in tmux `bot` (Ctrl-C, `./start.sh`).
4. Live checklist: Hebrew note → correct answer; English note; mumbled note → 🎤 echo appears; a 6-minute note → cap decline; check logs show `[REDACTED…]` if the key is ever printed; `free -m` flat during transcription.
5. Calibrate `VOICE_ECHO_BELOW` with 3-4 real notes (target: clean speech doesn't echo, mumbles do).
6. Mark the roadmap: `docs/ROADMAP.md` Phase 6 "Voice notes in" → done with date + PR number; commit as `docs(roadmap): …`.
```
