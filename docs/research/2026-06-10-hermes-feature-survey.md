# Hermes-agent feature menu — porting survey for the claude -p Telegram bot

Surveyed: NousResearch/hermes-agent @ HEAD (shallow clone, 4,955 files, ~1,490 test files), 2026-06-10, by a dedicated research agent. File paths are relative to the survey clone. Effort scale: S = under a day, M = 1–3 days, L = multi-day. Scores are 1–5 (daily usefulness to a personal Telegram assistant / CV-demo value).

Excluded as already ported: FTS5 history + auto-injected recall, guarded core memory (`tools/memory_tool.py`, `tools/threat_patterns.py`), self-written skills + curator (`tools/skills_tool.py`, `tools/skill_manager_tool.py`, `agent/curator.py`).

---

## A. Security and human-in-the-loop

### A1. Three-layer dangerous-command approval with Telegram buttons
**What:** Every shell command passes a guard chain before execution: an unconditional "hardline" blocklist (rm -rf /, mkfs, dd to block devices, fork bombs, shutdown — blocked even in yolo mode), ~47 dangerous patterns that require user approval, a session/permanent allowlist, and an optional LLM "smart approve" triage that auto-clears false positives.
**How hermes does it:** `tools/approval.py` — `HARDLINE_PATTERNS` (L255–277), `check_dangerous_command` (L1037), `_smart_approve` aux-LLM triage (L990), sudo-password-guessing guard `sudo -S` block (L302–323), sensitive-path patterns covering `.ssh`, `.env`, shell rc files, and hermes's own config (so the agent can't edit the security policy that gates it, L168–211). In gateway context the approval is relayed to Telegram as inline keyboard buttons — Allow Once / Session / Always / Deny — in `gateway/platforms/telegram.py` `send_exec_approval` (L2664–2703), resolved via `/approve`/`/deny` handlers in `gateway/slash_commands.py` (L3263, L3321). An optional external scanner binary (`tools/tirith_security.py`) adds content-level checks (homograph URLs, pipe-to-interpreter) with SHA-256-verified auto-install.
**Mapping to claude -p:** Maps well via Claude Code's native PreToolUse hooks: a Bun script receives each Bash command as JSON, applies the regex layers, and exits 2 (deny with message) or 0. The hardline floor is a drop-in S port. Interactive approval can't pause a stateless run, but the deny-then-confirm pattern works: the hook denies and tells the model "ask Maor for approval"; the model replies with the command; Maor's "yes" in the next message lets the hook find it in an approvals file (same flow as the calendar confirm-before-write). Telegram inline buttons need poller callback-query support (currently only messages are polled).
**Effort:** S for the hardline hook alone; M for the approval-file flow; +M for inline buttons.
**Scores:** usefulness 4 / CV 5 — the bot currently runs with full permissions on a server holding email and calendar access, and "a yolo floor below yolo" plus HITL approval over chat is exactly the security story a portfolio wants.

### A2. Least-privilege toolsets per trigger type
**What:** Agents spawned by cron never receive the cron-scheduling, messaging, or clarify toolsets — a cron job cannot schedule more cron jobs (self-replication guard) and per-job toolsets can only narrow, never widen, the user's denylist. Cron dangerous-command mode defaults to deny.
**How hermes does it:** `cron/scheduler.py` `_resolve_cron_disabled_toolsets` (L62–82), `_resolve_cron_enabled_toolsets` (L85–113); `tools/approval.py` `_get_cron_approval_mode` defaults to "deny" (L977–987).
**Mapping:** Direct and cheap: [AUTO] reminder sessions currently get the same full-permission claude -p as Maor's messages. Pass `--disallowedTools` (or a restricted `--allowedTools`) when the poller spawns AUTO/cron sessions, and forbid `remind.ts add*` inside AUTO sessions so a reminder can't schedule reminders.
**Effort:** S.
**Scores:** usefulness 3 / CV 4 — invisible day-to-day, but "untrusted-trigger sessions run with reduced privileges" is a one-line CV claim that interviewers check for.

### A3. Secret redaction on the output path
**What:** Regex-based masking of API keys/tokens/credentials before text reaches logs or chat replies; sensitive query params and JSON body keys; the enable flag is snapshotted at import time so an LLM-generated `export REDACT=false` can't disable it mid-session.
**How hermes does it:** `agent/redact.py` (vendor-prefix regexes + `_SENSITIVE_QUERY_PARAMS`/`_SENSITIVE_BODY_KEYS`, L19–60); `tools/send_message_tool.py` sanitizes error text before users see it (L60–80).
**Mapping:** Clean: a `redact.ts` applied by the poller to claude's stdout before `sendMessage`, and to poller logs. The bot has `TELEGRAM_BOT_TOKEN`, DB paths, and iCloud credentials on box — a stray `cat .env` in a reply is a real failure mode.
**Effort:** S.
**Scores:** usefulness 3 / CV 4 — cheap, testable (golden-file tests), and defense-in-depth that pairs with A1.

