/**
 * poller.ts — Telegram long-poll loop that answers messages with `claude -p`.
 *
 * Each incoming message from an allow-listed user spawns a fresh
 * `claude -p --dangerously-skip-permissions` process (cwd = this directory, so
 * CLAUDE.md and injected memory apply). Conversation continuity comes from a
 * per-chat history file, not a persistent Claude session.
 *
 * Text, photos, documents, and voice notes are supported: attachments are
 * downloaded from Telegram into ./uploads — files are handed to Claude by path,
 * voice is transcribed first (transcribe.ts) and flows in as a typed message.
 * Other kinds (video, stickers, …) are declined honestly.
 *
 * Runs on Bun. Zero npm dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { popDue, addOnce, addFollowup, getFollowup, resolveFollowup, rebindFollowup, markNudged, dueNudges, pruneFollowups, fmt } from "./reminders.ts";
import { StreamParser, displayText } from "./stream.ts";
import { pickModel } from "./model.ts";
import { upcomingEvents, nudgeKey, loadNotified, saveNotified, pruneNotified } from "./calendar.ts";
import { getDb, insertMessage, recentMessages, searchMessages, renderRecall, importHistoryJson, type RecallHit } from "./db";
import { coreMemoryBlock, importMemoryMd } from "./memory";
import { skillsIndexBlock } from "./skills";
import { redact } from "./redact";
import { resolveBackend, transcribeVoice, shouldEchoTranscript, VOICE_MAX_SEC } from "./transcribe";
import { shouldReview, runReview } from "./review";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_DIR = import.meta.dir;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 240_000);

const HISTORY_DIR = process.env.HISTORY_DIR ?? join(PROJECT_DIR, "history");
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(PROJECT_DIR, "uploads");
const MEMORY_FILE = join(PROJECT_DIR, "memory", "MEMORY.md");
const OFFSET_FILE = join(HISTORY_DIR, ".offset");
const ACCESS_FILE =
  process.env.ACCESS_FILE ??
  join(homedir(), ".claude", "channels", "telegram", "access.json");

const TG_LIMIT = 4096; // Telegram hard limit on message length
const HISTORY_MAX = 20; // keep last 10 exchanges (user + assistant)
const RECALL_K = Number(process.env.RECALL_K ?? 4); // max recalled past messages injected per turn
const POLL_TIMEOUT = 30; // seconds Telegram holds a long-poll open
const FLUSH_MS = 1500; // min gap between Telegram edits while streaming (rate-limit safe)
const CAL_LEAD_MIN = Number(process.env.CAL_NUDGE_MINUTES ?? 15); // nudge this many minutes before an event
const CAL_CHECK_MS = Number(process.env.CAL_CHECK_MS ?? 300_000); // how often to scan the calendar

// Attachments
export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? 20 * 1024 * 1024); // Telegram getFile caps bot downloads at ~20MB
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 60_000); // give up on a stuck file download
const UPLOAD_MAX_AGE_MS = Number(process.env.UPLOAD_MAX_AGE_MS ?? 24 * 3600_000); // startup sweep removes orphans older than this

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
interface TgFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
}
interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}
interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  // Media we recognize but can't open yet — used only to decline honestly.
  video?: TgFile;
  video_note?: TgFile;
  audio?: TgFile;
  animation?: TgFile;
  sticker?: TgFile;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
    data?: string;
  };
}
interface HistoryItem {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

/** Call a Telegram Bot API method. Retries transient errors (429/409/network). */
async function tg(method: string, params: Record<string, unknown> = {}): Promise<any> {
  // Outgoing user-visible strings pass through the redactor — the one
  // chokepoint every message the bot sends goes through (Phase 4).
  if (typeof params.text === "string") params = { ...params, text: redact(params.text) };
  if (typeof params.caption === "string") params = { ...params, caption: redact(params.caption) };
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2000);
      continue;
    }

    const data: any = await res.json();
    if (data.ok) return data.result;

    const code = data.error_code;
    if (code === 429) {
      const retry = (data.parameters?.retry_after ?? 1) * 1000;
      console.error(`[TG] 429 rate limited on ${method}, waiting ${retry}ms`);
      await sleep(retry);
      continue;
    }
    if (code === 409) {
      console.error(
        `[TG] 409 conflict on ${method} — another process is polling this token. Backing off 5s.`,
      );
      await sleep(5000);
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${code} ${data.description}`);
  }
  throw new Error(`Telegram ${method} failed after retries`);
}

// ---------------------------------------------------------------------------
// Reactions, typing, and the /stop interrupt (phase 5 — feel)
// ---------------------------------------------------------------------------

const REACTION_START = "👀"; // we picked up your message
const REACTION_OK = "👍"; // finished
const REACTION_FAIL = "👎"; // something went wrong

/** The bot's @username, learned at startup; used to recognize `/stop@thisbot`. */
let botUsername = "";

/** Claude child processes in flight, keyed by chat id, so /stop can interrupt
 *  the right run. The poller handles messages one at a time per chat, so a chat
 *  has at most one interactive run; [AUTO] runs may overlap and are killable too. */
const inFlight = new Map<number, import("bun").Subprocess>();

function registerChild(chatId: number, proc: import("bun").Subprocess) {
  inFlight.set(chatId, proc);
}
/** Only clear the slot if it still holds *this* process (avoid a late finisher
 *  wiping a newer run's entry). */
function unregisterChild(chatId: number, proc: import("bun").Subprocess) {
  if (inFlight.get(chatId) === proc) inFlight.delete(chatId);
}

/** True when `text` is exactly the /stop command (optionally @-mentioning this
 *  bot). Case-insensitive; trims surrounding whitespace. A normal message that
 *  merely contains "/stop" is not a stop command and never interrupts a run. */
export function isStopCommand(text: string, botUsername: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "/stop") return true;
  if (botUsername && t === `/stop@${botUsername.toLowerCase()}`) return true;
  return false;
}

/** The finishing reaction: 👍 on success, 👎 on failure. */
export function outcomeReaction(ok: boolean): string {
  return ok ? REACTION_OK : REACTION_FAIL;
}

// ---------------------------------------------------------------------------
// Inline-button callbacks: reminder follow-ups (phase 5 — feel)
// callback_data protocol (≤64 bytes): "fu:<action>:<followupId>"
// ---------------------------------------------------------------------------

export interface FuCallback {
  action: "done" | "later" | "s1h" | "seve" | "stom";
  id: string;
}

export function parseFuCallback(data: string): FuCallback | null {
  const m = /^fu:(done|later|s1h|seve|stom):([\w-]+)$/.exec(data ?? "");
  return m ? { action: m[1] as FuCallback["action"], id: m[2] } : null;
}

export function fuKeyboard(id: string): unknown {
  return {
    inline_keyboard: [[
      { text: "בוצע ✓", callback_data: `fu:done:${id}` },
      { text: "תזכיר לי שוב", callback_data: `fu:later:${id}` },
    ]],
  };
}

export function snoozeKeyboard(id: string): unknown {
  return {
    inline_keyboard: [[
      { text: "+1 שעה", callback_data: `fu:s1h:${id}` },
      { text: "הערב 20:00", callback_data: `fu:seve:${id}` },
      { text: "מחר 09:00", callback_data: `fu:stom:${id}` },
    ]],
  };
}

/** Snooze target time (epoch s). Evening = today 20:00, or tomorrow if past. */
export function snoozeTarget(action: "s1h" | "seve" | "stom", nowEpoch: number): number {
  if (action === "s1h") return nowEpoch + 3600;
  const now = new Date(nowEpoch * 1000);
  if (action === "seve") {
    const eve = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0, 0, 0);
    const t = Math.floor(eve.getTime() / 1000);
    if (t > nowEpoch) return t;
    const eveTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 20, 0, 0, 0);
    return Math.floor(eveTomorrow.getTime() / 1000);
  }
  const tom = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return Math.floor(tom.getTime() / 1000);
}

/** Set (or, with empty emoji, clear) a reaction on a message. Best-effort: a
 *  reaction failure must never break the reply flow, so it's swallowed. */
async function setReaction(chatId: number, messageId: number, emoji: string) {
  try {
    await tg("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  } catch (e: any) {
    console.error(`[ERR] setMessageReaction: ${e?.message ?? e}`);
  }
}

/** Show the "typing…" bubble. Best-effort, like setReaction. */
async function sendTyping(chatId: number) {
  try {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch (e: any) {
    console.error(`[ERR] sendChatAction: ${e?.message ?? e}`);
  }
}

/** Split text into chunks within Telegram's per-message limit, preferring newline breaks. */
export function chunkText(text: string, limit = TG_LIMIT): string[] {
  const chunks: string[] = [];
  let s = text;
  while (s.length > limit) {
    let cut = s.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit; // no good break point — hard cut
    chunks.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^\n/, "");
  }
  if (s.length) chunks.push(s);
  return chunks.length ? chunks : [""];
}

/** Replace the ⏳ placeholder with the answer, sending overflow as extra messages. */
async function sendReply(chatId: number, placeholderId: number | null, text: string) {
  const chunks = chunkText(text);
  if (placeholderId != null) {
    try {
      await tg("editMessageText", { chat_id: chatId, message_id: placeholderId, text: chunks[0] });
    } catch {
      try {
        await tg("deleteMessage", { chat_id: chatId, message_id: placeholderId });
      } catch {}
      await tg("sendMessage", { chat_id: chatId, text: chunks[0] });
    }
  } else {
    await tg("sendMessage", { chat_id: chatId, text: chunks[0] });
  }
  for (let i = 1; i < chunks.length; i++) {
    await tg("sendMessage", { chat_id: chatId, text: chunks[i] });
  }
}

// ---------------------------------------------------------------------------
// Attachments (photos & documents)
// ---------------------------------------------------------------------------

/** True when a known file size is over the cap. Unknown size → let it try
 *  (Telegram still rejects >20MB at getFile, caught as a download error). */
export function isTooLarge(size: number | undefined, max = MAX_FILE_BYTES): boolean {
  return size != null && size > max;
}

/** Sanitize a name into a single on-disk path segment. Unicode-aware, so Hebrew
 *  and other scripts survive; strips separators and risky punctuation. The caller
 *  always prepends a timestamp, so even a bare ".." can't traverse out of uploads/. */
export function safeDiskName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "file";
}

/** Strip characters that would let a filename break out of the bracketed note we
 *  hand to Claude — defense-in-depth against prompt injection via the file name. */
function displayName(name: string): string {
  return name.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** Describe the readable attachment (photo or document) on a message WITHOUT
 *  downloading it, so the caller can size-check first. Null if there is none. */
export function attachmentInfo(
  msg: TgMessage,
): { fileId: string; name?: string; size?: number; kind: string } | null {
  if (msg.photo?.length) {
    // Telegram sends the same photo in ascending sizes; the last is the largest.
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, size: largest.file_size, kind: "an image" };
  }
  if (msg.document) {
    const shown = msg.document.file_name ? displayName(msg.document.file_name) : "";
    return {
      fileId: msg.document.file_id,
      name: msg.document.file_name,
      size: msg.document.file_size,
      kind: shown ? `a file (${shown})` : "a file",
    };
  }
  return null;
}

/** Human label for media we recognize but can't open, else null. */
export function unsupportedMediaKind(msg: TgMessage): string | null {
  if (msg.video) return "a video";
  if (msg.video_note) return "a video note";
  if (msg.audio) return "an audio file";
  if (msg.animation) return "a GIF";
  if (msg.sticker) return "a sticker";
  return null;
}

/** Describe a voice bubble (file id, duration, size) WITHOUT downloading it,
 *  so the caller can gate on duration/size first. Null when not a voice msg. */
export function voiceInfo(
  msg: TgMessage,
): { fileId: string; duration: number; size?: number } | null {
  if (!msg.voice) return null;
  return {
    fileId: msg.voice.file_id,
    duration: msg.voice.duration ?? 0,
    size: msg.voice.file_size,
  };
}

/** True when there is nothing to act on: no readable attachment, no typed
 *  words, and no voice transcript. A transcribed voice note arrives with empty
 *  `words` but IS the message — it must never be declined (the Task 8 bug). */
export function shouldDeclineUnreadable(
  attachment: { path: string; kind: string } | null,
  words: string,
  voiceText: string | null,
): boolean {
  return !attachment && !words && voiceText === null;
}

/** Download a Telegram file by file_id into ./uploads and return its local path. */
async function downloadFile(fileId: string, preferredName?: string): Promise<string> {
  const info = await tg("getFile", { file_id: fileId });
  const remotePath: string = info.file_path; // e.g. "photos/file_123.jpg"
  const url = `https://api.telegram.org/file/bot${TOKEN}/${remotePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  ensureDir(UPLOADS_DIR);
  const safe = safeDiskName(preferredName || basename(remotePath));
  const dest = join(UPLOADS_DIR, `${Date.now()}-${safe}`);
  await Bun.write(dest, await res.arrayBuffer());
  return dest;
}

