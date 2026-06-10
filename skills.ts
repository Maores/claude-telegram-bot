/**
 * skills.ts — guarded, self-written skill library (Phase 3 core of the
 * self-improving memory design; see
 * docs/superpowers/specs/2026-06-10-phase3-skills-design.md).
 *
 * Pure logic over a Database handle + a skills directory, so tests run on
 * ":memory:" + a mkdtempSync temp dir. Skill BODIES are SKILL.md files under
 * the directory; the `skills` row is the searchable index + usage counters and
 * stores the file path. Guardrails are code, not prompt text: provenance
 * routing (maor+clean→active, derived OR threat→quarantined), threat scan on
 * write AND at activation (defense-in-depth), do-NOT-capture hard rejects, and
 * index/search/view limited to active skills.
 *
 * Ideas ported from hermes-agent tools/skill_manager_tool.py + skill_usage.py
 * (MIT, NousResearch); threats.ts is reused directly. No skill journaling in
 * core (YAGNI).
 *
 * Ordering: every writer that touches a file writes/moves the file FIRST, then
 * the DB row. SQLite txns cannot span the filesystem, so a crash leaves at most
 * an orphan file (re-creatable), never a row pointing at a missing body.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sanitizeFtsQuery } from "./db";
import { scanThreats } from "./threats";
import type { Provenance } from "./memory";

export type SkillStatus = "active" | "quarantined" | "archived";

export interface SkillRow {
  id: number;
  name: string;
  description: string;
  tags: string;
  path: string;
  provenance: Provenance;
  status: SkillStatus;
  use_count: number;
  last_used_at: number | null;
  patch_count: number;
  pinned: number;
  created_by: string;
  created_ts: number;
  updated_ts: number;
}

export class SkillError extends Error {}

export const NAME_MAX = 64;
export const DESC_MAX = 1024;
const SOURCES: Provenance[] = ["maor", "derived"];
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getSkill(db: Database, name: string): SkillRow | null {
  return (db.query("SELECT * FROM skills WHERE name = ?").get(name) as SkillRow) ?? null;
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse `---` frontmatter (a flat `key: value` block) + markdown body and
 * validate the SKILL.md contract: name is lowercase-hyphen and ≤ NAME_MAX;
 * description ≤ DESC_MAX; body non-empty. Throws SkillError on any violation.
 * Hand-rolled (no YAML dep): the frontmatter is a simple key:value list.
 */
export function parseSkillMd(text: string): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text ?? "");
  if (!m) throw new SkillError("missing frontmatter — a SKILL.md must start with a --- … --- block");
  const front = m[1];
  const body = m[2] ?? "";
  const meta: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i === -1) throw new SkillError(`bad frontmatter line (expected key: value): ${line}`);
    meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const name = meta.name ?? "";
  const description = meta.description ?? "";
  if (!name) throw new SkillError("frontmatter is missing required field: name");
  if (!description) throw new SkillError("frontmatter is missing required field: description");
  if (name.length > NAME_MAX) throw new SkillError(`name too long (${name.length} > ${NAME_MAX} chars)`);
  if (!NAME_RE.test(name)) {
    throw new SkillError(`invalid name "${name}" — use lowercase letters, digits and single hyphens (e.g. book-flight)`);
  }
  if (description.length > DESC_MAX) {
    throw new SkillError(`description too long (${description.length} > ${DESC_MAX} chars)`);
  }
  if (!body.trim()) throw new SkillError("skill body is empty — a skill needs a reusable procedure");
  return { name, description, body };
}

/**
 * do-NOT-capture hard rejects (mechanizable parts of hermes :124-143). Skill
 * BODIES that are negative tool claims ("X is broken / doesn't work" — these
 * calcify into refusals) or a pure first-person task-narrative (no reusable
 * procedure) are rejected outright. Returns a reason string, or null if OK.
 */
