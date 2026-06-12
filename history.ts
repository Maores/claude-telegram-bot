/**
 * history.ts — deliberate archive digging, complementing automatic recall.
 *
 *   bun run history.ts search "<query>" [--chat <id>] [--days <n>] [--limit <k>]
 *   bun run history.ts context <message-id> [--around <n>]
 *
 * The agent runs these via Bash when Maor asks "what did we say/decide about
 * X?" and the automatic recall block didn't surface it (CLAUDE.md documents
 * this). Pure helpers exported for tests; IO only in main().
 */

import { getDb, searchHistory, contextAround, type HistoryHit, type MessageRow } from "./db";
import { fmt } from "./reminders.ts";

export interface SearchArgs {
  cmd: "search";
  query: string;
  chatId?: number;
  days?: number;
  limit?: number;
}
export interface ContextArgs {
  cmd: "context";
  id: number;
  around?: number;
}

/** argv (after the script name) → parsed command, or null for usage. */
export function parseHistoryArgs(argv: string[]): SearchArgs | ContextArgs | null {
  const [cmd, ...rest] = argv;
  const num = (s: string | undefined) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  if (cmd === "search") {
    const query = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
    if (!query) return null;
    const out: SearchArgs = { cmd: "search", query };
    for (let i = 1; i < rest.length; i += 2) {
      const v = num(rest[i + 1]);
      if (v == null) return null;
      if (rest[i] === "--chat") out.chatId = v;
      else if (rest[i] === "--days") out.days = v;
      else if (rest[i] === "--limit") out.limit = v;
      else return null;
    }
    return out;
  }
  if (cmd === "context") {
    const id = num(rest[0]);
    if (id == null) return null;
    const out: ContextArgs = { cmd: "context", id };
    if (rest.length > 1) {
      if (rest[1] !== "--around") return null;
      const a = num(rest[2]);
      if (a == null) return null;
      out.around = a;
    }
    return out;
  }
  return null;
}

const truncate = (s: string, max = 200) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** One search hit: `[#id YYYY-MM-DD HH:MM] role: content…` (single line). */
export function renderHit(h: HistoryHit): string {
  return `[#${h.id} ${fmt(h.ts)}] ${h.role}: ${truncate(h.content.replace(/\s+/g, " "))}`;
}

/** One context row; the target line is arrow-marked. */
export function renderContextRow(r: MessageRow, targetId: number): string {
  const mark = r.id === targetId ? "→" : " ";
  return `${mark} [#${r.id} ${fmt(r.ts)}] ${r.role}: ${truncate(r.content.replace(/\s+/g, " "))}`;
}

function main() {
  const parsed = parseHistoryArgs(process.argv.slice(2));
  if (!parsed) {
    console.log(
      'usage: bun run history.ts search "<query>" [--chat <id>] [--days <n>] [--limit <k>]\n' +
        "       bun run history.ts context <message-id> [--around <n>]",
    );
    process.exit(1);
  }
  const db = getDb();
  if (parsed.cmd === "search") {
    const hits = searchHistory(db, parsed.query, parsed);
    if (!hits.length) {
      console.log("(no matches)");
      return;
    }
    for (const h of hits) console.log(renderHit(h));
    console.log(`\n(${hits.length} hits — drill in with: bun run history.ts context <id>)`);
  } else {
    const rows = contextAround(db, parsed.id, parsed.around ?? 4);
    if (!rows.length) {
      console.log(`(no message #${parsed.id})`);
      return;
    }
    for (const r of rows) console.log(renderContextRow(r, parsed.id));
  }
}

if (import.meta.main) main();
