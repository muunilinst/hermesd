/**
 * The injection scan for context files.
 *
 * Port of upstream `tools/threat_patterns.py` (`scan_for_threats`, scope
 * "context"). The scope "context" holds the patterns of scope "all" and
 * "context". The patterns of scope "strict" are for memory and skill writes,
 * which the port does not have yet, so they are left out.
 */

// Hard cap on scanned text (upstream MAX_SCAN_CHARS).
const MAX_SCAN_CHARS = 65_536;
// Bounded filler between key attack words (upstream _FILLER).
const FILLER = String.raw`(?:\w+\s+){0,8}`;
// Env var reference that ends in a secret-like suffix (upstream _SECRET_VAR).
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;

/** Pattern, pattern id. In the order of upstream `_PATTERNS`, scopes "all" then "context" kept in source order. */
const PATTERNS: Array<[string, string]> = [
  // Scope "all"
  [String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "prompt_injection"],
  [String.raw`system\s+prompt\s+override`, "sys_prompt_override"],
  [String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "disregard_rules"],
  [String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`, "bypass_restrictions"],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection"],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div"],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`, "translate_execute"],
  [String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "deception_hide"],
  // Scope "context"
  [String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "role_hijack"],
  [String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "role_pretend"],
  [String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "leak_system_prompt"],
  [String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`, "remove_filters"],
  [String.raw`you\s+have\s+been\s+${FILLER}(updated|upgraded|patched)\s+to`, "fake_update"],
  [String.raw`\bname\s+yourself\s+\w+`, "identity_override"],
  [String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration"],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, "c2_heartbeat"],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull"],
  [String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect"],
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action"],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner"],
  [String.raw`never\s+${FILLER}(?:create|write)\s+${FILLER}(?:script|file)\s+${FILLER}disk`, "anti_forensic_disk"],
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*`, "env_var_unset_agent"],
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework"],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit"],
  [String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long"],
  // Scope "all" again (exfiltration)
  [String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_curl"],
  [String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "exfil_wget"],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets"],
];

const COMPILED = PATTERNS.map(([p, id]): [RegExp, string] => [new RegExp(p, "i"), id]);

/** Invisible and bidirectional unicode used in injection attacks (upstream INVISIBLE_CHARS). */
const INVISIBLE = new Set([
  ..."​‌‍⁠⁢⁣⁤﻿‪‫‬‭‮⁦⁧⁨⁩",
]);

/**
 * The ids of the patterns that match `content`. Invisible code points are
 * reported as `invisible_unicode_U+XXXX`, sorted (upstream reports them in
 * set order, which is not stable).
 */
export function scanForThreats(content: string): string[] {
  if (!content) return [];
  const text = content.slice(0, MAX_SCAN_CHARS);
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) if (INVISIBLE.has(ch)) seen.add(ch);
  for (const ch of [...seen].sort()) findings.push(`invisible_unicode_U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
  // NFKC folds full-width variants against bypass (upstream does the same).
  const normalised = text.normalize("NFKC");
  for (const [re, id] of COMPILED) if (re.test(normalised)) findings.push(id);
  return findings;
}
