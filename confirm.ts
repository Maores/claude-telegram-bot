/**
 * confirm.ts — register and resolve tap-to-approve write proposals.
 *   bun run confirm.ts propose --summary "<one short line>" --argv-json '["bun","run","cal.ts","add",...]'
 *   bun run confirm.ts approve <id>     (the typed-"כן" fallback — executes the stored command)
 *   bun run confirm.ts cancel  <id>
 *   bun run confirm.ts list
 *
 * Chat id comes from $TELEGRAM_CHAT_ID, turn id from $TELEGRAM_TURN_ID (both
 * injected by the poller). After `propose`, the poller sends Maor ✓/✗ buttons
 * automatically — NEVER run the proposed command directly.
 */
import {
  proposeAction,
  consumeAction,
  listPending,
  validateArgv,
  newTurnId,
} from "./pending.ts";

function envChat(): number {
  const n = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isFinite(n) || n === 0) throw new Error("TELEGRAM_CHAT_ID is not set");
  return n;
}

/** Parse `--key value` pairs out of argv (copied from cal.ts conventions). */
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

/** Run a stored argv directly (no shell), capture combined output. */
async function execArgv(argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { code, out: (code === 0 ? out : err || out).trim() };
}

const nowS = () => Math.floor(Date.now() / 1000);
const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "propose") {
    const f = parseFlags(rest);
    const summary = str(f.summary);
    const argvJson = str(f["argv-json"]);
    if (!summary || !argvJson) {
      throw new Error('usage: confirm.ts propose --summary "..." --argv-json \'["bun","run","cal.ts",...]\'');
    }
    let argv: unknown;
    try {
      argv = JSON.parse(argvJson);
    } catch {
      throw new Error("--argv-json is not valid JSON");
    }
    const v = validateArgv(argv);
    if (!v.ok) throw new Error(`that command can't be registered — ${v.reason}`);
    const turnId = process.env.TELEGRAM_TURN_ID ?? newTurnId();
    const a = proposeAction(envChat(), summary, argv as string[], turnId, nowS());
    console.log(
      `registered proposal ${a.id} — Maor will get ✓/✗ buttons after your reply. ` +
        `Do NOT run the command yourself; if he approves in text, run: bun run confirm.ts approve ${a.id}`,
    );
  } else if (cmd === "approve") {
    const id = rest[0];
    if (!id) throw new Error("usage: confirm.ts approve <id>");
    const r = consumeAction(id, "approved", nowS());
    if (r.outcome === "stale") throw new Error("that proposal was already handled (or never existed)");
    if (r.outcome === "expired") throw new Error("that proposal expired (24h) — propose it again");
    const v = validateArgv(r.action.argv);
    if (!v.ok) throw new Error(`stored command failed the gate — ${v.reason}`);
    const res = await execArgv(r.action.argv);
    if (res.code !== 0) throw new Error(`the approved command failed: ${res.out.split("\n")[0]}`);
    console.log(`approved ${id} — ${res.out.split("\n")[0]}`);
  } else if (cmd === "cancel") {
    const id = rest[0];
    if (!id) throw new Error("usage: confirm.ts cancel <id>");
    const r = consumeAction(id, "cancelled", nowS());
    if (r.outcome === "stale") throw new Error("that proposal was already handled (or never existed)");
    if (r.outcome === "expired") console.log(`cancelled ${id} (it had already expired)`);
    else console.log(`cancelled ${id}`);
  } else if (cmd === "list") {
    const open = listPending(envChat());
    if (!open.length) console.log("(no open proposals)");
    else for (const a of open) console.log(`[${a.id}] ${a.summary}`);
  } else {
    throw new Error("usage: confirm.ts <propose|approve|cancel|list> ...");
  }
} catch (e: any) {
  console.error(`confirm error: ${e?.message ?? e}`);
  process.exit(1);
}
