# Phase 6 — voice notes in: build design

Maor sends a Telegram voice bubble; the bot transcribes it and answers as if it
were typed. Hebrew and English both work. Voice replies out (TTS) are a later
roadmap item, not this build.

Research basis: hermes survey §B1 (`docs/research/2026-06-10-hermes-feature-survey.md`)
— transcribe-then-inject, with hermes's `local_command` escape hatch named "the
right pattern to copy". Claude cannot take audio input, so preprocessing is the
only route.

## Decisions (Maor, 2026-06-11)

- **Scope: voice bubbles only.** Video notes, audio files, and everything else
  keep today's polite decline.
- **Backend: swappable, Groq first (approach C).** One `transcribe.ts` module
  behind a `{ text, confidence }` interface. Groq's hosted
  `whisper-large-v3-turbo` (free tier: 2,000 req/day, 7,200 audio-sec/hour —
  hundreds of times personal volume) is the active backend from day one.
  A `local` backend (configurable shell command, intended for whisper.cpp) is
  implemented and tested in code, but provisioning the droplet for it is
  deferred. Rationale: the droplet is 1 vCPU / 1 GB (`DEPLOY.md` step 1), which
  caps local whisper at the `small` model — mediocre Hebrew and ~30–90 s per
  30 s note. The Hebrew-tuned GGML models that would sound native
  (`ivrit-ai/whisper-large-v3-turbo-ggml`, 1.6 GB f16) cannot fit. Groq bends
  the roadmap's "keyless" line in exchange for Hebrew that actually works; the
  swappable seam keeps the keyless option alive.
- **Transcript echo: only on low confidence.** Below a threshold, the reply
  opens with one quoted line (🎤 «…») so mishearings are visible; above it,
  just the answer.

## Data flow

