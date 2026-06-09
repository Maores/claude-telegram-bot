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
  // Budget enforcement for active rows is added in Task 4 (checkBudget).

  const actor = a.actor ?? "bot";
  const id = Number(
    db.query(
      "INSERT INTO memory (kind, content, provenance, status, reason, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(a.kind, content, a.source, status, reason, a.now, a.now).lastInsertRowid,
  );
  journal(db, {
    ts: a.now, actor, action: "add", targetTable: "memory", targetId: id,
    provenance: a.source, reason, before: null, after: getMemory(db, id),
  });
  return { id, status, reason };
}
