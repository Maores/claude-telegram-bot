/**
 * stream.ts — parses `claude -p --output-format stream-json --include-partial-messages`
 * NDJSON into a simple render state: a one-line status (thinking / using a tool) and
 * the answer text accumulated so far.
 *
 * Pure logic, no I/O — the poller feeds it lines and renders the state to Telegram.
 */

export interface RenderState {
  status: string | null; // e.g. "💭 thinking…" / "🔍 searching the web…", or null once text flows
  text: string; // answer text so far
  done: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  WebSearch: "🔍 searching the web…",
  WebFetch: "🌐 reading a page…",
  Bash: "⚙️ working…",
  Read: "📄 reading…",
  Write: "✍️ writing…",
  Edit: "✍️ editing…",
};

/** Map a tool name (built-in or MCP) to a friendly status line. */
export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const n = name.toLowerCase();
  if (n.includes("gmail") || n.includes("mail")) return "📧 checking email…";
  if (n.includes("drive")) return "📁 looking in Drive…";
  if (n.includes("calendar")) return "📅 checking the calendar…";
  if (n.includes("search")) return "🔍 searching…";
  return "🔧 working…";
}

export class StreamParser {
  status: string | null = "💭 thinking…";
  text = "";
  done = false;
  private result: string | null = null;

  /** Feed one NDJSON line. Malformed/unknown lines are ignored. */
  push(line: string): void {
    const s = line.trim();
    if (!s) return;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      return;
    }

    if (o.type === "result") {
      if (typeof o.result === "string") this.result = o.result;
      this.done = true;
      this.status = null;
      return;
    }
    if (o.type === "assistant") {
      for (const b of o.message?.content ?? []) {
        if (b?.type === "tool_use" && b.name) this.status = toolLabel(b.name);
      }
      return;
    }
    if (o.type === "stream_event") {
      const ev = o.event;
      if (!ev) return;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        this.status = toolLabel(ev.content_block.name ?? "");
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          this.text += d.text;
          this.status = null; // the answer is flowing — drop the status line
        } else if (d?.type === "thinking_delta" && !this.text) {
          this.status = "💭 thinking…";
        }
      }
    }
  }

  /** Best final answer: the streamed text, falling back to the result event's text. */
  finalText(): string {
    const t = this.text.trim();
    return t || (this.result ?? "").trim();
  }

  state(): RenderState {
    return { status: this.status, text: this.text, done: this.done };
  }
}

/** What a Telegram message should show for the given state. */
export function displayText(s: RenderState): string {
  if (s.text) return s.text;
  return s.status ?? "…";
}
