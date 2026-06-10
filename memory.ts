/**
 * memory.ts — guarded long-term memory (Phase 2 of the self-improving
 * memory design; see docs/superpowers/specs/2026-06-09-phase2-curation-design.md).
 *
 * Pure logic over a Database handle so tests run on ":memory:". Guardrails
 * are code, not prompt text: provenance routing (maor→active,
 * derived→quarantined), threat scan on write and load, per-kind char
 * budgets, soft-delete + append-only journal.
 *
 * Status semantics: active = core (budgeted, injectable after cutover);
 * archived = uncapped searchable store (remove() puts rows here);
 * quarantined = held at the trust boundary (never searched/injected).
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeFtsQuery } from "./db";
import { scanThreats } from "./threats";

export type Kind = "user" | "agent";
export type Provenance = "maor" | "derived";
export type MemStatus = "active" | "quarantined" | "archived";

export interface MemoryRow {
  id: number;
  kind: Kind;
  content: string;
  provenance: Provenance;
  status: MemStatus;
  reason: string | null;
  created_ts: number;
  updated_ts: number;
}

export class MemoryError extends Error {}

export const ENTRY_MAX = Number(process.env.MEM_ENTRY_MAX ?? 500);
export const USER_BUDGET = Number(process.env.MEM_USER_BUDGET ?? 1375);
export const AGENT_BUDGET = Number(process.env.MEM_AGENT_BUDGET ?? 2200);

const KINDS: Kind[] = ["user", "agent"];
const SOURCES: Provenance[] = ["maor", "derived"];

export function journal(
  db: Database,
  e: {
    ts: number; actor: string; action: string; targetTable: string;
    targetId: number | null; provenance?: string | null; reason?: string | null;
    before?: unknown; after?: unknown;
  },
): void {
  db.query(
    `INSERT INTO journal (ts, actor, action, target_table, target_id, provenance, reason, before, after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.ts, e.actor, e.action, e.targetTable, e.targetId,
    e.provenance ?? null, e.reason ?? null,
    e.before == null ? null : JSON.stringify(e.before),
    e.after == null ? null : JSON.stringify(e.after),
  );
}

export function getMemory(db: Database, id: number): MemoryRow | null {
  return (db.query("SELECT * FROM memory WHERE id = ?").get(id) as MemoryRow) ?? null;
}

export function budgetFor(kind: Kind): number {
  return kind === "user" ? USER_BUDGET : AGENT_BUDGET;
}

/** Sum of active core content chars for a kind. */
export function coreChars(db: Database, kind: Kind): number {
  const r = db
    .query("SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM memory WHERE kind = ? AND status = 'active'")
    .get(kind) as { n: number };
  return r.n;
}

/** Throws the consolidate-now error if adding `extra` chars would overflow `kind`'s core. */
export function checkBudget(db: Database, kind: Kind, extra: number): void {
  const used = coreChars(db, kind);
  const budget = budgetFor(kind);
  if (used + extra <= budget) return;
  const rows = db
    .query("SELECT id, content FROM memory WHERE kind = ? AND status = 'active' ORDER BY id")
    .all(kind) as { id: number; content: string }[];
  const listing = rows.map((r) => `  [${r.id}] (${r.content.length} ch) ${r.content}`).join("\n");
  throw new MemoryError(
    `${kind} core is over budget: ${used} + ${extra} > ${budget} chars. ` +
      `consolidate now, this turn — merge or remove entries (mem.ts replace/remove), then retry.\n` +
      `Current ${kind} entries:\n${listing}`,
  );
}

export interface AddArgs {
  kind: Kind; content: string; source: Provenance; now: number; actor?: string;
}
export interface AddResult { id: number; status: "active" | "quarantined"; reason: string | null }

export function addMemory(db: Database, a: AddArgs): AddResult {
  const content = a.content?.trim();
  if (!KINDS.includes(a.kind)) throw new MemoryError(`invalid kind: ${a.kind} (use user|agent)`);
  if (!SOURCES.includes(a.source)) throw new MemoryError(`invalid source: ${a.source} (use maor|derived)`);
  if (!content) throw new MemoryError("content is empty");
  if (content.length > ENTRY_MAX) {
    throw new MemoryError(`entry too long (${content.length} > ${ENTRY_MAX} chars) — split or shorten it`);
  }

  const threats = scanThreats(content, "strict");
  let status: "active" | "quarantined";
  let reason: string | null = null;
  if (threats.length) {
    status = "quarantined";
    reason = `threat scan: ${threats.join(", ")}`;
  } else if (a.source === "derived") {
    status = "quarantined";
    reason = "derived from untrusted content — needs Maor's promote";
  } else {
    status = "active";
  }
  if (status === "active") checkBudget(db, a.kind, content.length);

  const actor = a.actor ?? "bot";
  let id!: number;
  // Write + audit journal must commit together or not at all.
  db.transaction(() => {
    id = Number(
      db.query(
        "INSERT INTO memory (kind, content, provenance, status, reason, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(a.kind, content, a.source, status, reason, a.now, a.now).lastInsertRowid,
    );
    journal(db, {
      ts: a.now, actor, action: "add", targetTable: "memory", targetId: id,
      provenance: a.source, reason, before: null, after: getMemory(db, id),
    });
  })();
  return { id, status, reason };
}

/** Resolve a substring to exactly one non-archived row, else throw with candidates. */
export function resolveBySubstring(db: Database, sub: string): MemoryRow {
  const needle = sub?.trim();
  if (!needle) throw new MemoryError("empty match text");
  const rows = db
    .query("SELECT * FROM memory WHERE status != 'archived' AND instr(content, ?) > 0 ORDER BY id")
    .all(needle) as MemoryRow[];
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) throw new MemoryError(`no memory entry matches "${needle}"`);
  const listing = rows.map((r) => `  [${r.id}] ${r.content}`).join("\n");
  throw new MemoryError(`${rows.length} entries match "${needle}" — be more specific:\n${listing}`);
}

