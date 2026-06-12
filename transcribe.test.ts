import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { writeFileSync as writeTestFile, rmSync as rmTestFile } from "node:fs";
import {
  envNum,
  resolveBackend,
  shouldEchoTranscript,
  deriveConfidence,
  parseLocalOutput,
  groqTranscribe,
  buildLocalCommand,
  localTranscribe,
  transcribeVoice,
} from "./transcribe";

// groqTranscribe reads the audio bytes eagerly (to upload a NAMED File — Groq
// rejects .oga by extension and Bun's FormData drops explicit filenames for
// lazy blobs), so the fake path must be a real file. Bytes are irrelevant:
// every test injects fetchFn.
const AUDIO_TMP = join(import.meta.dir, "transcribe.test.audio.oga");
writeTestFile(AUDIO_TMP, "OggS-not-really-audio");
afterAll(() => rmTestFile(AUDIO_TMP, { force: true }));

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

test("deriveConfidence ignores NaN avg_logprob segments (typeof NaN is 'number')", () => {
  expect(deriveConfidence([{ avg_logprob: NaN, start: 0, end: 1 }])).toBeNull();
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

// --- groqTranscribe: hosted whisper via OpenAI-compatible endpoint ------------
// fetchFn is injected; no network. groqTranscribe DOES read the audio bytes
// eagerly (named-File upload), hence the real AUDIO_TMP file above.

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

  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "gsk_test", fetchFn });
  expect(tr.text).toBe("תזכיר לי מחר");
  expect(tr.confidence).toBeCloseTo(0.9, 5);

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect((calls[0].init.headers as any).authorization).toBe("Bearer gsk_test");
  const form = calls[0].init.body as FormData;
  expect(form.get("model")).toBe("whisper-large-v3-turbo");
  expect(form.get("response_format")).toBe("verbose_json");
  // Groq validates the multipart FILENAME's extension; Telegram saves voice as
  // .oga which Groq's list rejects (live 400, 2026-06-11) — must upload as .ogg.
  expect((form.get("file") as File).name).toBe("voice.ogg");
});

test("groqTranscribe yields null confidence when segments are absent", async () => {
  const fetchFn = (async () => groqOk({ text: "hi" })) as typeof fetch;
  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn });
  expect(tr).toEqual({ text: "hi", confidence: null });
});

test("groqTranscribe retries once on a 5xx and then succeeds", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    if (n === 1) return new Response("boom", { status: 500 });
    return groqOk({ text: "ok" });
  }) as typeof fetch;
  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn });
  expect(tr.text).toBe("ok");
  expect(n).toBe(2);
});

test("groqTranscribe does NOT retry a 4xx (e.g. 429) and throws with the status", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response('{"error": "rate limit"}', { status: 429 });
  }) as typeof fetch;
  await expect(groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn })).rejects.toThrow(
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
  await expect(groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn })).rejects.toThrow(
    /ECONNREFUSED/,
  );
  expect(n).toBe(2);
});

test("groqTranscribe throws without an api key", async () => {
  const fetchFn = (async () => groqOk({ text: "x" })) as typeof fetch;
  await expect(
    groqTranscribe(AUDIO_TMP, { apiKey: "", fetchFn }),
  ).rejects.toThrow(/GROQ_API_KEY/);
});

test("groqTranscribe throws on a 200 whose body has no text field", async () => {
  const fetchFn = (async () => groqOk({ uh: "oh" })) as typeof fetch;
  await expect(groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn })).rejects.toThrow(
    /no text field/,
  );
});

test("groqTranscribe gives up after two 5xx attempts and throws the last error", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  await expect(groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn })).rejects.toThrow(
    /groq HTTP 500/,
  );
  expect(n).toBe(2);
});

test("groqTranscribe treats a malformed 200 body as final (no retry)", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response("<html>not json</html>", { status: 200 });
  }) as typeof fetch;
  await expect(groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn })).rejects.toThrow(
    /malformed body/,
  );
  expect(n).toBe(1);
});

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

  // Literal path on purpose: local backend never reads the file itself (the
  // command does), and this pins the exact quoting handed to /bin/sh.
  const tr = await localTranscribe("/up/v.oga", { cmd: "wsp {input}", spawnFn });
  expect(tr).toEqual({ text: "שלום עולם", confidence: 0.4 });
  expect(argvSeen[0][0]).toBe("/bin/sh");
  expect(argvSeen[0][1]).toBe("-c");
  expect(argvSeen[0][2]).toBe("wsp '/up/v.oga'");
});

test("localTranscribe throws when the command exits non-zero, including stderr", async () => {
  const spawnFn = (() => fakeProc("", 127, "wsp: not found")) as unknown as typeof Bun.spawn;
  await expect(localTranscribe(AUDIO_TMP, { cmd: "wsp {input}", spawnFn })).rejects.toThrow(
    /exited 127.*not found/s,
  );
});