/** Best-effort delete of a downloaded upload once we're done answering. */
function cleanupFile(path: string | undefined) {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch (e: any) {
    console.error(`[ERR] cleanup ${path}: ${e?.message ?? e}`);
  }
}

/** True if an uploads/ entry is one of our timestamp-prefixed files and older
 *  than maxAgeMs. Names that don't match the pattern are left untouched. */
export function staleByName(filename: string, now: number, maxAgeMs: number): boolean {
  const m = /^(\d+)-/.exec(filename);
  if (!m) return false;
  return now - Number(m[1]) > maxAgeMs;
}

/** Sweep orphaned uploads left behind by a crash mid-handling (runs at startup). */
function sweepUploads(maxAgeMs = UPLOAD_MAX_AGE_MS) {
  if (!existsSync(UPLOADS_DIR)) return;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(UPLOADS_DIR)) {
    if (!staleByName(name, now, maxAgeMs)) continue;
    try {
      rmSync(join(UPLOADS_DIR, name), { force: true });
      removed++;
    } catch {}
  }
  if (removed) console.log(`[UPLOADS] swept ${removed} stale file(s)`);
}

// ---------------------------------------------------------------------------
// Allowlist, history, memory
// ---------------------------------------------------------------------------

/** Read the allowlist fresh each message so edits to access.json apply live. */
function loadAllowList(): Set<string> {
  const data = readJson<{ allowFrom?: unknown[] }>(ACCESS_FILE, { allowFrom: [] });
  const list = Array.isArray(data.allowFrom) ? data.allowFrom : [];
  return new Set(list.map((id) => String(id)));
}

