/**
 * todo.ts — CLI the bot calls to manage Maor's Apple Reminders tasks.
 *   bun run todo.ts list   [--done | --all] [--list "<name>"]
 *   bun run todo.ts lists
 *   bun run todo.ts add    --title "..." [--due <when>] [--list "<name>"] [--notes "..."]
 *   bun run todo.ts find   [--q "<title substr>"] [--list "<name>"]      (prints [uid] lines)
 *   bun run todo.ts done   (--uid <uid> | --q "...")
 *   bun run todo.ts snooze (--uid <uid> | --q "...") --to <when>
 *   bun run todo.ts edit   (--uid <uid> | --q "...") [--set-title "..."] [--set-due <when> | --clear-due] [--set-notes "..."]
 *   bun run todo.ts delete (--uid <uid> | --q "...")
 *
 * <when> is a local+offset timestamp (date -d '...' +%Y-%m-%dT%H:%M:%S%:z) or a
 * bare YYYY-MM-DD (becomes a date-only due). DELETE must only run AFTER Maor
 * explicitly confirmed in chat; everything else runs immediately and is echoed.
 */
import {
  listTodos,
  findTodos,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
  listNames,
  fmtTask,
  selectTasks,
  type FoundTask,
  type TaskPatch,
  type SelectMode,
} from "./tasks.ts";

// --- copied from cal.ts (cannot import: cal.ts runs its dispatch on import) ---

/** Parse `--key value` pairs and bare `--flag` booleans out of argv. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** A date string is either a full instant (offset/UTC) or a bare YYYY-MM-DD. */
function parseWhen(raw: string): Date {
  return new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
}

// -----------------------------------------------------------------------------

const dateOnlyRaw = (raw: string) => raw.length === 10;

/** Resolve flags to exactly one task from `pool`, or throw with candidates. */
function resolveTask(pool: FoundTask[], uid?: string, q?: string): FoundTask {
  const sel = uid
    ? pool.filter((t) => t.uid === uid)
    : q
      ? pool.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()))
      : [];
  if (sel.length === 0) throw new Error("no matching task (try `find` to see uids)");
  if (sel.length > 1) {
    const list = sel.map((t) => `  [${t.uid}] ${fmtTask(t)}`).join("\n");
    throw new Error(`multiple tasks match — pick one with --uid:\n${list}`);
  }
  return sel[0];
}

/** done/snooze/edit act on open tasks; delete/find act on everything. */
async function resolveOpen(f: Record<string, string | boolean>): Promise<FoundTask> {
  const pool = (await listTodos(str(f.list))).filter((t) => !t.done);
  return resolveTask(pool, str(f.uid), str(f.q));
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "list") {
    const f = parseFlags(rest);
    const mode: SelectMode = f.all === true ? "all" : f.done === true ? "done" : "open";
    const tasks = selectTasks(await listTodos(str(f.list)), mode);
    if (!tasks.length) {
      console.log(mode === "open" ? "(no open tasks)" : mode === "done" ? "(no completed tasks)" : "(no tasks)");
    } else {
      for (const t of tasks) console.log(fmtTask(t));
    }
  } else if (cmd === "lists") {
    const names = await listNames();
    console.log(names.length ? names.join("\n") : "(no task lists)");
  } else if (cmd === "add") {
    const f = parseFlags(rest);
    const title = str(f.title);
    if (!title) {
      throw new Error('usage: todo.ts add --title "..." [--due <when>] [--list "<name>"] [--notes "..."]');
    }
    const dueRaw = str(f.due);
    const due = dueRaw ? parseWhen(dueRaw) : undefined;
    if (due && isNaN(due.getTime())) throw new Error("invalid --due date");
    const res = await createTodo(
      { title, due, dueDateOnly: dueRaw ? dateOnlyRaw(dueRaw) : undefined, notes: str(f.notes) },
      str(f.list),
    );
    console.log(`created "${title}" in list "${res.list}" (uid ${res.uid})`);
  } else if (cmd === "find") {
    const f = parseFlags(rest);
    const matches = await findTodos(str(f.q), str(f.list));
    if (!matches.length) console.log("(no matching tasks)");
    else for (const t of matches) console.log(`[${t.uid}] ${fmtTask(t)}`);
  } else if (cmd === "done") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) throw new Error('usage: todo.ts done (--uid <uid> | --q "...")');
    const target = await resolveOpen(f);
    await completeTodo(target);
    console.log(`completed "${target.title}"`);
  } else if (cmd === "snooze") {
    const f = parseFlags(rest);
    const toRaw = str(f.to);
    if ((!str(f.uid) && !str(f.q)) || !toRaw) {
      throw new Error('usage: todo.ts snooze (--uid <uid> | --q "...") --to <when>');
    }
    const to = parseWhen(toRaw);
    if (isNaN(to.getTime())) throw new Error("invalid --to date");
    const target = await resolveOpen(f);
    await updateTodo(target, { due: to, dueDateOnly: dateOnlyRaw(toRaw) });
    console.log(`snoozed "${target.title}" to ${toRaw}`);
  } else if (cmd === "edit") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) {
      throw new Error('usage: todo.ts edit (--uid <uid> | --q "...") [--set-title "..."] [--set-due <when> | --clear-due] [--set-notes "..."]');
    }
    const patch: TaskPatch = {};
    if (str(f["set-title"]) !== undefined) patch.title = str(f["set-title"]);
    const sd = str(f["set-due"]);
    if (sd && f["clear-due"] === true) throw new Error("edit: --set-due and --clear-due are mutually exclusive");
    if (sd) {
      patch.due = parseWhen(sd);
      patch.dueDateOnly = dateOnlyRaw(sd);
      if (isNaN(patch.due.getTime())) throw new Error("invalid --set-due date");
    } else if (f["clear-due"] === true) {
      patch.due = null;
    }
    if (str(f["set-notes"]) !== undefined) patch.notes = str(f["set-notes"]);
    if (Object.keys(patch).length === 0) {
      throw new Error("edit: nothing to change (use --set-title / --set-due / --clear-due / --set-notes)");
    }
    const target = await resolveOpen(f);
    await updateTodo(target, patch);
    console.log(`updated "${patch.title ?? target.title}" (uid ${target.uid})`);
  } else if (cmd === "delete") {
    const f = parseFlags(rest);
    if (!str(f.uid) && !str(f.q)) throw new Error('usage: todo.ts delete (--uid <uid> | --q "...")');
    const pool = await listTodos(str(f.list)); // delete may target completed tasks too
    const target = resolveTask(pool, str(f.uid), str(f.q));
    await deleteTodo(target);
    console.log(`deleted "${target.title}"${target.recurring ? " (recurring — whole series removed)" : ""}`);
  } else {
    throw new Error("usage: todo.ts <list|lists|add|find|done|snooze|edit|delete> ...");
  }
} catch (e: any) {
  console.error(`task error: ${e?.message ?? e}`);
  process.exit(1);
}