export function rejectNonReusable(body: string): string | null {
  const text = body.trim();
  // Negative tool/capability claim — "<thing> is/isn't broken/working/usable".
  if (/\b(?:is|isn't|is not|not|never)\s+\w*\s*(?:broken|working|usable|use\b)/i.test(text)) {
    return "not reusable: reads as a negative tool claim (e.g. \"X is broken / doesn't work\") — these calcify into refusals; record it in memory instead";
  }
  // Pure task-narrative: opens with a first-person/temporal recount, no imperative procedure.
  if (/^(?:yesterday|today|earlier|last\s+\w+|i\s+(?:asked|told|wanted|tried)|maor\s+(?:asked|told|wanted))\b/i.test(text)) {
    return "not reusable: reads as a one-off task narrative, not a reusable procedure — record it in memory instead";
  }
  return null;
}

export interface CreateArgs {
  name: string;
  description: string;
  tags?: string;
  source: Provenance;
  body: string;
  now: number;
  createdBy?: string;
}
export interface CreateResult { id: number; status: "active" | "quarantined"; reason: string | null }

function renderSkillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body.trim()}\n`;
}

/**
 * Create a skill: validate the frontmatter contract, scan name+description+body
 * for threats at "strict", hard-reject non-reusable bodies, route provenance
 * (maor+clean→active; derived OR threat→quarantined), write the SKILL.md file,
 * then insert the index row. File is written before the row (see header).
 */
export function createSkill(db: Database, dir: string, a: CreateArgs): CreateResult {
  const tags = (a.tags ?? "").trim();
  // Validate by rendering then parsing — single source of the SKILL.md contract.
  const parsed = parseSkillMd(renderSkillMd(a.name, a.description, a.body));
  if (!SOURCES.includes(a.source)) throw new SkillError(`invalid source: ${a.source} (use maor|derived)`);
  if (getSkill(db, parsed.name)) throw new SkillError(`a skill named "${parsed.name}" already exists`);

  const nonReusable = rejectNonReusable(parsed.body);
  if (nonReusable) throw new SkillError(nonReusable);

  const threats = scanThreats(`${parsed.name} ${parsed.description} ${parsed.body}`, "strict");
  let status: "active" | "quarantined";
  let reason: string | null = null;
  if (threats.length) {
    status = "quarantined";
    reason = `threat scan: ${threats.join(", ")}`;
  } else if (a.source === "derived") {
    status = "quarantined";
    reason = "derived from untrusted content — needs Maor's activate";
  } else {
    status = "active";
  }

  const path = join(dir, `${parsed.name}.md`);
  const createdBy = a.createdBy ?? a.source;
  // File first, then the row (the row is the index of record).
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderSkillMd(parsed.name, parsed.description, parsed.body));
  const id = Number(
    db.query(
      `INSERT INTO skills (name, description, tags, path, provenance, status, created_by, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(parsed.name, parsed.description, tags, path, a.source, status, createdBy, a.now, a.now).lastInsertRowid,
  );
  return { id, status, reason };
}

export interface ViewResult { row: SkillRow; body: string }

/**
 * Read an ACTIVE skill's body from disk and bump use_count + last_used_at.
 * Quarantined/archived/missing skills throw — an unconfirmed body can never be
 * pulled into context via view.
 */
export function viewSkill(db: Database, dir: string, name: string, now: number): ViewResult {
  const row = getSkill(db, name);
  if (!row) throw new SkillError(`no skill named "${name}"`);
  if (row.status !== "active") {
    throw new SkillError(`skill "${name}" is not active (it is ${row.status}) — activate it first`);
  }
  let body: string;
  try {
    body = parseSkillMd(readFileSync(row.path, "utf8")).body;
  } catch {
    throw new SkillError(`skill "${name}" body is missing or unreadable at ${row.path}`);
  }
  db.query("UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").run(now, row.id);
  return { row: getSkill(db, name)!, body };
}

/** FTS5/BM25 over ACTIVE skills only (reuses sanitizeFtsQuery). [] on empty/hostile query. */
export function searchSkills(db: Database, query: string, k: number): SkillRow[] {
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  try {
    return db
      .query(
        `SELECT s.* FROM skills_fts JOIN skills s ON s.id = skills_fts.rowid
          WHERE skills_fts MATCH ? AND s.status = 'active'
          ORDER BY rank LIMIT ?`,
      )
      .all(match, k) as SkillRow[];
  } catch {
    return [];
  }
}

export function listSkills(db: Database, f: { status?: SkillStatus }): SkillRow[] {
  const sql = f.status
    ? "SELECT * FROM skills WHERE status = ? ORDER BY name"
    : "SELECT * FROM skills ORDER BY name";
  return (f.status ? db.query(sql).all(f.status) : db.query(sql).all()) as SkillRow[];
}