/**
 * Long-term memory for the prompt. Cutover (safe switch + backup): prefer the
 * DB-backed active core memory; fall back to the legacy flat MEMORY.md file if
 * the core is empty or the DB read errors, so the bot can never end up blank.
 */
function loadMemory(): string {
  try {
    const block = coreMemoryBlock(getDb());
    if (block) return block;
  } catch (e: any) {
    console.error(`[ERR] memory load (db): ${e?.message ?? e}`);
  }
  try {
    return readFileSync(MEMORY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

export function buildPrompt(
  history: HistoryItem[],
  name: string,
  text: string,
  recall: RecallHit[] = [],
  memory = "",
  skills = "",
): string {
  const lines: string[] = [];
  if (memory) {
    lines.push("What you know about the user (long-term memory):");
    lines.push(memory, "");
  }
  const recallLines = renderRecall(recall, name);
  if (recallLines.length) {
    lines.push(...recallLines, "");
  }
  if (skills) {
    lines.push(skills, "");
  }
  if (history.length) {
    lines.push("Recent conversation (for context):");
    for (const m of history) {
      lines.push(`${m.role === "user" ? name : "Assistant"}: ${m.content}`);
    }
    lines.push("");
  }
  lines.push(`New message from ${name}:`, text);
  return lines.join("\n");
}

/** What Claude sees for a voice note: the medium is named so it can read
 *  obvious mishearings charitably; the transcript stays the user's words. */
export function voicePromptText(transcript: string): string {
  return `[The user sent a voice note; this is its transcript — answer it like a typed message.]\n${transcript}`;
}

/** What history/recall stores for a voice note (file is transient). */
export function voiceHistoryNote(transcript: string): string {
  return `[voice] ${transcript}`;
}

// ---------------------------------------------------------------------------
// Claude (streaming)
// ---------------------------------------------------------------------------

/** Edits one or more Telegram messages to mirror the streaming state, spilling
 *  into extra messages when the text passes Telegram's 4096-char limit. */
class StreamRenderer {
  private messages: { id: number; text: string }[] = [];

  constructor(
    private chatId: number,
    placeholderId: number | null,
  ) {
    if (placeholderId != null) this.messages.push({ id: placeholderId, text: "⏳" });
  }

  async render(full: string) {
    const chunks = chunkText(full || "…", TG_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      const existing = this.messages[i];
      if (existing) {
        if (existing.text === chunks[i]) continue;
        try {
          await tg("editMessageText", { chat_id: this.chatId, message_id: existing.id, text: chunks[i] });
        } catch (e: any) {
          if (!String(e?.message ?? e).includes("not modified")) throw e;
        }
        existing.text = chunks[i];
      } else {
        const m = await tg("sendMessage", { chat_id: this.chatId, text: chunks[i] });
        this.messages.push({ id: m.message_id, text: chunks[i] });
      }
    }
  }
}

/** Extra, optional knobs for a single claude -p spawn. Used to put unattended
 *  [AUTO] sessions in least-privilege mode without changing normal messages. */
export interface SpawnOpts {
  /** Appended to the claude argv (e.g. --disallowedTools …). Kept at the end so
   *  a variadic flag can't swallow the base flags. */
  extraArgs?: string[];
  /** Merged into the child env (e.g. CLAUDE_AUTO_SESSION=1 for the guard hook). */
  env?: Record<string, string>;
  /** Prepended to every Telegram render of this reply (and counted toward the
   *  4096-char chunking), but NOT part of the returned/stored answer text.
   *  Used for the 🎤 low-confidence transcript echo. */
  renderPrefix?: string;
}

/** Run `claude -p` in streaming mode and render the reply to Telegram live.
 *  Returns the final answer text. */
async function streamClaude(
  prompt: string,
  chatId: number,
  placeholderId: number | null,
  model: string,
  opts: SpawnOpts = {},
): Promise<string> {
  const proc = Bun.spawn(
    // prettier-ignore
    [CLAUDE_BIN, "-p", "--model", model, "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--dangerously-skip-permissions", ...(opts.extraArgs ?? [])],
    {
      cwd: PROJECT_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TELEGRAM_CHAT_ID: String(chatId), ...(opts.env ?? {}) },
    },
  );
  // Track this child so /stop can interrupt it; clear the slot when it exits,
  // however it exits (normal, error, timeout, or killed by /stop).
  registerChild(chatId, proc);
  void proc.exited.finally(() => unregisterChild(chatId, proc));
  const stderrP = new Response(proc.stderr).text().catch(() => "");
  proc.stdin!.write(prompt);
  proc.stdin!.end();

  const prefix = opts.renderPrefix ?? "";
  const parser = new StreamParser();
  const renderer = new StreamRenderer(chatId, placeholderId);

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, CLAUDE_TIMEOUT_MS);

  // Throttle Telegram edits — deltas arrive far faster than we may edit.
  let lastFlush = 0;
  const flush = async () => {
    const now = Date.now();
    if (now - lastFlush < FLUSH_MS) return;
    lastFlush = now;
    await renderer
      .render(prefix + displayText(parser.state()))
      .catch((e) => console.error(`[ERR] render: ${e?.message ?? e}`));
  };

  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of proc.stdout as any) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        parser.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      await flush();
    }
  } finally {
    clearTimeout(killer);
  }
  if (buf.trim()) parser.push(buf);

  const code = await proc.exited;
  const final = parser.finalText();

  if (timedOut) {
    if (final) {
      await renderer.render(prefix + final).catch(() => {});
      return final;
    }
    throw new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`);
  }
  if (!final && code !== 0) {
    throw new Error(`claude exited ${code}: ${(await stderrP).slice(0, 300)}`);
  }
  await renderer
    .render(prefix + (final || "(no reply)"))
    .catch((e) => console.error(`[ERR] final render: ${e?.message ?? e}`));
  return final;
}

// ---------------------------------------------------------------------------
// Least-privilege [AUTO] sessions (phase 4 — protection floor)
// ---------------------------------------------------------------------------

/** Tools an [AUTO] reminder session may not use, denied at Claude Code's own
 *  tool layer via --disallowedTools (verified present in this CLI). This stops
 *  a reminder from scheduling more reminders — a self-replication guard. */
export const AUTO_DISALLOWED_TOOLS = [
  "Bash(bun run remind.ts add-once *)",
  "Bash(bun run remind.ts add-repeat *)",
];

/** Spawn options that put an unattended [AUTO] session in least-privilege mode.
 *  Two complementary layers: --disallowedTools blocks reminder scheduling at the
 *  tool layer, and CLAUDE_AUTO_SESSION=1 lets the PreToolUse guard hook
 *  (hooks/pretooluse-guard.ts) re-block reminders AND block Gmail draft creation
 *  — the latter can't be named in --disallowedTools because the Gmail MCP
 *  server id is per-deployment. Normal Telegram messages pass no opts and keep
 *  today's full-permission behavior exactly. */
export function autoSessionSpawn(): { extraArgs: string[]; env: Record<string, string> } {
  return {
    extraArgs: ["--disallowedTools", ...AUTO_DISALLOWED_TOOLS],
    env: { CLAUDE_AUTO_SESSION: "1" },
  };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(msg: TgMessage) {
  const chatId = msg.chat.id;
  if (!msg.from) return;
  const fromId = String(msg.from.id);
  const name = msg.from.first_name || msg.from.username || fromId;

  if (!loadAllowList().has(fromId)) {
    console.log(redact(`[SKIP] unauthorized ${name} (${fromId}): ${(msg.text ?? msg.caption ?? "").slice(0, 50)}`));
    return;
  }

  const words = msg.text ?? msg.caption ?? "";

  // /stop — interrupt a claude child currently running for this chat. Never
  // spawns claude; a normal message (even one mentioning "stop") is unaffected
  // and does NOT interrupt a running turn. The receive loop awaits interactive
  // turns sequentially, so in practice this reaches concurrently-running
  // children — an [AUTO] reminder job, or a future non-blocking turn.
  if (isStopCommand(msg.text ?? "", botUsername)) {
    const running = inFlight.get(chatId);
    if (running) {
      try {
        running.kill(); // SIGTERM
      } catch {}
      await tg("sendMessage", { chat_id: chatId, text: "נעצר ✋" }).catch(() => {});
    } else {
      await tg("sendMessage", { chat_id: chatId, text: "אין כרגע משימה רצה לעצור." }).catch(() => {});
    }
    return;
  }

  // Voice notes (phase 6): transcribe, then treat exactly like a typed message.
  // Gates run BEFORE the download; the ack fires early because transcription
  // adds latency before the ⏳ placeholder appears.
  // A caption on a voice message (possible only via bots/forwards) is dropped.
  const voice = voiceInfo(msg);
  let voiceText: string | null = null;
  let voiceConfidence: number | null = null;
  if (voice) {
    if (resolveBackend() === "off") {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "עוד לא מחובר אצלי תמלול קולי, אז אני לא יכול להאזין להקלטות כרגע.",
      }).catch(() => {});
      return;
    }
    if (voice.duration > VOICE_MAX_SEC) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `ההקלטה ארוכה מדי בשבילי — אני מתמלל עד ${Math.floor(VOICE_MAX_SEC / 60)} דקות.`,
      }).catch(() => {});
      return;
    }
    if (isTooLarge(voice.size)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "ההקלטה גדולה מדי בשבילי — טלגרם מגביל הורדות של בוטים בסביבות 20MB.",
      }).catch(() => {});
      return;
    }
    void setReaction(chatId, msg.message_id, REACTION_START);
    void sendTyping(chatId);

    let audioPath: string;
    try {
      audioPath = await downloadFile(voice.fileId, "voice.oga");
    } catch (e: any) {
      console.error(`[ERR] download voice from ${fromId}: ${e?.message ?? e}`);
      void setReaction(chatId, msg.message_id, outcomeReaction(false));
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ לא הצלחתי להוריד את ההקלטה מטלגרם. אפשר לנסות שוב?",
      }).catch(() => {});
      return;
    }
    try {
      const tr = await transcribeVoice(audioPath);
      voiceText = tr.text;
      voiceConfidence = tr.confidence;
    } catch (e: any) {
      console.error(`[ERR] transcribe voice from ${fromId}: ${e?.message ?? e}`);
      void setReaction(chatId, msg.message_id, outcomeReaction(false));
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ לא הצלחתי לתמלל את ההקלטה הפעם. אפשר לנסות שוב או לכתוב לי.",
      }).catch(() => {});
      return;
    } finally {
      // The audio is transient either way — transcribed or failed.
      cleanupFile(audioPath);
    }
    if (!voiceText.trim()) {
      // Terminal state: 👀 alone would read as "still working".
      void setReaction(chatId, msg.message_id, outcomeReaction(false));
      await tg("sendMessage", {
        chat_id: chatId,
        text: "לא קלטתי מילים בהקלטה 🎤 אפשר לנסות שוב?",
      }).catch(() => {});
      return;
    }
  }

  // Identify a readable photo/document before downloading, so we can reject an
  // oversize file with an honest message instead of a doomed "try again".
  const info = attachmentInfo(msg);
  if (info && isTooLarge(info.size)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "That file is too large for me to fetch — Telegram caps bot downloads at ~20 MB.",
    }).catch(() => {});
    return;
  }

  // Pull it down; text and captions are the accompanying words.
  let attachment: { path: string; kind: string } | null = null;
  if (info) {
    try {
      attachment = { path: await downloadFile(info.fileId, info.name), kind: info.kind };
    } catch (e: any) {
      console.error(`[ERR] download attachment from ${fromId}: ${e?.message ?? e}`);
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ I couldn't download that file from Telegram. Please try again.",
      }).catch(() => {});
      return;
    }
  }

  // Media we recognize but can't open (video, audio, GIF, sticker, …).
  const unsupported = attachment ? null : unsupportedMediaKind(msg);

  // Nothing readable and nothing said → polite, specific decline.
  if (shouldDeclineUnreadable(attachment, words, voiceText)) {
    const text = unsupported
      ? `I can't open ${unsupported} yet — I can read text, images, documents (PDFs, etc.), and voice notes.`
      : "I can read text, images, documents (PDFs, etc.), and voice notes right now — but not this kind of message yet.";
    await tg("sendMessage", { chat_id: chatId, text }).catch(() => {});
    return;
  }

  const { model, prompt: userMsg } = pickModel(voiceText ?? words);

  // What Claude sees: the user's words plus a note about the media.
  // What we store in history: a compact placeholder (the file path is transient).
  let messageForClaude = userMsg;
  let historyNote = userMsg;
  if (voiceText !== null) {
    messageForClaude = voicePromptText(userMsg);
    historyNote = voiceHistoryNote(userMsg);
  } else if (attachment) {
    const note = `[The user sent ${attachment.kind}, saved at: ${attachment.path} — open and read it to answer.]`;
    messageForClaude = userMsg ? `${userMsg}\n\n${note}` : note;
    historyNote = userMsg ? `[sent ${attachment.kind}] ${userMsg}` : `[sent ${attachment.kind}]`;
  } else if (unsupported) {
    // We have a caption but couldn't read the media — be honest with Claude.
    const note = `[The user also sent ${unsupported}, which you can't open. Answer from their words, and say you couldn't view the ${unsupported} if it matters.]`;
    messageForClaude = `${userMsg}\n\n${note}`;
    historyNote = `[sent ${unsupported}] ${userMsg}`;
  }
  const label = voiceText !== null ? "a voice note" : attachment?.kind ?? unsupported;
  console.log(redact(`[MSG] ${name} (${model})${label ? ` [${label}]` : ""}: ${userMsg || "(no caption)"}`));

  // 👀 ack on the user's message + a typing bubble while we work. Best-effort.
  // Voice notes already acked before transcription — skip the duplicate.
  if (voiceText === null) {
    void setReaction(chatId, msg.message_id, REACTION_START);
    void sendTyping(chatId);
  }

  let placeholderId: number | null = null;
  try {
    const ph = await tg("sendMessage", { chat_id: chatId, text: "⏳" });
    placeholderId = ph.message_id;
  } catch {}

  try {
    const db = getDb();
    // Recent history + recall are computed from PRIOR messages (before we store
    // the current one), so the new message is never duplicated or self-recalled.
    const history = recentMessages(db, chatId, HISTORY_MAX);
    const beforeId = history.length ? history[0].id : Number.MAX_SAFE_INTEGER;
    let recall: RecallHit[] = [];
    try {
      recall = searchMessages(db, chatId, userMsg || historyNote, RECALL_K, beforeId);
    } catch (e: any) {
      console.error(`[ERR] recall: ${e?.message ?? e}`);
    }
    let skills = "";
    try {
      skills = skillsIndexBlock(db, userMsg || historyNote);
    } catch (e: any) {
      console.error(`[ERR] skills: ${e?.message ?? e}`);
    }

    const echoPrefix =
      voiceText !== null && shouldEchoTranscript(voiceConfidence) ? `🎤 «${userMsg}»\n\n` : "";
    const answer =
      (await streamClaude(
        buildPrompt(history, name, messageForClaude, recall, loadMemory(), skills),
        chatId,
        placeholderId,
        model,
        echoPrefix ? { renderPrefix: echoPrefix } : {},
      )).trim() || "(no output)";

    const now = Math.floor(Date.now() / 1000);
    try {
      insertMessage(db, { chatId, role: "user", content: historyNote, ts: now, model });
      insertMessage(db, { chatId, role: "assistant", content: answer, ts: now, model });
    } catch (e: any) {
      // Reply already delivered; a persistence hiccup must not trigger the error reply.
      console.error(`[ERR] persist message: ${e?.message ?? e}`);
    }
    console.log(`[DONE] replied to ${fromId}`);
    void setReaction(chatId, msg.message_id, outcomeReaction(true));
    // Self-improvement pass (Phase 7): detached, cooldown-gated, never blocks.
    if (shouldReview(chatId, Math.floor(Date.now() / 1000))) {
      try {
        const transcript = recentMessages(db, chatId, 20).map((m) => ({ role: m.role, content: m.content }));
        runReview(transcript, { claudeBin: CLAUDE_BIN, cwd: PROJECT_DIR, env: process.env });
      } catch (e: any) {
        console.error(`[ERR] review: ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    console.error(`[ERR] handling message from ${fromId}: ${e?.message ?? e}`);
    void setReaction(chatId, msg.message_id, outcomeReaction(false));
    await sendReply(
      chatId,
      placeholderId,
      "⚠️ Sorry, something went wrong handling that. Please try again.",
    ).catch(() => {});
  } finally {
    // The saved file is transient — Claude has read it by now, so don't let
    // uploads/ grow without bound.
    cleanupFile(attachment?.path);
  }
}

/** Inline-button presses. ACK fast, allowlist-check, then route by namespace. */
async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  // Always ACK — otherwise Telegram shows a spinner on the button for minutes.
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (!loadAllowList().has(String(cq.from.id))) return;
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const parsed = parseFuCallback(cq.data ?? "");
  if (!parsed || chatId == null || messageId == null) return; // unknown namespace — ignore

  const nowS = Math.floor(Date.now() / 1000);
  if (parsed.action === "done") {
    const f = resolveFollowup(parsed.id, "done");
    if (!f) return; // already resolved — the ACK is enough
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${cq.message?.text ?? `⏰ ${f.text}`} — ✓ בוצע`,
    }).catch(() => {});
  } else if (parsed.action === "later") {
    if (getFollowup(parsed.id)?.status !== "pending") return;
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: snoozeKeyboard(parsed.id),
    }).catch(() => {});
  } else {
    const f = resolveFollowup(parsed.id, "snoozed");
    if (!f) return;
    const t = snoozeTarget(parsed.action, nowS);
    addOnce(f.chatId, t, f.text);
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `${cq.message?.text ?? `⏰ ${f.text}`} — נדחה ל־${fmt(t)}`,
    }).catch(() => {});
    console.log(`[REMIND] snoozed fu ${f.id} to ${fmt(t)}`);
  }
}

