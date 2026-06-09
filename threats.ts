/**
 * threats.ts — threat-pattern scan for memory (and later skill) content.
 *
 * Ported from hermes-agent tools/threat_patterns.py (MIT, NousResearch) —
 * patterns reimplemented for JS regex; hermes-specific paths replaced with
 * this bot's sensitive paths. Scope semantics preserved:
 *   "all" subset of "context" subset of "strict"; memory writes + loads scan at "strict".
 * Patterns anchor on attack vocabulary, not bossy English, and use
 * (?:\w+\s+)* between key tokens so filler words cannot bypass them.
 */

export type ThreatScope = "all" | "context" | "strict";

type Pattern = [RegExp, string, ThreatScope];

const PATTERNS: Pattern[] = [
  // Classic prompt injection (everywhere)
  [/ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+(?:\w+\s+)*instructions/i, "prompt_injection", "all"],
  [/system\s+prompt\s+override/i, "sys_prompt_override", "all"],
  [/disregard\s+(?:\w+\s+)*(?:your|all|any)\s+(?:\w+\s+)*(?:instructions|rules|guidelines)/i, "disregard_rules", "all"],
  [/act\s+as\s+(?:if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(?:have\s+no|don't\s+have)\s+(?:\w+\s+)*(?:restrictions|limits|rules)/i, "bypass_restrictions", "all"],
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, "html_comment_injection", "all"],
  [/<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, "hidden_div", "all"],
  [/translate\s+.*\s+into\s+.*\s+and\s+(?:execute|run|eval)/i, "translate_execute", "all"],
  [/do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i, "deception_hide", "all"],

  // Role-play / identity hijack (context + strict)
  [/you\s+are\s+(?:\w+\s+)*now\s+(?:a|an|the)\s+/i, "role_hijack", "context"],
  [/pretend\s+(?:\w+\s+)*(?:you\s+are|to\s+be)\s+/i, "role_pretend", "context"],
  [/output\s+(?:\w+\s+)*(?:system|initial)\s+prompt/i, "leak_system_prompt", "context"],
  [/(?:respond|answer|reply)\s+without\s+(?:\w+\s+)*(?:restrictions|limitations|filters|safety)/i, "remove_filters", "context"],
  [/you\s+have\s+been\s+(?:\w+\s+)*(?:updated|upgraded|patched)\s+to/i, "fake_update", "context"],
  [/\bname\s+yourself\s+\w+/i, "identity_override", "context"],

  // C2 / promptware (context)
  [/register\s+(?:as\s+)?a?\s*node/i, "c2_node_registration", "context"],
  [/(?:heartbeat|beacon|check[\s-]?in)\s+(?:to|with)\s+/i, "c2_heartbeat", "context"],
  [/pull\s+(?:down\s+)?(?:new\s+)?task(?:ing|s)?\b/i, "c2_task_pull", "context"],
  [/connect\s+to\s+the\s+network\b/i, "c2_network_connect", "context"],
  [/you\s+must\s+(?:\w+\s+){0,3}(?:register|connect|report|beacon)\b/i, "forced_action", "context"],
  [/only\s+use\s+one[\s-]?liners?\b/i, "anti_forensic_oneliner", "context"],
  [/never\s+(?:\w+\s+)*(?:create|write)\s+(?:\w+\s+)*(?:script|file)\s+(?:\w+\s+)*disk/i, "anti_forensic_disk", "context"],
  [/unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*/i, "env_var_unset_agent", "context"],

  // Known C2 / red-team framework names (context)
  [/\b(?:praxis|cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b/i, "known_c2_framework", "context"],
  [/\bc2\s+(?:server|channel|infrastructure|beacon)\b/i, "c2_explicit", "context"],
  [/\bcommand\s+and\s+control\b/i, "c2_explicit_long", "context"],

  // Exfiltration (curl/wget everywhere; URL-send + context dumps strict)
  [/curl\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl", "all"],
  [/wget\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget", "all"],
  [/cat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets", "all"],
  [/(?:send|post|upload|transmit)\s+.*\s+(?:to|at)\s+https?:\/\//i, "send_to_url", "strict"],
  [/(?:include|output|print|share)\s+(?:\w+\s+)*(?:conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)/i, "context_exfil", "strict"],

  // Persistence / sensitive paths (strict) — adapted to this bot
  [/authorized_keys/i, "ssh_backdoor", "strict"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access", "strict"],
  [/channels\/telegram\/\.env/i, "bot_env_access", "strict"],
  [/access\.json/i, "bot_access_mod", "strict"],
  [/(?:update|modify|edit|write|change|append|add\s+to)\s+.*(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)/i, "agent_config_mod", "strict"],

  // Hardcoded secrets (strict)
  [/(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+\/=_-]{20,}/i, "hardcoded_secret", "strict"],
];

/**
 * Invisible / bidi unicode used in injection attacks (hermes INVISIBLE_CHARS).
 * Deliberately EXCLUDES U+200E (LRM) and U+200F (RLM) — Telegram inserts RLM
 * in normal Hebrew messages; flagging it would block every Hebrew fact.
 * Entries are built via String.fromCharCode so no literal invisible chars
 * appear in this source file.
 */
const INVISIBLE_CHARS = new Set([
  String.fromCharCode(0x200B), // zero-width space
  String.fromCharCode(0x200C), // zero-width non-joiner
  String.fromCharCode(0x200D), // zero-width joiner
  String.fromCharCode(0x2060), // word joiner
  String.fromCharCode(0x2062), // invisible times
  String.fromCharCode(0x2063), // invisible separator
  String.fromCharCode(0x2064), // invisible plus
  String.fromCharCode(0xFEFF), // zero-width no-break space (BOM)
  String.fromCharCode(0x202A), // left-to-right embedding
  String.fromCharCode(0x202B), // right-to-left embedding
  String.fromCharCode(0x202C), // pop directional formatting
  String.fromCharCode(0x202D), // left-to-right override
  String.fromCharCode(0x202E), // right-to-left override
  String.fromCharCode(0x2066), // left-to-right isolate
  String.fromCharCode(0x2067), // right-to-left isolate
  String.fromCharCode(0x2068), // first strong isolate
  String.fromCharCode(0x2069), // pop directional isolate
]);

const SCOPE_INCLUDES: Record<ThreatScope, Set<ThreatScope>> = {
  all: new Set(["all"]),
  context: new Set(["all", "context"]),
  strict: new Set(["all", "context", "strict"]),
};

/** All matched pattern ids in `content` at `scope`. Empty array = clean. */
export function scanThreats(content: string, scope: ThreatScope = "strict"): string[] {
  if (!content) return [];
  const findings: string[] = [];
  for (const ch of new Set(content)) {
    if (INVISIBLE_CHARS.has(ch)) {
      findings.push(
        `invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      );
    }
  }
  const include = SCOPE_INCLUDES[scope];
  for (const [re, id, patScope] of PATTERNS) {
    if (include.has(patScope) && re.test(content)) findings.push(id);
  }
  return findings;
}
