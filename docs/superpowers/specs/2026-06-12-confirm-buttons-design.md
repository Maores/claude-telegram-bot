# Confirm buttons — tap-to-approve writes — design spec

Date: 2026-06-12
Status: approved (decisions confirmed with Maor in-session; Phase 5 leftover).

## Goal
Replace the typed-"כן" confirmation for bot-initiated writes with inline buttons:
the bot proposes the exact action, Maor taps [✓ אשר] or [✗ בטל], and an approved
action executes instantly — without spawning a claude session on the tap.

## Decisions (confirmed 2026-06-12)
1. v1 scope: calendar writes (`cal.ts add/edit/delete`) + task delete
   (`todo.ts delete`) — the CLI-executable confirmations. Email drafts keep the
   typed-yes flow (filing happens inside a claude session via the connector).
2. Buttons: ✓ אשר / ✗ בטל only. No שנה button — typing a correction in chat is
   already the modify path.
3. Expiry: a pending proposal stays tappable for 24 hours; expired taps get a
   "פג תוקף" toast (the stale-button pattern from PR #23).
4. Execution model: frozen command. The proposal registers the exact argv at
   propose time; the tap validates and executes exactly that, once-only.
   (Re-spawning claude on tap and faking a typed "כן" were considered and
   rejected: both add 5-20s latency and neither pins the approved action.)

## Components
- `pending.ts` — the pending-actions store + pure logic. `pending.json`
  (gitignored), guarded by the same cross-process lockfile helper the reminders
  stores use. Entry: `{ id, chatId, summary, argv: string[], createdAt,
  status: "pending" | "approved" | "cancelled" | "expired", turnId }`.
  Operations: `proposeAction` (register, id `pa<epoch><rand>`), `takePending`
  (entries registered during a given turn — the poller's post-turn pickup),
  `consumeAction` (once-only pending→approved/cancelled; marks and reports
  expired when 24h passed), `validateArgv` (security gate, below),
  `pruneActions` (drop old resolved/expired entries).
- `confirm.ts` — CLI for the bot's claude child:
  - `propose --summary "<one human line>" --argv-json '["bun","run","cal.ts",...]'`
    — chat id from `$TELEGRAM_CHAT_ID`, turn id from `$TELEGRAM_TURN_ID`;
    validates BEFORE storing; prints the id and an instruction that buttons are
    coming and the command must NOT be run directly.
  - `approve <id>` / `cancel <id>` — the typed-"כן"/"לא" fallback: same
    consume + validate + execute path, output printed so claude can relay it.
  - `list` — open proposals for this chat.
- `poller.ts` —
  - `streamClaude` passes a fresh `TELEGRAM_TURN_ID` to every child (the
    SpawnOpts env plumbing already exists); `handleMessage` keeps the id.
  - After a successful turn: `takePending(chatId, turnId)` → one compact
    message per proposal: `🔘 <summary>` with [✓ אשר][✗ בטל]
    (`pa:ok:<id>` / `pa:no:<id>` — second callback namespace next to `fu:`).
    The `[AUTO]` reminder runner does the same pickup after ITS claude run
    completes (it has no handleMessage turn), so scheduled jobs' proposals
    also arrive as buttons.
  - `handleCallback` routes by namespace prefix. `pa:ok` → consume once-only →
    validate → `Bun.spawn(argv)` directly (no shell, `cwd` = project dir, 30s
    timeout, stdout/stderr captured) → edit the proposal message into the
    receipt (`✓ <summary>` + first output line) or a clear failure
    (`⚠️ נכשל: <reason>`; the entry stays consumed — re-ask in chat).
    `pa:no` → `✗ בוטל — <summary>`. Stale → "כבר טופל" toast; expired →
    "פג תוקף" toast. Every press already logs a `[CB]` line.
  - Prune piggybacks the existing reminder tick.
- `CLAUDE.md` — calendar + task-delete sections rewritten: the bot registers
  via `confirm.ts propose` instead of asking for a typed yes; if Maor confirms
  in TEXT anyway, the bot must run `confirm.ts approve <id>` — never the raw
  command — so one execution path exists and a later tap shows "כבר טופל".
  Email section unchanged.

## Security gate (checked at execution time, every path)
1. Hard allowlist: argv must be exactly `["bun","run","cal.ts",<add|edit|delete>,...]`
   or `["bun","run","todo.ts","delete",...]` — script names matched exactly,
   no paths or variants. Anything else refuses to execute even if registered.
2. The guard blocklist (same scan the PreToolUse hook uses) re-checked on the
   joined argv.
3. No shell anywhere: argv arrays are spawned directly; quoting and `;` are
   inert. Proposals are stored and re-validated as arrays end to end.
4. Once-only consumption (atomic, the resolveFollowup pattern) + 24h expiry.
5. [AUTO] sessions may `propose` (safe automation: a scheduled job can suggest
   a write and Maor wakes up to buttons) but `confirm.ts approve` joins the
   [AUTO] denylist in guard.ts — unattended runs can never self-approve. [AUTO] sessions also may not run the confirm-gated writes (cal.ts add/edit/delete, todo.ts delete) directly — propose is their only write channel.
6. Existing layers still apply: handleCallback's user allowlist, the redactor
   on every outgoing summary, `[CB]` press logging.

Threat model: prompt injection via untrusted content (email/web/files). Worst
case after this feature: the attacker gets a visible calendar/task proposal
with a frozen, allowlisted command attached, which does nothing until Maor
explicitly taps it.

## Edge cases
- Multiple proposals in one turn: one message + button set each, independent.
- Execution failure: receipt shows the failure; entry consumed; no retry button.
- Superseded proposals: simply expire; no auto-cancel on new proposals.
- Restart between propose and tap: store and buttons survive (file-backed,
  message lives in Telegram); the graceful drain (PR #23) protects the tap.
- `confirm.ts propose` with invalid argv fails loudly at propose time, so the
  bot can rephrase instead of registering a dud.
- A tap-execution may run concurrently with a claude turn writing calendar/task state (the callback chain and chat queues are independent) — accepted: CalDAV writes are independent requests, and serializing taps behind turns would forfeit the instant-tap UX.

## Testing
- Unit (pure): `validateArgv` accept/reject table (incl. path tricks
  `../cal.ts`, wrong subcommands, non-`bun` argv0, blocklist hits inside
  arguments); propose/consume once-only; expiry at the 24h boundary; prune;
  `pa:` callback parsing; keyboard shape.
- CLI smoke without creds/env: clean usage errors, exit 1.
- Live arc on the droplet after deploy: propose → ✓ executes (calendar write
  lands); propose → ✗ cancels; double-tap → "כבר טופל"; expired entry → "פג
  תוקף"; typed-"כן" fallback through `confirm.ts approve`; [AUTO] approve
  denied by the guard hook.

## Delivery
Branch `feat/confirm-buttons`, spec → plan → subagent implementation with
per-task spec review + final deep review, PR left OPEN for Maor.

## Out of scope (v1)
Email-draft buttons (needs claude-at-tap); a שנה button; retry buttons on
failure; per-proposal custom expiry; buttons for memory/skill promotions.