### A4. SSRF / private-network URL guard
**What:** Blocks fetches to private IPs, localhost, and cloud metadata endpoints (169.254.169.254, metadata.google.internal — always blocked even when the guard is disabled); documents its own DNS-rebinding limitation honestly.
**How hermes does it:** `tools/url_safety.py` (L1–24).
**Mapping:** Partial. Claude's WebFetch runs Anthropic-side, but the model can also `curl` via Bash on the droplet — a PreToolUse hook can resolve and check hosts in curl/wget commands. Imperfect coverage (it can't see every way to make a request).
**Effort:** S–M. **Scores:** usefulness 2 / CV 3 — DigitalOcean has a metadata endpoint (169.254.169.254) that leaks droplet config, so it's not theoretical, but the attack path is narrow for a single-user bot.

### A5. DM pairing for unknown users
**What:** Instead of a static allowlist, unknown users get a one-time 8-char code the owner approves; rate limits, lockouts, 1h expiry, 0600 file perms, NIST-cited design.
**How hermes does it:** `gateway/pairing.py` (L1–50).
**Mapping:** Works fine in the poller, but the bot is single-user by design.
**Effort:** S–M. **Scores:** usefulness 1 / CV 3 — only worth it if the bot is ever demoed to others; otherwise the existing chat-id check is correct.

### A6. Supply-chain checks (OSV malware gate, self-audit)
**What:** Before launching any `npx`/`uvx` MCP server, query OSV.dev for MAL-* advisories (~300ms, fail-open); plus an on-demand security audit that scans deps and MCP commands against OSV.
**How hermes does it:** `tools/osv_check.py` (L1–40), `hermes_cli/security_audit.py` (L1–18).
**Mapping:** Direct port to a `bun run audit.ts` that scans package.json + any MCP config.
**Effort:** S. **Scores:** usefulness 2 / CV 3.

---

## B. Voice and media

### B1. Incoming voice-memo transcription
**What:** Voice/audio Telegram messages are auto-transcribed and the transcript injected into the prompt (wrapped as "user said via voice: …"); failures produce a graceful "can't transcribe" reply.
**How hermes does it:** `gateway/run.py` `_enrich_message_with_transcription` (L11462+); `tools/transcription_tools.py` with six backends — faster-whisper (local), `local_command` (any shell command, e.g. whisper.cpp), Groq, OpenAI, Mistral, xAI (`agent/transcription_provider.py` L15–21).
**Mapping:** Very clean: the poller already downloads attachments for image/document understanding; add the voice/audio branch, shell out to whisper.cpp (a tiny/base model runs on a small droplet CPU; expect seconds, not ms) or a free-tier API, and prepend the transcript. Claude itself cannot take audio input, so this preprocessing step is the only way — hermes's `local_command` escape hatch is the right pattern to copy.
**Effort:** M (mostly whisper.cpp setup + ffmpeg ogg→wav).
**Scores:** usefulness 5 / CV 3 — sending voice notes instead of typing is the single biggest daily-use upgrade for a phone-first assistant.

### B2. Voice replies via TTS
**What:** The agent can answer as a native Telegram voice bubble (opus/ogg). Backends include Edge TTS (free, no API key), Piper and KittenTTS (local, free); custom-command providers supported.
**How hermes does it:** `tools/tts_tool.py` (L5–26, opus output for Telegram voice bubbles), `gateway/platforms/telegram.py` `send_voice` (L3807).
**Mapping:** Clean: a `say.ts` tool the model can call; edge-tts has no key requirement.
**Effort:** S–M. **Scores:** usefulness 3 / CV 2 — fun and demo-friendly; less essential than B1.

---

## C. The learning loop (the stores are ported; the loop is not)

