/**
 * A small YAML subset parser for plugin.yaml files. No dependencies.
 *
 * It handles block mappings, block lists (of scalars or of mappings), nested
 * blocks, flow lists and flow maps, quoted and plain scalars, `>` and `|` block
 * scalars, and comments. Anything else throws `YamlError`. It is not a full
 * YAML parser: no anchors, no tags, no multi-line plain scalars.
 */

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`yaml line ${line + 1}: ${message}`);
    this.line = line;
    this.name = "YamlError";
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/** Remove a `# comment` that starts after white space and is outside quotes. */
function stripComment(s: string): string {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1]!)) quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]!))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function scalar(text: string, line: number): YamlValue {
  const t = text.trim();
  if (t === "" || t === "~" || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE|yes)$/.test(t)) return true;
  if (/^(false|False|FALSE|no)$/.test(t)) return false;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw new YamlError("unterminated flow list", line);
    return splitFlow(t.slice(1, -1)).map((p) => scalar(p, line));
  }
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw new YamlError("unterminated flow map", line);
    const out: { [key: string]: YamlValue } = {};
    for (const p of splitFlow(t.slice(1, -1))) {
      const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:\s*(.*)$/.exec(p);
      if (!m) throw new YamlError(`bad flow map entry: ${p}`, line);
      out[keyText(m[1]!, line)] = scalar(m[2]!, line);
    }
    return out;
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

/** A key is text. `yes` and `null` as keys stay text; only quotes are removed. */
function keyText(k: string, line: number): string {
  return /^["']/.test(k) ? String(scalar(k, line)) : k;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:#'"[{-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

export function parseYaml(text: string): YamlValue {
  const raw = text.replaceAll("\r\n", "\n").replaceAll("\t", "  ").split("\n");
  let pos = 0;

  const indentOf = (s: string) => s.length - s.trimStart().length;
  const isSkippable = (s: string) => {
    const t = s.trim();
    return t === "" || t.startsWith("#") || t === "---" || t === "...";
  };
  const isSeqLine = (t: string) => t === "-" || t.startsWith("- ");
  const skip = () => {
    while (pos < raw.length && isSkippable(raw[pos]!)) pos++;
  };

  function blockScalar(parentIndent: number, header: string): string {
    const style = header[0]!;
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const collected: string[] = [];
    let base = -1;
    while (pos < raw.length) {
      const l = raw[pos]!;
      if (l.trim() === "") {
        collected.push("");
        pos++;
        continue;
      }
      const ind = indentOf(l);
      if (ind <= parentIndent) break;
      if (base < 0) base = ind;
      collected.push(l.slice(Math.min(base, ind)));
      pos++;
    }
    if (chomp !== "keep") {
      while (collected.length && collected[collected.length - 1] === "") collected.pop();
    }
    let body: string;
    if (style === "|") {
      body = collected.join("\n");
    } else {
      // Folded: single newlines become spaces, blank lines become newlines.
      let out = "";
      for (const l of collected) {
        if (l === "") out += "\n";
        else out += (out !== "" && !out.endsWith("\n") ? " " : "") + l;
      }
      body = out;
    }
    return chomp === "strip" ? body : body + "\n";
  }

  /** Read a value that follows `key:` or `- ` on the same line. */
  function inlineValue(rest: string, parentIndent: number, lineNo: number): YamlValue {
    const r = stripComment(rest.trim());
    if (/^[>|][+-]?\d?$/.test(r)) return blockScalar(parentIndent, r);
    if ((r.startsWith("[") && !r.endsWith("]")) || (r.startsWith("{") && !r.endsWith("}"))) {
      // A flow value over several lines: join until the brackets close.
      let joined = r;
      while (pos < raw.length && !/[\]}]$/.test(joined)) joined += " " + stripComment(raw[pos++]!.trim());
      return scalar(joined, lineNo);
    }
    return scalar(r, lineNo);
  }

  function block(): YamlValue {
    skip();
    const l = raw[pos]!;
    return isSeqLine(l.trim()) ? sequence(indentOf(l)) : mapping(indentOf(l));
  }

  function sequence(indent: number): YamlValue {
    const out: YamlValue[] = [];
    for (;;) {
      skip();
      if (pos >= raw.length) break;
      const l = raw[pos]!;
      const t = l.trim();
      if (indentOf(l) !== indent || !isSeqLine(t)) break;
      const lineNo = pos;
      const rest = t === "-" ? "" : t.slice(2);
      const offset = indent + (t.length - rest.trimStart().length);
      pos++;
      const r = stripComment(rest.trim());
      if (r === "") {
        skip();
        out.push(pos < raw.length && indentOf(raw[pos]!) > indent ? block() : null);
      } else if (KEY.test(r) && !r.startsWith("[") && !r.startsWith("{")) {
        // A mapping item: the text after "- " is the first line of a mapping.
        pos = lineNo;
        raw[pos] = " ".repeat(offset) + rest.trimStart();
        out.push(mapping(offset));
      } else {
        out.push(inlineValue(r, indent, lineNo));
      }
    }
    return out;
  }

  function mapping(indent: number): YamlValue {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      skip();
      if (pos >= raw.length) break;
      const l = raw[pos]!;
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new YamlError("unexpected indent", pos);
      const t = stripComment(l.trim());
      if (isSeqLine(t)) break;
      const m = KEY.exec(t);
      if (!m) throw new YamlError(`cannot read line: ${t}`, pos);
      const key = keyText(m[1]!, pos);
      const lineNo = pos;
      const rest = m[2] ?? "";
      pos++;
      if (stripComment(rest.trim()) === "") {
        skip();
        const next = pos < raw.length ? raw[pos]! : "";
        if (pos < raw.length && indentOf(next) > indent) out[key] = block();
        else if (pos < raw.length && indentOf(next) === indent && isSeqLine(next.trim())) out[key] = sequence(indent);
        else out[key] = null;
      } else {
        out[key] = inlineValue(rest, indent, lineNo);
      }
    }
    return out;
  }

  skip();
  if (pos >= raw.length) return {};
  const first = stripComment(raw[pos]!.trim());
  if (!isSeqLine(first) && !KEY.test(first)) return scalar(first, pos);
  const value = block();
  skip();
  if (pos < raw.length) throw new YamlError("unexpected content after document", pos);
  return value;
}
