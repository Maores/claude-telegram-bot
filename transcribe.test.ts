import { test, expect } from "bun:test";
import {
  envNum,
  resolveBackend,
  shouldEchoTranscript,
  deriveConfidence,
  parseLocalOutput,
  groqTranscribe,
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

test("groqTranscribe gives up after two 5xx attempts and throws the last error", async () => {
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  await expect(groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn })).rejects.toThrow(
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
  await expect(groqTranscribe("uploads/none.oga", { apiKey: "k", fetchFn })).rejects.toThrow(
    /malformed body/,
  );
  expect(n).toBe(1);
});
