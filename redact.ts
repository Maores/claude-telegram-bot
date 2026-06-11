/**
 * redact.ts — masks secrets on the bot's OUTPUT path (Phase 4, survey §A3).
 *
 * Two layers:
 *  1. Exact values of env vars whose NAME looks secret (TOKEN/SECRET/…),
 *     snapshotted at import so a runtime `export REDACT=off` can't disable it
 *     (hermes agent/redact.py lesson). Zero false positives.
 *  2. Vendor-shaped patterns (sk-, ghp_, xox*, AKIA, Bearer, telegram token,
 *     PEM private keys), masked keeping a 4-char tail for identification.
 *
 * Applied by poller.ts inside tg() (every outgoing text/caption) and on its
 * log lines. Pure; tests inject env/secrets explicitly.
 */

const SECRET_NAME_RE = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL/i;

export function collectSecretValues(env: Record<string, string | undefined> = process.env): string[] {
  const vals: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (SECRET_NAME_RE.test(name)) vals.push(value);
  }
  // Longest first so a secret containing a shorter one is masked in one piece.
  return vals.sort((a, b) => b.length - a.length);
}

/** Snapshot at import time — deliberate (cannot be unset mid-session). */
const SECRETS = collectSecretValues();

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, // bearer auth headers
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token shape
];

const tail = (s: string) => `[REDACTED…${s.slice(-4)}]`;

export function redact(text: string, secrets: string[] = SECRETS): string {
  if (!text) return text;
  let out = text;
  // Sort longest-first so a secret that contains a shorter one is masked as a
  // single unit — avoids leaving a suffix fragment after the shorter match.
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join("[REDACTED]");
  for (const re of PATTERNS) out = out.replace(re, (m) => tail(m));
  return out;
}
