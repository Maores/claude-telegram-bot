# Non-blocking update loop — build design (fixes button lag, true /stop)

Status: spec for Maor's review (written 2026-06-11 late; build next session).

## The problem (bug report 2026-06-11 + investigation)

The receive loop awaits each update to completion before touching the next
(`poller.ts` ~1165-1180). A claude turn can hold that await for up to 240 s,
during which the loop neither handles queued updates nor issues the next
`getUpdates`. Consequences, confirmed by code reading:

- **Button lag (reported):** a `callback_query` behind any message — same
  batch or next batch — waits for the whole turn before `answerCallbackQuery`
  fires. Telegram's spinner gives up after ~30 s → "stuck button".
  `handleCallback` itself ACKs on its first line; it just isn't reached.
- **/stop is fake mid-answer (known roadmap gap):** a `/stop` message queues
  behind the very turn it is trying to interrupt; today it only reliably stops
  overlapping `[AUTO]` runs.

## Design

The loop becomes **dispatch-only**; nothing in it awaits long work.

Per update, triage at dispatch time:

1. **`callback_query`** → fire-and-forget onto a single **callback chain**
   (`cbTail = cbTail.then(() => handleCallback(cq)).catch(log)`). ACK is
   instant regardless of any running turn. Serializing callbacks *among
   themselves* keeps the `followups.json` read-modify-write single-writer
   (two rapid presses no longer race); they're sub-second ops, so a chain
   adds no perceptible latency.
2. **`/stop` message** (`isStopCommand` moves to dispatch) → handled
   immediately, never enqueued: kill the chat's `inFlight` child AND drop
   that chat's queued-but-unstarted messages. Mark the killed run "stopped"
   so its turn ends with `נעצר ✋` instead of the generic error reply.
3. **Any other message** → append to a **per-chat FIFO**
   (`Map<chatId, Promise>` promise-chain): strictly ordered within a chat,
   so history/recall always see the prior turn completed. Different chats
   may overlap (single-user today; matters only vs `[AUTO]`).

A new small module **`dispatch.ts`** owns the triage + queues so it is
unit-testable pure of Telegram:

```ts
classifyUpdate(u, botUsername): "callback" | "stop" | "message" | "ignore"
chainPerChat(map, chatId, job): Promise<void>   // ordering + error isolation
dropQueued(chatId): number                       // /stop support
```

`poller.ts` keeps `handleMessage`/`handleCallback` unchanged inside; only the
loop body and the /stop block move/shrink.

## Stopped-turn semantics

`inFlight` gains `{ proc, stoppedAt? }`. The /stop path sets `stoppedAt` then
kills. `streamClaude`'s abnormal-exit branch and `handleMessage`'s catch check
it: if stopped → edit the placeholder to `נעצר ✋`, reaction 👎 skipped, no
error reply, history row records `[stopped]`. (Today a killed interactive
child would surface as "something went wrong" — wrong message.)

## Unchanged / explicitly out of scope

- `getUpdates` offset handling: the crash-loss window (offset advances before
  a turn completes) exists today and stays as-is; queue persistence is NOT
  added. A crash mid-turn loses at most the in-flight + queued updates, same
  class as today.
- Reminder/calendar `setInterval` paths — already detached (`void`).
- Parallel turns within one chat (never), streaming multiplexing limits,
  webhook transport.
- Bug B (stale keyboards) — already fixed separately (PR #15).

## Risk controls

- **Kill-switch env `POLL_SERIAL=1`** restores today's sequential awaits
  (one `if` at dispatch). Cheap insurance for a core-loop change, given
  today's still-unexplained poller death; remove after a quiet week.
- Live soak after deploy: send a slow `/opus` question, press a reminder
  button mid-answer (ACK must be instant), `/stop` the answer (must die
  within ~1 s and reply נעצר), then a normal follow-up message (queue must
  resume cleanly).

## Decisions for Maor (recommendations inline)

1. `/stop` drops the chat's queued messages too — recommended yes (that's
   what "stop" means when you've also queued more texts behind a turn).
2. Callback serialization via one chain — recommended yes (file-race safety
   over unmeasurable latency).
3. Kill-switch default off (non-blocking active from day one) — recommended
   yes; the switch exists for rollback, not as a feature flag.

## Testing

- `dispatch.test.ts`: classify table (stop vs message vs callback vs junk,
  @mention forms); per-chat chain ordering under interleaved pushes; error in
  one job doesn't break the chain; dropQueued counts and clears only that
  chat; POLL_SERIAL short-circuit.
- `poller.test.ts`: stopped-turn reply selection (pure helper if extracted).
- Live soak checklist above; suite must stay green throughout.

## Effort

S-M: ~80-120 lines net (new `dispatch.ts` + loop rewrite + stop semantics),
plus tests. One PR.
