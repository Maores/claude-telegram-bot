/**
 * dispatch.ts — update triage + queues for the non-blocking receive loop.
 *
 * The poller's loop must never await long work: callbacks ACK instantly on
 * their own serialized chain, /stop is handled at dispatch (kill + drain),
 * and message turns run in strict per-chat FIFO order so history/recall
 * always see the previous turn completed. Spec:
 * docs/superpowers/specs/2026-06-11-nonblocking-loop-design.md
 */

/** True when `text` is exactly the /stop command (optionally @-mentioning this
 *  bot). Case-insensitive; trims surrounding whitespace. A normal message that
 *  merely contains "/stop" is not a stop command and never interrupts a run.
 *  (Moved verbatim from poller.ts so triage has no import cycle.) */
export function isStopCommand(text: string, botUsername: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "/stop") return true;
  if (botUsername && t === `/stop@${botUsername.toLowerCase()}`) return true;
  return false;
}

/** The slice of a Telegram update that triage needs. */
export interface DispatchUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: unknown;
}

export type UpdateKind = "callback" | "stop" | "message" | "ignore";

/** Triage an update WITHOUT doing any work. /stop outranks "message" so it
 *  interrupts instead of queueing behind the very turn it targets. */
export function classifyUpdate(u: DispatchUpdate, botUsername: string): UpdateKind {
  if (u.callback_query) return "callback";
  if (u.message) return isStopCommand(u.message.text ?? "", botUsername) ? "stop" : "message";
  return "ignore";
}