// ---------------------------------------------------------------------------
// Offset persistence (so restarts don't drop or replay messages)
// ---------------------------------------------------------------------------

function saveOffset(offset: number) {
  try {
    writeFileSync(OFFSET_FILE, String(offset));
  } catch (e: any) {
    console.error(`[ERR] could not save offset: ${e?.message ?? e}`);
  }
}

async function initOffset(): Promise<number> {
  if (existsSync(OFFSET_FILE)) {
    const n = Number(readFileSync(OFFSET_FILE, "utf8").trim());
    if (Number.isFinite(n)) return n;
  }
  // First run: skip any backlog so we don't answer messages sent before startup.
  const updates: TgUpdate[] = await tg("getUpdates", { offset: -1, timeout: 0 });
  if (updates.length) return updates[updates.length - 1].update_id + 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Reminder scheduler (fires due reminders on an interval)
// ---------------------------------------------------------------------------

async function checkReminders() {
  let due;
  try {
    due = popDue();
  } catch (e: any) {
    console.error(`[ERR] reminders check: ${e?.message ?? e}`);
    return;
  }
  for (const r of due) {
    try {
      if (r.text.startsWith("[AUTO] ")) {
        // "[AUTO] <prompt>" reminders run the prompt through Claude instead of pinging the text.
        const autoPrompt = r.text.slice("[AUTO] ".length);
        const ph = await tg("sendMessage", { chat_id: r.chatId, text: "⏳" });
        let skills = "";
        try {
          skills = skillsIndexBlock(getDb(), autoPrompt);
        } catch (e: any) {
          console.error(`[ERR] skills: ${e?.message ?? e}`);
        }
        const fullPrompt = buildPrompt([], "Maor", autoPrompt, [], loadMemory(), skills);
        // Unattended run → least-privilege: can't schedule reminders or file drafts.
        await streamClaude(fullPrompt, r.chatId, ph.message_id, "sonnet", autoSessionSpawn());
      } else {
        if (r.repeat) {
          await tg("sendMessage", { chat_id: r.chatId, text: `⏰ Reminder: ${r.text}` });
        } else {
          // One-time task reminders carry done/snooze buttons (follow-up loop).
          const fu = addFollowup(r.chatId, r.text, 0, Math.floor(Date.now() / 1000)); // messageId 0 = placeholder, rebound right after send
          const sent = await tg("sendMessage", {
            chat_id: r.chatId,
            text: `⏰ Reminder: ${r.text}`,
            reply_markup: fuKeyboard(fu.id),
          });
          rebindFollowup(fu.id, sent.message_id);
        }
      }
      console.log(redact(`[REMIND] fired ${r.id} -> ${r.chatId}: ${r.text}`));
    } catch (e: any) {
      console.error(`[ERR] send reminder ${r.id}: ${e?.message ?? e}`);
    }
  }

  // One gentle nudge for follow-ups ignored for an hour; prune old resolved ones.
  const nowS = Math.floor(Date.now() / 1000);
  for (const f of dueNudges(nowS)) {
    try {
      // Mark BEFORE sending — same state-before-effect ordering as resolveFollowup;
      // a lost nudge beats a double-nudge when an [AUTO] run overlaps the tick.
      markNudged(f.id);
      const sent = await tg("sendMessage", {
        chat_id: f.chatId,
        text: `עדיין רלוונטי? ⏰ ${f.text}`,
        reply_markup: fuKeyboard(f.id),
      });
      rebindFollowup(f.id, sent.message_id);
      console.log(`[REMIND] nudged ${f.id} -> ${f.chatId}`);
    } catch (e: any) {
      console.error(`[ERR] nudge ${f.id}: ${e?.message ?? e}`);
    }
  }
  try {
    pruneFollowups(nowS);
  } catch (e: any) {
    console.error(`[ERR] prune: ${e?.message ?? e}`);
  }
}

/** Nudge the owner ~CAL_LEAD_MIN before each upcoming iCloud event (deduped). */
async function checkCalendarNudges() {
  if (!process.env.ICLOUD_USER || !process.env.ICLOUD_APP_PASSWORD) return; // calendar not configured
  const chatId = Number([...loadAllowList()][0]);
  if (!Number.isFinite(chatId)) return;

  let events;
  try {
    events = await upcomingEvents(CAL_LEAD_MIN);
  } catch (e: any) {
    console.error(`[ERR] calendar nudge fetch: ${e?.message ?? e}`);
    return;
  }
  if (!events.length) return;

  const notified = pruneNotified(loadNotified(), Date.now());
  let changed = false;
  for (const e of events) {
    const k = nudgeKey(e);
    if (notified[k]) continue;
    const mins = Math.max(1, Math.round((e.start.getTime() - Date.now()) / 60_000));
    const hhmm = `${String(e.start.getHours()).padStart(2, "0")}:${String(e.start.getMinutes()).padStart(2, "0")}`;
    try {
      await tg("sendMessage", { chat_id: chatId, text: `🔔 In ${mins} min — ${e.title} (${hhmm})` });
      console.log(`[NUDGE] ${k} -> ${chatId}`);
      notified[k] = e.start.getTime();
      changed = true;
    } catch (err: any) {
      console.error(`[ERR] nudge send: ${err?.message ?? err}`);
    }
  }
  if (changed) saveNotified(notified);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error("[FATAL] TELEGRAM_BOT_TOKEN is not set. Source your .env first.");
    process.exit(1);
  }
  ensureDir(HISTORY_DIR);
  ensureDir(join(PROJECT_DIR, "memory"));
  try {
    const imported = importHistoryJson(getDb(), HISTORY_DIR, Math.floor(Date.now() / 1000));
    if (imported) console.log(`[DB] imported ${imported} legacy history messages`);
  } catch (e: any) {
    console.error(`[ERR] history import: ${e?.message ?? e}`);
  }
  try {
    let md = "";
    try { md = readFileSync(MEMORY_FILE, "utf8"); } catch {}
    const importedMem = importMemoryMd(getDb(), md, Math.floor(Date.now() / 1000));
    if (importedMem) console.log(`[DB] imported ${importedMem} memory entries from MEMORY.md`);
  } catch (e: any) {
    console.error(`[ERR] memory import: ${e?.message ?? e}`);
  }
  sweepUploads();

  let me: any;
  try {
    me = await tg("getMe");
  } catch (e: any) {
    console.error(`[FATAL] could not reach Telegram / bad token: ${e?.message ?? e}`);
    process.exit(1);
  }
  botUsername = me.username ?? "";
  console.log(`[BOT] Poller started as @${me.username}`);

  setInterval(() => {
    void checkReminders();
  }, 30_000);

  setInterval(() => {
    void checkCalendarNudges();
  }, CAL_CHECK_MS);

  let offset = await initOffset();

  while (true) {
    let updates: TgUpdate[] = [];
    try {
      updates = await tg("getUpdates", { offset, timeout: POLL_TIMEOUT });
    } catch (e: any) {
      console.error(`[ERR] getUpdates: ${e?.message ?? e}`);
      await sleep(3000);
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message) {
        try {
          await handleMessage(u.message);
        } catch (e: any) {
          console.error(`[ERR] unhandled: ${e?.message ?? e}`);
        }
      } else if (u.callback_query) {
        try {
          await handleCallback(u.callback_query);
        } catch (e: any) {
          console.error(`[ERR] callback: ${e?.message ?? e}`);
        }
      }
    }
    if (updates.length) saveOffset(offset);
  }
}

if (import.meta.main) main();