### C1. Background memory/skill review after each turn
**What:** After the reply is delivered, a forked agent replays the conversation with a tool whitelist limited to memory + skill tools and asks itself "should anything be saved or updated?" — with a prompt that treats user corrections ("stop doing X", "too verbose") as first-class skill signals, prefers patching loaded skills over creating new ones, and bans session-named skills.
**How hermes does it:** `agent/background_review.py` (`_MEMORY_REVIEW_PROMPT` L34–43, `_SKILL_REVIEW_PROMPT` L45–120+, tool whitelist L10–13); triggered from `agent/turn_finalizer.py` (L375–401) on an every-N-iterations cadence, explicitly after delivery so it never delays the user.
**Mapping:** Excellent fit and the highest-leverage port available: after sending the reply, the poller spawns a second, detached, cheap claude -p (haiku-class) with `--allowedTools` restricted to `Bash(bun run mem.ts*)` + `Bash(bun run skill.ts*)`, fed the transcript and a port of these prompts. Existing trust gates (derived quarantine, rejectNonReusable) keep the writes guarded. Main adaptation: run every N messages or on a heuristic (long sessions, correction phrases).
**Effort:** M.
**Scores:** usefulness 4 / CV 5 — this is what makes "self-improving agent" true rather than aspirational, and it composes three systems already built.

### C2. Goals — the multi-turn objective loop
**What:** A persistent goal ("keep going until X is done") survives across turns: after each turn an auxiliary LLM judge answers "is the goal satisfied?"; if not, a continuation prompt is fed back, bounded by a turn budget (default 20), pausable, preempted by any real user message. Judge failures fail open with the budget as backstop.
**How hermes does it:** `hermes_cli/goals.py` (invariants L1–28, judge constraints L47–60), `/goal` + `/subgoal` in `gateway/slash_commands.py` (L1506, L1583).
**Mapping:** Portable but the poller, not claude, must own the loop: goal in SQLite; after each claude -p exit, a one-shot judge call; respawn with continuation context until done/budget/preempt. Within a single message Claude Code already loops internally, so this only pays off for genuinely long multi-session objectives.
**Effort:** L. **Scores:** usefulness 3 / CV 5 — judge + budget + preemption is a strong agent-engineering artifact; honest caveat: rarely needed for personal-assistant tasks.

### C3. Agent-driven history search (pull, alongside the existing push)
**What:** A session-search tool with three argument-inferred modes: discovery (FTS5 + ±5-message windows + first/last-3-message "bookends" per session), scroll (anchored pagination), browse (recent sessions). Zero LLM cost, pure DB reads.
**How hermes does it:** `tools/session_search_tool.py` (L1–30).
**Mapping:** Near-free: the FTS5 history table already exists; expose `bun run history.ts search|scroll|browse` and mention it in CLAUDE.md. Auto-injected recall stays as the default path; this covers "what did we decide about X last month?" where keyword push misses.
**Effort:** S. **Scores:** usefulness 4 / CV 3 — cheapest real capability gain in this list.

---

## D. Conversation UX (poller-level)

### D1. Progress feedback: typing indicator, reaction acks, draft streaming
**What:** 👀 reaction on the user's message when processing starts, 👍/👎 on completion/failure (cleared on cancel); typing indicator re-triggered after every send; long responses streamed by editing a draft message in place, with overflow splitting.
**How hermes does it:** `gateway/platforms/telegram.py` — reactions `_set_reaction`/`on_processing_start`/`on_processing_complete` (L6104–6178), typing re-trigger (L2087–2095), `send_typing` (L4365), draft streaming `supports_draft_streaming`/`send_draft`/`edit_message` (L2494–2304).
**Mapping:** All poller-side. NOTE: the bot ALREADY HAS draft streaming (stream.ts + throttled edits) — the new parts are the reaction acks (👀/👍/👎) and typing re-trigger; `setMessageReaction` + `sendChatAction` are one-line Bot API calls.
**Effort:** S for typing+reactions.
**Scores:** usefulness 5 / CV 4 (agent over-scored this not knowing streaming exists; the remaining delta is still the best perceived-quality-per-effort).

### D2. /stop and interrupt-and-redirect
**What:** A new message (or `/stop`) interrupts the in-flight turn; the steer text is delivered as the next user turn rather than lost; 👀 cleared on cancel.
**How hermes does it:** `gateway/slash_commands.py` `_handle_stop_command` (L548); steer handoff in `agent/turn_finalizer.py` (L357–362); `gateway/stream_dispatch.py`.
**Mapping:** With a stateless claude -p the lever is killing the child process. `/stop` = SIGTERM + "stopped" reply (S). Redirect = kill, then respawn with "you were interrupted mid-task; new instruction: …" (M). Mid-run state is lost — say so rather than pretending parity.
**Effort:** S–M. **Scores:** usefulness 4 / CV 3.

