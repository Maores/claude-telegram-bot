/**
 * poller.ts — Telegram long-poll loop that answers messages with `claude -p`.
 *
 * Each incoming text message from an allow-listed user spawns a fresh
 * `claude -p --dangerously-skip-permissions` process (cwd = this directory, so
 * CLAUDE.md and injected memory apply). Conversation continuity comes from a
 * per-chat history file, not a persistent Claude session.
 *
 * Runs on Bun. Zero npm dependencies.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_DIR = import.meta.dir;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 240_000);

const HISTORY_DIR = process.env.HISTORY_DIR ?? join(PROJECT_DIR, "history");
const MEMORY_FILE = join(PROJECT_DIR, "memory", "MEMORY.md");
const OFFSET_FILE = join(HISTORY_DIR, ".offset");
const ACCESS_FILE =
  process.env.ACCESS_FILE ??
  join(homedir(), ".claude", "channels", "telegram", "access.json");

const TG_LIMIT = 4096; // Telegram hard limit on message length
const HISTORY_MAX = 20; // keep last 10 exchanges (user + assistant)
const POLL_TIMEOUT = 30; // seconds Telegram holds a long-poll open

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
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
// Allowlist, history, memory
// ---------------------------------------------------------------------------

/** Read the allowlist fresh each message so edits to access.json apply live. */
function loadAllowList(): Set<string> {
  const data = readJson<{ allowFrom?: unknown[] }>(ACCESS_FILE, { allowFrom: [] });
  const list = Array.isArray(data.allowFrom) ? data.allowFrom : [];
  return new Set(list.map((id) => String(id)));
}

function historyFile(chatId: number) {
  return join(HISTORY_DIR, `${chatId}.json`);
}
function loadHistory(chatId: number): HistoryItem[] {
  return readJson<HistoryItem[]>(historyFile(chatId), []);
}
function saveHistory(chatId: number, history: HistoryItem[]) {
  writeFileSync(historyFile(chatId), JSON.stringify(history.slice(-HISTORY_MAX), null, 2));
}

function loadMemory(): string {
  try {
    return readFileSync(MEMORY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

export function buildPrompt(history: HistoryItem[], name: string, text: string): string {
  const lines: string[] = [];
  const memory = loadMemory();
  if (memory) {
    lines.push("What you know about the user (long-term memory):");
    lines.push(memory, "");
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

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** Spawn `claude -p`, feed the prompt on stdin, return stdout. Kills on timeout. */
async function runClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn([CLAUDE_BIN, "-p", "--dangerously-skip-permissions"], {
    cwd: PROJECT_DIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  // Attach readers before writing stdin so a large response can't fill the pipe.
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();

  proc.stdin!.write(prompt);
  proc.stdin!.end();

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, CLAUDE_TIMEOUT_MS);

  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
  const code = await proc.exited;
  clearTimeout(killer);

  if (timedOut) throw new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`);
  return stdout;
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
    console.log(`[SKIP] unauthorized ${name} (${fromId}): ${(msg.text ?? "").slice(0, 50)}`);
    return;
  }

  if (!msg.text) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "I can only read text messages right now.",
    }).catch(() => {});
    return;
  }

  const text = msg.text;
  console.log(`[MSG] ${name}: ${text}`);

  let placeholderId: number | null = null;
  try {
    const ph = await tg("sendMessage", { chat_id: chatId, text: "⏳" });
    placeholderId = ph.message_id;
  } catch {}

  try {
    const history = loadHistory(chatId);
    const answer = (await runClaude(buildPrompt(history, name, text))).trim() || "(no output)";
    await sendReply(chatId, placeholderId, answer);

    history.push({ role: "user", content: text }, { role: "assistant", content: answer });
    saveHistory(chatId, history);
    console.log(`[DONE] replied to ${fromId}`);
  } catch (e: any) {
    console.error(`[ERR] handling message from ${fromId}: ${e?.message ?? e}`);
    await sendReply(
      chatId,
      placeholderId,
      "⚠️ Sorry, something went wrong handling that. Please try again.",
    ).catch(() => {});
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
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error("[FATAL] TELEGRAM_BOT_TOKEN is not set. Source your .env first.");
    process.exit(1);
  }
  ensureDir(HISTORY_DIR);
  ensureDir(join(PROJECT_DIR, "memory"));

  let me: any;
  try {
    me = await tg("getMe");
  } catch (e: any) {
    console.error(`[FATAL] could not reach Telegram / bad token: ${e?.message ?? e}`);
    process.exit(1);
  }
  console.log(`[BOT] Poller started as @${me.username}`);

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
      }
    }
    if (updates.length) saveOffset(offset);
  }
}

if (import.meta.main) main();