export interface PatchArgs { old: string; new: string; now: number }

/**
 * Substring-replace inside an active skill's body file. Exactly one occurrence
 * must match (0 or ≥2 → SkillError, file untouched). Snapshots the pre-edit
 * file to `<path>.bak.<now>` first, then writes, then bumps patch_count.
 */
export function patchSkill(db: Database, dir: string, name: string, a: PatchArgs): SkillRow {
  const row = getSkill(db, name);
  if (!row) throw new SkillError(`no skill named "${name}"`);
  if (row.status !== "active") {
    throw new SkillError(`skill "${name}" is not active (it is ${row.status}) — only active skills can be patched`);
  }
  const needle = a.old ?? "";
  if (!needle) throw new SkillError("empty match text");
  const current = readFileSync(row.path, "utf8");
  const count = current.split(needle).length - 1;
  if (count === 0) throw new SkillError(`no match for "${needle}" in skill "${name}"`);
  if (count > 1) throw new SkillError(`${count} (multiple) matches for "${needle}" in skill "${name}" — be more specific`);
  const updated = current.replace(needle, a.new);
  // Snapshot first, then overwrite the body, then bump the counter.
  copyFileSync(row.path, `${row.path}.bak.${a.now}`);
  writeFileSync(row.path, updated);
  db.query("UPDATE skills SET patch_count = patch_count + 1, updated_ts = ? WHERE id = ?").run(a.now, row.id);
  return getSkill(db, name)!;
}

const ARCHIVE_SUBDIR = ".archive";

function moveAndSetStatus(
  db: Database, name: string, _fromStatus: SkillStatus, toStatus: SkillStatus,
  fromPath: string, toPath: string, now: number,
): SkillRow {
  mkdirSync(join(toPath, ".."), { recursive: true });
  // File first, then the row.
  renameSync(fromPath, toPath);
  db.query("UPDATE skills SET status = ?, path = ?, updated_ts = ? WHERE name = ?").run(toStatus, toPath, now, name);
  return getSkill(db, name)!;
}

/** Soft-delete: active → archived, body moved to <dir>/.archive/<name>.md. */
export function archiveSkill(db: Database, dir: string, name: string, now: number): SkillRow {
  const row = getSkill(db, name);
  if (!row) throw new SkillError(`no skill named "${name}"`);
  if (row.status !== "active") throw new SkillError(`skill "${name}" is not active (it is ${row.status})`);
  const dest = join(dir, ARCHIVE_SUBDIR, `${name}.md`);
  return moveAndSetStatus(db, name, "active", "archived", row.path, dest, now);
}

/** Reverse an archive: archived → active, body moved back to <dir>/<name>.md. */
export function restoreSkill(db: Database, dir: string, name: string, now: number): SkillRow {
  const row = getSkill(db, name);
  if (!row) throw new SkillError(`no skill named "${name}"`);
  if (row.status !== "archived") throw new SkillError(`skill "${name}" is not archived (it is ${row.status})`);
  const dest = join(dir, `${name}.md`);
  return moveAndSetStatus(db, name, "archived", "active", row.path, dest, now);
}

/**
 * Promote a quarantined skill to active. Defense-in-depth: re-scan the ACTUAL
 * body on disk at activation (like promoteMemory) — a still-poisoned body stays
 * blocked rather than trusting the create-time verdict.
 */
export function activateSkill(db: Database, dir: string, name: string, now: number): SkillRow {
  const row = getSkill(db, name);
  if (!row) throw new SkillError(`no skill named "${name}"`);
  if (row.status !== "quarantined") throw new SkillError(`skill "${name}" is not quarantined (it is ${row.status})`);
  const parsed = parseSkillMd(readFileSync(row.path, "utf8"));
  const threats = scanThreats(`${parsed.name} ${parsed.description} ${parsed.body}`, "strict");
  if (threats.length) {
    throw new SkillError(
      `skill "${name}" still trips the threat scan (${threats.join(", ")}) — fix or archive it instead of activating`,
    );
  }
  db.query("UPDATE skills SET status = 'active', updated_ts = ? WHERE id = ?").run(now, row.id);
  return getSkill(db, name)!;
}
