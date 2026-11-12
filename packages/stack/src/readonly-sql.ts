/**
 * The read-only rule of `Stack.rows()`, shared by every host. It accepts one statement that
 * begins with SELECT, or with WITH when no write keyword appears outside string literals,
 * identifiers and comments. One trailing semicolon is dropped; any other semicolon outside
 * a literal is refused. It uses no Node API: workerd runs it as it is.
 */
export function assertReadOnlySql(sql: string): string {
  // Blank out literals, quoted identifiers and comments, keeping the rest for the checks.
  let bare = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("rows: unterminated literal");
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) j += 2;
          else break;
        } else j += 1;
      }
      bare += " ";
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i);
      bare += " ";
      i = j < 0 ? sql.length : j + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      bare += " ";
      i = j < 0 ? sql.length : j + 2;
    } else {
      bare += c;
      i += 1;
    }
  }
  const trimmed = bare.trimEnd().replace(/;$/, "");
  if (trimmed.includes(";")) throw new Error("rows: one statement only");
  const head = /^\s*(\w+)/.exec(trimmed)?.[1]?.toLowerCase();
  if (head !== "select" && head !== "with") throw new Error("rows: read-only queries only (SELECT or WITH ... SELECT)");
  if (/\b(insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex)\b/i.test(trimmed)) {
    throw new Error("rows: read-only queries only (no write keyword)");
  }
  // The text that goes to the database: the original with its one trailing semicolon removed.
  return sql.replace(/;\s*$/, "");
}
