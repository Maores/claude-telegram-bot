/**
 * mem.ts — CLI the bot calls (via Bash) to manage guarded long-term memory.
 *
 *   bun run mem.ts add      --kind user|agent --source maor|derived --content "<text>"
 *   bun run mem.ts replace  --old "<unique substring>" --new "<text>"
 *   bun run mem.ts remove   --old "<unique substring>" [--reason "<why>"]
 *   bun run mem.ts search   <query...>
 *   bun run mem.ts list     [--status active|quarantined|archived] [--kind user|agent]
 *   bun run mem.ts show     <id> [--raw]
 *   bun run mem.ts promote  <id>
 *   bun run mem.ts restore  <id>
 *   bun run mem.ts import-md            (one-time; reads memory/MEMORY.md)
 *
 * Landing dark: nothing here is read by the poller yet — the live prompt
 * still comes from memory/MEMORY.md until the deferred cutover decision.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { getDb } from "./db";
import {
  addMemory, replaceMemory, removeMemory, searchMemory, listMemory, showMemory,
  promoteMemory, restoreMemory, importMemoryMd, exportMirror, MemoryError,
  type Kind, type MemStatus, type Provenance,
} from "./memory";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Parse --flag value pairs; bare args go to `_`. */
function parseFlags(argv: string[]): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const MIRROR_DIR = join(import.meta.dir, "memory", "mirror");
const MEMORY_MD = join(import.meta.dir, "memory", "MEMORY.md");

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) die("usage: mem.ts <add|replace|remove|search|list|show|promote|restore|import-md> ...");

const db = getDb();
const now = Math.floor(Date.now() / 1000);
const f = parseFlags(rest);
const fmt = (r: { id: number; kind: string; status: string; provenance: string; content: string }) =>
  `[${r.id}] (${r.kind}/${r.status}/${r.provenance}) ${r.content}`;

try {
  switch (cmd) {
    case "add": {
      const r = addMemory(db, {
        kind: String(f.kind ?? "") as Kind,
        source: String(f.source ?? "") as Provenance,
        content: String(f.content ?? ""),
        now,
        actor: typeof f.actor === "string" ? f.actor : undefined,
      });
      exportMirror(db, MIRROR_DIR, now);
      console.log(
        r.status === "active"
          ? `OK ${r.id} — saved to ${f.kind} core`
          : `QUARANTINED ${r.id} — ${r.reason}. Activate later with: mem.ts promote ${r.id}`,
      );
      break;
    }
    case "replace": {
      const r = replaceMemory(db, { old: String(f.old ?? ""), new: String(f.new ?? ""), now });
      exportMirror(db, MIRROR_DIR, now);
      console.log(`OK — ${fmt(r)}`);
      break;
    }
    case "remove": {
      const r = removeMemory(db, {
        old: String(f.old ?? ""),
        reason: typeof f.reason === "string" ? f.reason : undefined,
        now,
      });
      exportMirror(db, MIRROR_DIR, now);
      console.log(`archived ${r.id} (restore with: mem.ts restore ${r.id})`);
      break;
    }
    case "search": {
      const hits = searchMemory(db, f._.join(" "), 8);
      if (!hits.length) { console.log("(no matches)"); break; }
      for (const h of hits) console.log(fmt(h));
      break;
    }
    case "list": {
      const rows = listMemory(db, {
        status: typeof f.status === "string" ? (f.status as MemStatus) : undefined,
        kind: typeof f.kind === "string" ? (f.kind as Kind) : undefined,
      });
      if (!rows.length) { console.log("(no entries)"); break; }
      for (const r of rows) console.log(fmt(r));
      break;
    }
    case "show": {
      const id = Number(f._[0]);
      if (!Number.isInteger(id)) die("usage: show <id> [--raw]");
      console.log(fmt(showMemory(db, id, { raw: f.raw === true })));
      break;
    }
    case "promote": {
      const id = Number(f._[0]);
      if (!Number.isInteger(id)) die("usage: promote <id>");
      const r = promoteMemory(db, id, { now });
      exportMirror(db, MIRROR_DIR, now);
      console.log(`OK — now active: ${fmt(r)}`);
      break;
    }
    case "restore": {
      const id = Number(f._[0]);
      if (!Number.isInteger(id)) die("usage: restore <id>");
      const r = restoreMemory(db, id, { now });
      exportMirror(db, MIRROR_DIR, now);
      console.log(`OK — restored: ${fmt(r)}`);
      break;
    }
    case "import-md": {
      let md = "";
      try { md = readFileSync(MEMORY_MD, "utf8"); } catch { die(`cannot read ${MEMORY_MD}`); }
      const n = importMemoryMd(db, md, now);
      if (n) exportMirror(db, MIRROR_DIR, now);
      console.log(n ? `imported ${n} entries from MEMORY.md` : "already imported (marker present) — nothing to do");
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  if (e instanceof MemoryError) die(e.message);
  throw e;
}
