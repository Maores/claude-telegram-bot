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