1. `msg.voice` present (fields: `file_id`, `duration`, `mime_type`,
   `file_size`). Add `TgVoice` to poller types; remove `voice` from
   `unsupportedMediaKind`; update the decline copy and the poller header
   comment to say voice notes are now readable ("text, images, documents, and
   voice notes").
2. **Duration gate before any download**: `duration > VOICE_MAX_SEC` (default
   300) → decline stating the cap. Size gate reuses `isTooLarge`.
3. 👀 reaction + typing bubble fire at the top of the voice branch (earlier
   than the photo/document flow, because transcription adds latency before the
   placeholder appears).
4. `downloadFile(voice.file_id)` → `uploads/<ts>-voice.oga` (existing helper,
   existing timeout).
5. `transcribeVoice(path)` → `{ text, confidence }` (see module contract).
6. Empty/whitespace text → "לא קלטתי מילים בהקלטה 🎤", stop (no claude spawn).
7. Transcript proceeds exactly like a typed message: `pickModel(transcript)`,
   history, recall, skills — all unchanged. Prompt marks the medium so Claude
   reads mishearings charitably:
   `[The user sent a voice note; this is its transcript.]\n<text>`.
   History stores `[voice] <text>` so future recall hits the content.
8. `confidence !== null && confidence < VOICE_ECHO_BELOW` → the reply text is
   prefixed with `🎤 «<text>»\n\n` from the first streaming flush onward (the
   prefix is part of every placeholder edit, not a separate message).
9. `finally`: `cleanupFile` removes the audio.

## Module contract — `transcribe.ts` (new, ~150 lines)

```ts
interface Transcript { text: string; confidence: number | null }

transcribeVoice(path: string): Promise<Transcript>  // dispatch by config
groqTranscribe(path): Promise<Transcript>           // multipart POST
localTranscribe(path): Promise<Transcript>          // spawn command template
deriveConfidence(segments): number | null           // exported, pure, tested
resolveBackend(env): "groq" | "local" | "off"       // exported, pure, tested
```

- **groq**: POST `https://api.groq.com/openai/v1/audio/transcriptions`,
  model `GROQ_STT_MODEL` (default `whisper-large-v3-turbo`),
  `response_format=verbose_json`. Confidence = duration-weighted mean of
  `exp(segment.avg_logprob)`, clamped 0–1. The `.oga` uploads as-is; ffmpeg is
  NOT a dependency of this path. (Implementation verifies Groq accepts
  ogg/opus — documented as accepted; if that fails live, conversion is added
  then, not preemptively.) One retry on network error/5xx; none on 4xx.
- **local**: `TRANSCRIBE_CMD` is a shell command template with an `{input}`
  placeholder; it must print `{"text": "...", "confidence": 0.0–1.0?}` JSON on
  stdout. Missing confidence → `null` → echo logic stays quiet. DEPLOY.md will
  carry a worked whisper.cpp example (ffmpeg → wav → whisper-cli with JSON
  output). The command is operator config in `.env`, same trust level as
  `CLAUDE_BIN` — not writable by chat or by Claude-in-session.
- Both paths share `VOICE_TIMEOUT_MS` (default 45 000): timeout → thrown error
  → user-facing failure reply.
- Backend resolution: explicit `TRANSCRIBE_BACKEND` wins; else `groq` if
  `GROQ_API_KEY` set, else `local` if `TRANSCRIBE_CMD` set, else `off`.

## Configuration (all in the existing `.env`)

| var | default | meaning |
|---|---|---|
| `TRANSCRIBE_BACKEND` | auto | `groq` / `local`; auto-resolves as above |
| `GROQ_API_KEY` | — | free key from console.groq.com |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | hosted whisper variant |
| `TRANSCRIBE_CMD` | — | local command template, `{input}` placeholder |
| `VOICE_MAX_SEC` | 300 | duration gate |
| `VOICE_ECHO_BELOW` | 0.6 | echo threshold; calibrated live after deploy |
| `VOICE_TIMEOUT_MS` | 45000 | transcription timeout |

Empty-string env values must not zero numeric defaults (same bug class as the
`REVIEW_COOLDOWN_S` fix in 1aba006).

## Security

- `redact.ts` learns the Groq key shape (`gsk_` + token chars) so the key can
  never reach a Telegram reply or a log line.
- Transcripts are untrusted user speech but they are Maor's own commands —
  same trust as typed text. No new injection surface: file names never enter
  the prompt on this path, and the transcript is injected as the user message,
  not as system instructions.
- The audio file lives in `uploads/` only for the turn; existing startup sweep
  covers crash leftovers.

## Failure handling (each replies honestly, none spawn claude)

| case | reply (Hebrew, bot's tone) | extra |
|---|---|---|
| backend `off` | "עוד לא מחובר אצלי תמלול קולי" | feature degrades to today |
| over `VOICE_MAX_SEC` | states the cap ("עד 5 דקות") | checked pre-download |
| download failed | existing retry message | unchanged path |
| transcribe error / timeout / 429 | "⚠️ לא הצלחתי לתמלל את ההקלטה הפעם" | 👎 reaction; per-cause log lines |
| empty transcript | "לא קלטתי מילים בהקלטה 🎤" | |

`/stop` during transcription keeps today's documented limitation (sequential
loop; read after the turn). Nothing regresses.

## Testing

- `transcribe.test.ts` (new): `deriveConfidence` fixtures (incl. empty
  segments → null), `resolveBackend` precedence table, command templating +
  stdout JSON parsing with mocked spawn (bad JSON → error), Groq parsing +
  error mapping (429/5xx/timeout/malformed) with mocked fetch, empty-env
  numeric defaults.
- `poller.test.ts` (additions): happy path with mocked transcribe; echo
  prefix present below threshold and absent above; `null` confidence → no
  echo; cap decline; `off` decline; failure path sends the error reply and
  skips claude; history row is `[voice] <text>`; voice removed from the
  unsupported list (update existing assertions).
- Live verification on the droplet: Hebrew note, English note, mumbled note
  (echo appears), 6-minute note (cap), log shows `[REDACTED…]` for the key,
  RAM stays flat (Groq path does no local inference).

## Deployment

1. Maor creates the free Groq key (console.groq.com) at deploy time.
2. Append `GROQ_API_KEY=…` to the droplet `.env` (chmod 600 already).
3. Pull + restart via tmux `start.sh` per the existing runbook (check
   `git status` first — the bot hot-patches itself).
4. DEPLOY.md gains a voice section: Groq setup now; optional whisper.cpp local
   setup for later (build steps, quantized model download, example
   `TRANSCRIBE_CMD`, swap-file note for the 1 GB box).
5. SSH from the current network is blocked (port 22 timeout, recurring); the
   PR does not wait on deploy.

## Out of scope (unchanged roadmap items)

Voice replies out (TTS), video notes, audio files, the non-blocking message
loop (true mid-answer /stop), confirm/guard buttons.