### D3. Clarify with structured choices
**What:** The agent asks a multiple-choice question (max 4 options + "Other"), rendered as inline buttons.
**How hermes does it:** `tools/clarify_tool.py` (L1–40), `send_clarify` (L2784).
**Mapping:** In a stateless bot the model can just ask in text. The worthwhile fragment: reply-keyboard UI for the existing calendar/email confirm flows ("yes / no / change") once the poller handles callback queries (shared infra with A1's buttons).
**Effort:** S on top of A1's callback support. **Scores:** usefulness 3 / CV 2.

---

## E. Triggers and automation (beyond reminders)

### E1. Inbound webhooks → agent runs
**What:** An HTTP endpoint with named subscriptions: each has an HMAC secret (GitHub `X-Hub-Signature-256` and Svix validated), a prompt template rendered from the JSON payload (`{pull_request.title}`), optional skills, and a delivery target (Telegram, or a GitHub comment). CLI-managed, hot-reloaded, secrets 0600.
**How hermes does it:** `gateway/platforms/webhook.py` (`_validate_signature` L643, `_validate_svix_signature` L699, `_render_prompt` L753, `_deliver_github_comment` L837); CLI in `hermes_cli/webhook.py`.
**Mapping:** A small `Bun.serve` HTTPS listener on the droplet that verifies HMAC, renders the template, and reuses the [AUTO] pipeline (webhook = event-triggered AUTO). Real use today: push/CI events on `Maores/claude-telegram-bot` → "summarize what changed and whether deploy is needed" in Telegram. Exposing the port needs care — bind localhost + reverse proxy, or high port with HMAC as the only gate.
**Effort:** M.
**Scores:** usefulness 3 / CV 5 — event-driven agent triggers with signed payloads is a strong portfolio feature (the thing Anthropic's Routines productized).

### E2. Cron upgrades: pre-run scripts, wake gates, [SILENT], job chaining
**What:** (1) a pre-run script whose stdout is injected as context; (2) a wake gate — if the script's last stdout line is `{"wakeAgent": false}`, the LLM is never invoked (free monitoring ticks); (3) a `[SILENT]` reply marker that suppresses delivery but keeps output on disk for audit; (4) `context_from` — a job reads the latest output of an upstream job (path-traversal-validated, 8K truncation).
**How hermes does it:** `cron/scheduler.py` — `_parse_wake_gate` (L1084–1107), `SILENT_MARKER` (L154–157, never-combine rule L1216–1219), `_build_job_prompt` (L1110–1203); plus `_scan_assembled_cron_prompt` (L1313–1380) — a fire-time injection scan added after a real bypass (#3968) where runtime-loaded content dodged the create-time scanner.
**Mapping:** Direct extensions of remind.ts/[AUTO]: `--script` + wake-gate convention in the reminder runner; poller swallows `[SILENT]` replies; port the fire-time scan (threat-scan logic already exists) applied at fire time. Gives "watch this page/price/feed and only ping me on change" without burning a claude call per tick.
**Effort:** S–M (each increment independently shippable).
**Scores:** usefulness 4 / CV 4 — cheap-monitoring-without-spam is daily-useful; the fire-time injection scan is a thoughtful security detail.

### E3. Background process completion → new agent turn
**What:** Background jobs registered with notify-on-complete; on exit, a fresh agent turn reports the result (verbosity: all/result/error/off).
**How hermes does it:** `AGENTS.md` (L1114–1124); `tools/process_registry.py`.
**Mapping:** Event-driven sibling of [AUTO]: a `job.ts start <cmd>` wrapper (nohup + pid + log); poller watches exit, spawns claude -p with the log tail to summarize. Solves the real stateless-bot gap that long jobs are fire-and-forget.
**Effort:** M. **Scores:** usefulness 4 / CV 4.

---

## F. Observability and ops

### F1. /usage and /insights — cost and usage analytics
**What:** Per-session token/cost tracking with cache-aware pricing; /insights over N days: cost/day, tool patterns, model breakdowns.
**How hermes does it:** `agent/insights.py` (L1–17), `agent/usage_pricing.py`, handlers in `gateway/slash_commands.py` (L2850, L3016); optional per-reply footer (`gateway/runtime_footer.py`).
**Mapping:** Easy: claude -p JSON output already returns `total_cost_usd`, duration, turns — log to SQLite, aggregate via /usage. Footer = "· $0.04 · 12s" when enabled.
**Effort:** S. **Scores:** usefulness 3 / CV 3.

### F2. Self-update and shutdown forensics
**What:** `/update` + `/restart` with graceful drain (exit 75 → service restarts); on SIGTERM a <10ms forensic snapshot (who signaled, process tree) so "the gateway keeps dying" is diagnosable.
**How hermes does it:** `gateway/restart.py` (L1–21), `gateway/shutdown_forensics.py` (L1–16), `_handle_update_command` (L3403).
**Mapping:** `/update` Telegram command: git pull, restart tmux poller via start.sh, message "back up, running <commit>". Forensics = crash-note file written on signal, reported on next boot.
**Effort:** S–M. **Scores:** usefulness 3 / CV 3 — closes the SSH-to-restart loop from the phone.

### F3. Memory (RSS) monitor
`gateway/memory_monitor.py` — periodic RSS log lines. The poller is tiny; skip. usefulness 1 / CV 1.

---

## G. Honest poor fits (surveyed, not recommended)

- **Kanban multi-agent work queue** (`tools/kanban_tools.py`, `plugins/kanban/`): SQLite board + dispatcher + worker profiles + dashboard. Assumes a fleet of long-running workers; for one user on one droplet it's machinery without a customer. usefulness 1 / CV 3, effort L.
- **Delegation / subagents** (`tools/delegate_tool.py`): Claude Code's native Task tool already provides this inside claude -p sessions.
- **Programmatic tool calling** (`tools/code_execution_tool.py`): in Claude Code, Bash already is the pipeline collapser; also disabled on Windows.
- **Todo tool**: Claude Code has TodoWrite natively; sessions are single-message.
- **Checkpoints/undo** (`tools/checkpoint_manager.py`): Claude Code ships checkpoint/rewind already.
- **Image/video generation, X search**: require FAL/xAI keys — violates the no-extra-API-keys constraint. (TTS is the exception: edge-tts is keyless.)
- **Browser automation stack** (camoufox/CDP): heavy chromium on a small droplet; WebFetch/WebSearch cover the read cases.
- **Multi-platform gateway, profiles, personalities, skins, i18n, ACP, TUI, desktop app, trajectory compressor, batch runner**: infrastructure for an audience the bot doesn't have.

---

## Top 5 recommendations (agent's ranking)

1. **Background memory/skill review loop (C1)** — M, usefulness 4, CV 5. Composes the ported stores into the actual self-improving loop, with a restricted-tool fork as a built-in security story. Hermes's review prompts are directly reusable.
2. **Dangerous-command guard + approval (A1, A2 first)** — S→M staged, usefulness 4, CV 5. Hardline PreToolUse hook first (afternoon, golden tests), then least-privilege AUTO sessions, then approval flow + inline buttons.
3. **Voice memo transcription (B1)** — M, usefulness 5, CV 3. Biggest day-to-day upgrade; whisper.cpp keeps it keyless. TTS (B2) later for demo factor.
4. **Progress UX: reactions + /stop (D1+D2)** — S, usefulness 5, CV 4. (Draft streaming already exists in this bot; the remaining parts are an hour each.)
5. **Webhook triggers (E1)** — M, usefulness 3, CV 5. HMAC-verified event → templated prompt → Telegram, reusing [AUTO]. Alternative if daily utility wins over demo value: the E2 cron upgrades (smaller, used more).

Honorable mentions: E2 (wake gate + [SILENT]) and C3 (history search CLI) are the best effort-to-value ratios in the list (~S each); F1 (/usage) is a half-day add.

---

## Where hermes is worse — don't regress

- **Recall direction:** hermes's cross-session recall is pull-only (model must decide to search). The bot's push-based auto-injected recall is better for a personal assistant — add pull (C3) alongside, don't replace.
- **External memory providers** (honcho, mem0, supermemory…): cloud services + extra keys + data residency for a personal model. Local guarded SQLite is strictly better here.
- **Fail-open auto-approval:** in non-interactive contexts hermes auto-approves dangerous commands with only a log warning (`tools/approval.py` L1095–1100). When porting A1: AUTO/cron sessions fail CLOSED (hermes's own cron default — deny — is the right copy; the generic fallback isn't).
- **Fail-open scanners:** tirith and OSV checks allow on error. For a single-user bot prefer deny-on-error for the hardline layer.
- **Skill-scan timing:** hermes scanned skills at install time only and shipped a real bypass (#3968, patched with a fire-time scan). This bot's write-time scan + injected-index-only design avoids the gap; if E2 lands, include the fire-time scan.
- **Confirm-before-write:** hermes has no equivalent of the calendar/email proposal→confirm pattern (its writes are gated by command patterns, not domain-level confirmation). Keep ours; A1 complements it.