export interface ReplaceArgs { old: string; new: string; now: number; actor?: string }

export function replaceMemory(db: Database, a: ReplaceArgs): MemoryRow {
  const target = resolveBySubstring(db, a.old);
  const content = a.new?.trim();
  if (!content) throw new MemoryError("replacement content is empty");
  if (content.length > ENTRY_MAX) {
    throw new MemoryError(`entry too long (${content.length} > ${ENTRY_MAX} chars) — split or shorten it`);
  }
  const threats = scanThreats(content, "strict");
  // Replace preserves target.status: a clean edit never promotes a quarantined
  // row to active (that's promoteMemory's job, gated by the re-scan above).
  const status: MemStatus = threats.length ? "quarantined" : target.status;
  const reason = threats.length ? `threat scan: ${threats.join(", ")}` : target.reason;
  if (status === "active") {
    checkBudget(db, target.kind, content.length - target.content.length);
  }
  let after!: MemoryRow;
  // Write + audit journal must commit together or not at all.
  db.transaction(() => {
    db.query("UPDATE memory SET content = ?, status = ?, reason = ?, updated_ts = ? WHERE id = ?").run(
      content, status, reason, a.now, target.id,
    );
    after = getMemory(db, target.id)!;
    journal(db, {
      ts: a.now, actor: a.actor ?? "bot", action: "replace", targetTable: "memory",
      targetId: target.id, provenance: target.provenance, reason, before: target, after,
    });
  })();
  return after;
}

export interface RemoveArgs { old: string; reason?: string; now: number; actor?: string }

export function removeMemory(db: Database, a: RemoveArgs): MemoryRow {
  const target = resolveBySubstring(db, a.old);
  let after!: MemoryRow;
  // Write + audit journal must commit together or not at all.
  db.transaction(() => {
    db.query("UPDATE memory SET status = 'archived', reason = ?, updated_ts = ? WHERE id = ?").run(
      a.reason ?? target.reason, a.now, target.id,
    );
    after = getMemory(db, target.id)!;
    journal(db, {
      ts: a.now, actor: a.actor ?? "bot", action: "remove", targetTable: "memory",
      targetId: target.id, provenance: target.provenance, reason: a.reason ?? null,
      before: target, after,
    });
  })();
  return after;
}

function transition(
  db: Database, id: number, from: MemStatus, action: "promote" | "restore",
  opts: { now: number; actor?: string },
): MemoryRow {
  const target = getMemory(db, id);
  if (!target) throw new MemoryError(`no memory entry with id ${id}`);
  if (target.status !== from) throw new MemoryError(`entry ${id} is not ${from} (it is ${target.status})`);
  // Defense-in-depth: re-scan the ACTUAL content at activation time rather than
  // trusting any stored reason string. Nothing reaches 'active' with content that
  // trips the threat scan — covers promote and the remove→restore path alike.
  const threats = scanThreats(target.content, "strict");
  if (threats.length) {
    throw new MemoryError(
      `entry ${id} still trips the threat scan (${threats.join(", ")}) — fix or remove it instead of activating`,
    );
  }
  checkBudget(db, target.kind, target.content.length);
  let after!: MemoryRow;
  // Write + audit journal must commit together or not at all.
  db.transaction(() => {
    db.query("UPDATE memory SET status = 'active', reason = NULL, updated_ts = ? WHERE id = ?").run(opts.now, id);
    after = getMemory(db, id)!;
    journal(db, {
      ts: opts.now, actor: opts.actor ?? "bot", action, targetTable: "memory",
      targetId: id, provenance: target.provenance, before: target, after,
    });
  })();
  return after;
}

export function promoteMemory(db: Database, id: number, opts: { now: number; actor?: string }): MemoryRow {
  return transition(db, id, "quarantined", "promote", opts);
}

export function restoreMemory(db: Database, id: number, opts: { now: number; actor?: string }): MemoryRow {
  return transition(db, id, "archived", "restore", opts);
}

/** Load-time scrub: a row whose content trips the scan renders as a placeholder. */
export function scrubForContext(row: MemoryRow): string {
  const threats = scanThreats(row.content, "strict");
  if (!threats.length) return row.content;
  return `[BLOCKED: entry contained threat pattern(s): ${threats.join(", ")} — id ${row.id}; view raw with mem.ts show ${row.id} --raw, delete with mem.ts remove]`;
}

