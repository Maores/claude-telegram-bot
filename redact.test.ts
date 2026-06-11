import { test, expect } from "bun:test";
import { redact, collectSecretValues } from "./redact.ts";

test("collectSecretValues picks env vars whose NAME looks secret, 8+ chars only", () => {
  const vals = collectSecretValues({
    TELEGRAM_BOT_TOKEN: "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn",
    ICLOUD_APP_PASSWORD: "abcd-efgh-ijkl-mnop",
    SHORT_TOKEN: "abc",
    HOME: "/home/claudebot",
    PATH: "/usr/bin",
  });
  expect(vals).toContain("123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn");
  expect(vals).toContain("abcd-efgh-ijkl-mnop");
  expect(vals).not.toContain("abc");
  expect(vals).not.toContain("/home/claudebot");
});

test("longest secret masks first (a secret containing another masks cleanly)", () => {
  const out = redact("x SECRETLONGvalue123 y", ["SECRETLONG", "SECRETLONGvalue123"]);
  expect(out).toBe("x [REDACTED] y");
});

test("exact env values are masked wherever they appear, multiline included", () => {
  const tok = "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn";
  const out = redact(`first line\ncurl https://api.telegram.org/bot${tok}/send`, [tok]);
  expect(out).not.toContain(tok);
  expect(out).toContain("[REDACTED]");
});

test("vendor patterns are masked with a 4-char identification tail", () => {
  const out = redact("key sk-abcdefghijklmnopqrstuvwxyz123456 here", []);
  expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  expect(out).toContain("[REDACTED…3456]");
});

test("github / slack / aws / bearer / telegram-shaped / private-key all masked", () => {
  const samples = [
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "xoxb-1234567890-ABCDEFGHIJKL",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "123456789:AAaaBBbbCCccDDddEEffGGhhIIjjKKllMMn",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ];
  for (const s of samples) {
    const out = redact(`x ${s} y`, []);
    expect(out).not.toContain(s);
    expect(out).toContain("[REDACTED");
  }
});

test("clean text and Hebrew pass through untouched", () => {
  const t = "תזכורת: לקנות חלב ב-12:30, עולה 6.90";
  expect(redact(t, [])).toBe(t);
});

test("empty/undefined-ish input is returned as-is", () => {
  expect(redact("", [])).toBe("");
});

test("redact() without a secrets arg uses the module snapshot (default path intact)", () => {
  const text = "key sk-abcdefghijklmnopqrstuvwxyz123456 here";
  expect(redact(text)).toBe(redact(text, collectSecretValues()));
  expect(redact(text)).toContain("[REDACTED…3456]"); // vendor layer active on default path
});

test("redact masks a Groq-shaped key keeping the 4-char tail", () => {
  const out = redact("auth with gsk_AbCdEfGhIjKlMnOpQrStUvWx1234 please", []);
  expect(out).not.toContain("gsk_AbCdEfGhIjKlMnOpQrStUvWx1234");
  expect(out).toContain("[REDACTED…1234]");
});

test("collectSecretValues picks up GROQ_API_KEY by its name", () => {
  // layer 1 already covers the real key: the NAME matches /API_KEY/.
  expect(collectSecretValues({ GROQ_API_KEY: "supersecretvalue" })).toContain("supersecretvalue");
});
