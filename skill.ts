/**
 * skill.ts — CLI the bot calls (via Bash) to manage its self-written skills.
 *
 *   bun run skill.ts create   --name <slug> --desc "Use when …" --source maor|derived [--tags "a,b"] (--body "…" | --body-file <path>)
 *   bun run skill.ts view     <name>
 *   bun run skill.ts search   <query...>
 *   bun run skill.ts list     [--status active|quarantined|archived]
 *   bun run skill.ts patch    --name <slug> --old "<unique substring>" --new "<text>"
 *   bun run skill.ts archive  <name>
 *   bun run skill.ts restore  <name>
 *   bun run skill.ts activate <name>
 *
 * Landing dark: nothing here is read by the poller yet — skillsIndexBlock is
 * built + tested but not injected until the deferred cutover.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getDb } from "./db";
import {
  createSkill, viewSkill, searchSkills, listSkills, patchSkill,
  archiveSkill, restoreSkill, activateSkill, SkillError,
  type SkillStatus, type SkillRow,
} from "./skills";
import type { Provenance } from "./memory";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Parse --flag value pairs; bare args go to `_`. A flag with no following value is `true`. */
export function parseFlags(argv: string[]): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined) out[key] = true;
      else { out[key] = next; i++; }  // consume as value even if it starts with --
    } else out._.push(a);
  }
  return out;
}

const SKILLS_DIR = join(import.meta.dir, "skills");

function fmt(r: SkillRow): string {
  const tags = r.tags ? ` [${r.tags}]` : "";
  return `${r.name} (${r.status}/${r.provenance}, used ${r.use_count}×)${tags} — ${r.description}`;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) die("usage: skill.ts <create|view|search|list|patch|archive|restore|activate> ...");

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const f = parseFlags(rest);

  try {
    switch (cmd) {
      case "create": {
        let body = typeof f.body === "string" ? f.body : "";
        if (typeof f["body-file"] === "string") {
          try { body = readFileSync(f["body-file"], "utf8"); } catch { die(`cannot read --body-file ${f["body-file"]}`); }
        }
        const r = createSkill(db, SKILLS_DIR, {
          name: String(f.name ?? ""),
          description: String(f.desc ?? ""),
          tags: typeof f.tags === "string" ? f.tags : undefined,
          source: String(f.source ?? "") as Provenance,
          body,
          now,
          createdBy: typeof f["created-by"] === "string" ? f["created-by"] : undefined,
        });
        console.log(
          r.status === "active"
            ? `OK — created active skill (id ${r.id})`
            : `QUARANTINED ${r.id} — ${r.reason}. Activate with: skill.ts activate ${String(f.name)}`,
        );
        break;
      }
      case "view": {
        const name = f._[0];
        if (!name) die("usage: view <name>");
        const v = viewSkill(db, SKILLS_DIR, name, now);
        console.log(v.body);
        break;
      }
      case "search": {
        const hits = searchSkills(db, f._.join(" "), 8);
        if (!hits.length) { console.log("(no matches)"); break; }
        for (const h of hits) console.log(fmt(h));
        break;
      }
      case "list": {
        const rows = listSkills(db, { status: typeof f.status === "string" ? (f.status as SkillStatus) : undefined });
        if (!rows.length) { console.log("(no skills)"); break; }
        for (const r of rows) console.log(fmt(r));
        break;
      }
      case "patch": {
        const r = patchSkill(db, SKILLS_DIR, String(f.name ?? ""), { old: String(f.old ?? ""), new: String(f.new ?? ""), now });
        console.log(`OK — patched ${r.name} (patch #${r.patch_count})`);
        break;
      }
      case "archive": {
        const name = f._[0];
        if (!name) die("usage: archive <name>");
        const r = archiveSkill(db, SKILLS_DIR, name, now);
        console.log(`archived ${r.name} (restore with: skill.ts restore ${r.name})`);
        break;
      }
      case "restore": {
        const name = f._[0];
        if (!name) die("usage: restore <name>");
        const r = restoreSkill(db, SKILLS_DIR, name, now);
        console.log(`OK — restored ${r.name}`);
        break;
      }
      case "activate": {
        const name = f._[0];
        if (!name) die("usage: activate <name>");
        const r = activateSkill(db, SKILLS_DIR, name, now);
        console.log(`OK — now active: ${fmt(r)}`);
        break;
      }
      default:
        die(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof SkillError) die(e.message);
    throw e;
  }
}

if (import.meta.main) main();