function scrubbedCopy(row: MemoryRow): MemoryRow {
  return { ...row, content: scrubForContext(row) };
}

/** FTS5/BM25 over active + archived rows (never quarantined), scrubbed. */
export function searchMemory(db: Database, query: string, k: number): MemoryRow[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  try {
    const rows = db
      .query(
        `SELECT m.* FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
          WHERE memory_fts MATCH ? AND m.status IN ('active','archived')
          ORDER BY rank LIMIT ?`,
      )
      .all(match, k) as MemoryRow[];
    return rows.map(scrubbedCopy);
  } catch {
    return [];
  }
}

export function listMemory(db: Database, f: { status?: MemStatus; kind?: Kind }): MemoryRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (f.status) { where.push("status = ?"); args.push(f.status); }
  if (f.kind) { where.push("kind = ?"); args.push(f.kind); }
  const sql = `SELECT * FROM memory${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id`;
  return (db.query(sql).all(...args) as MemoryRow[]).map(scrubbedCopy);
}

export function showMemory(db: Database, id: number, opts: { raw: boolean }): MemoryRow {
  const row = getMemory(db, id);
  if (!row) throw new MemoryError(`no memory entry with id ${id}`);
  return opts.raw ? row : scrubbedCopy(row);
}

/**
 * Render the active core memory (both kinds, scrubbed) as the long-term-memory
 * block the poller injects into the prompt. Returns "" when there is no active
 * core, so the caller can fall back to the legacy MEMORY.md file.
 */
export function coreMemoryBlock(db: Database): string {
  const user = listMemory(db, { kind: "user", status: "active" });
  const agent = listMemory(db, { kind: "agent", status: "active" });
  if (!user.length && !agent.length) return "";
  const lines: string[] = [];
  for (const r of user) lines.push(`- ${r.content}`);
  if (agent.length) {
    if (user.length) lines.push("");
    lines.push("Your own operational notes:");
    for (const r of agent) lines.push(`- ${r.content}`);
  }
  return lines.join("\n");
}

/**
 * One-time import of the flat MEMORY.md into user-core rows. Takes the file
 * CONTENT (caller reads the file) so tests stay filesystem-free. Marker-guarded
 * via meta key 'memory_md_imported'. Budget- and cap-exempt: it must mirror
 * today's reality without data loss; budgets bite on the NEXT write.
 */
export function importMemoryMd(db: Database, md: string, now: number): number {
  const done = db.query("SELECT value FROM meta WHERE key = 'memory_md_imported'").get();
  if (done) return 0;
  const lines = md
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
  let imported = 0;
  const run = db.transaction(() => {
    for (const content of lines) {
      const id = Number(
        db.query(
          "INSERT INTO memory (kind, content, provenance, status, reason, created_ts, updated_ts) VALUES ('user', ?, 'maor', 'active', NULL, ?, ?)",
        ).run(content, now, now).lastInsertRowid,
      );
      journal(db, {
        ts: now, actor: "import", action: "import", targetTable: "memory",
        targetId: id, provenance: "maor", before: null, after: getMemory(db, id),
      });
      imported++;
    }
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_md_imported', ?)").run(String(now));
  });
  run();
  return imported;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function renderMirror(db: Database, kind: Kind, title: string): string {
  const active = listMemory(db, { kind, status: "active" });
  const quarantined = listMemory(db, { kind, status: "quarantined" });
  const lines = [`# ${title}`, "", "(auto-generated mirror — edit via mem.ts, not by hand)", ""];
  for (const r of active) lines.push(`- ${r.content}`);
  if (quarantined.length) {
    lines.push("", "## Pending (quarantined) — promote or remove via mem.ts", "");
    for (const r of quarantined) lines.push(`- [${r.id}] ${r.content}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Export readable mirrors into `dir` (production: memory/mirror/ — never the
 * live memory/MEMORY.md while the cutover is on hold). Drift guard: if the
 * on-disk file no longer hash-matches our last export (meta key
 * mirror_sha_<name>), snapshot it to <name>.bak.<now> before overwriting.
 */
export function exportMirror(db: Database, dir: string, now: number): { written: string[]; baks: string[] } {
  mkdirSync(dir, { recursive: true });
  const files: [string, Kind, string][] = [
    ["USER.md", "user", "What the bot knows about Maor"],
    ["MEMORY.md", "agent", "The bot's own operational notes"],
  ];
  const written: string[] = [];
  const baks: string[] = [];
  for (const [name, kind, title] of files) {
    const path = join(dir, name);
    const metaKey = `mirror_sha_${name}`;
    const lastSha = (db.query("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value: string } | null)?.value;
    if (existsSync(path) && lastSha && sha(readFileSync(path, "utf8")) !== lastSha) {
      const bak = `${path}.bak.${now}`;
      copyFileSync(path, bak);
      baks.push(bak);
    }
    const content = renderMirror(db, kind, title);
    writeFileSync(path, content);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(metaKey, sha(content));
    written.push(path);
  }
  return { written, baks };
}