test("localTranscribe throws when TRANSCRIBE_CMD is not configured", async () => {
  await expect(localTranscribe(AUDIO_TMP, { cmd: "" })).rejects.toThrow(/TRANSCRIBE_CMD/);
});

test("localTranscribe SIGKILLs a stalled process at the timeout and rejects", async () => {
  let killedWith: unknown;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  const spawnFn = (() => ({
    stdout: new Response("").body,
    stderr: new Response("").body,
    exited,
    kill(sig?: unknown) {
      killedWith = sig;
      resolveExit(-1);
    },
  })) as unknown as typeof Bun.spawn;

  await expect(
    localTranscribe(AUDIO_TMP, { cmd: "wsp {input}", spawnFn, timeoutMs: 10 }),
  ).rejects.toThrow(/exited -1/);
  expect(killedWith).toBe("SIGKILL");
});

// --- transcribeVoice: dispatch by resolved backend ------------------------------

test("transcribeVoice throws a clear error when no backend is configured", async () => {
  await expect(transcribeVoice(AUDIO_TMP, {})).rejects.toThrow(/not configured/);
});

test("transcribeVoice dispatches to local when only a command is configured", async () => {
  const spawnFn = (() => fakeProc('{"text": "hi"}')) as unknown as typeof Bun.spawn;
  const tr = await transcribeVoice(AUDIO_TMP, { TRANSCRIBE_CMD: "wsp {input}" }, { spawnFn });
  expect(tr.text).toBe("hi");
});

test("transcribeVoice dispatches to groq when a key is configured", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ text: "hey" }), { status: 200 })) as typeof fetch;
  const tr = await transcribeVoice(AUDIO_TMP, { GROQ_API_KEY: "k" }, { fetchFn });
  expect(tr.text).toBe("hey");
});

// --- language guard: Hebrew misdetected as Arabic (bug report 2026-06-12) -----

import { parseVoiceLangs, normalizeLang } from "./transcribe";

test("parseVoiceLangs: default he,en; trims+lowercases; empty falls back", () => {
  expect(parseVoiceLangs(undefined)).toEqual(["he", "en"]);
  expect(parseVoiceLangs(" He , EN ,")).toEqual(["he", "en"]);
  expect(parseVoiceLangs("ru")).toEqual(["ru"]);
  expect(parseVoiceLangs("  ")).toEqual(["he", "en"]);
});

test("normalizeLang maps whisper names, passes codes/unknowns through, nulls junk", () => {
  expect(normalizeLang("Hebrew")).toBe("he");
  expect(normalizeLang("arabic")).toBe("ar");
  expect(normalizeLang("he")).toBe("he");
  expect(normalizeLang("klingon")).toBe("klingon"); // unmatched → won't be in allowed → guard fires
  expect(normalizeLang("")).toBeNull();
  expect(normalizeLang(undefined)).toBeNull();
});

test("groqTranscribe re-transcribes ONCE with forced language on unexpected detection", async () => {
  const forms: FormData[] = [];
  const fetchFn = (async (_url: any, init: any) => {
    forms.push(init.body as FormData);
    if (forms.length === 1) {
      return groqOk({ text: "نص", language: "arabic", segments: [{ avg_logprob: Math.log(0.5), start: 0, end: 2 }] });
    }
    return groqOk({ text: "טקסט עברי תקין", language: "hebrew", segments: [{ avg_logprob: Math.log(0.9), start: 0, end: 2 }] });
  }) as typeof fetch;

  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn, allowedLangs: ["he", "en"] });
  expect(forms.length).toBe(2);
  expect(forms[0].get("language")).toBeNull(); // first pass auto-detects
  expect(forms[1].get("language")).toBe("he"); // guard forces the primary language
  expect(tr.text).toBe("טקסט עברי תקין");
  expect(tr.confidence).toBeCloseTo(0.9, 5);
});

test("groqTranscribe accepts allowed detections with a single call", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return groqOk({ text: "hello", language: "english" });
  }) as typeof fetch;
  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn, allowedLangs: ["he", "en"] });
  expect(calls).toBe(1);
  expect(tr.text).toBe("hello");
});

test("groqTranscribe tolerates a missing language field (single call)", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return groqOk({ text: "hi" });
  }) as typeof fetch;
  await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn, allowedLangs: ["he", "en"] });
  expect(calls).toBe(1);
});

test("the forced retry's result is final even if still off-language (no loops)", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return groqOk({ text: "??", language: "arabic" });
  }) as typeof fetch;
  const tr = await groqTranscribe(AUDIO_TMP, { apiKey: "k", fetchFn, allowedLangs: ["he"] });
  expect(calls).toBe(2); // exactly one guard retry, never more
  expect(tr.text).toBe("??");
});
