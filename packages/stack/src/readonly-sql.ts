/**
 * The read-only rule of `Stack.rows()`, shared by every host. It accepts one statement that
 * begins with SELECT (or VALUES), or with WITH when the statement after its CTEs is a SELECT.
 * Literals, quoted identifiers and comments are blanked first, so words inside them count for
 * nothing, and write words inside a SELECT (`replace(...)`, `update_time`) are ordinary names.
 * One trailing semicolon is dropped; any other semicolon outside a literal is refused.
 * It does not need the database to classify the statement and uses no Node API: workerd
 * runs it as it is. (SQLite's `sqlite3_stmt_readonly` is not reachable from the Durable Object
 * SQL API, and `PRAGMA query_only` is not permitted there.)
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
  // The statement's own verb. A SELECT cannot hold a data-changing statement, so after the head nothing in its
  // text is a write: `replace(...)`, a column called `update_time` and `pragma_table_info(...)` are ordinary
  // names. Only WITH needs a look at what follows its CTEs.
  const words = [...trimmed.matchAll(/[A-Za-z_]\w*|[()]/g)].map((m) => m[0]);
  const head = words[0]?.toLowerCase();
  if (head === "select" || head === "values") return sql.replace(/;\s*$/, "");
  if (head !== "with") throw new Error("rows: read-only queries only (SELECT or WITH ... SELECT)");
  // WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] (...) [, ...] <statement>: the statement is the first
  // verb outside every parenthesis. Names, AS and MATERIALIZED are none of the verbs.
  let depth = 0;
  for (const w of words.slice(1)) {
    if (w === "(") depth += 1;
    else if (w === ")") depth -= 1;
    else if (depth === 0) {
      const v = w.toLowerCase();
      if (v === "select" || v === "values") return sql.replace(/;\s*$/, "");
      if (v === "insert" || v === "update" || v === "delete" || v === "replace") {
        throw new Error("rows: read-only queries only (WITH ... SELECT, not WITH ... " + v.toUpperCase() + ")");
      }
    }
  }
  throw new Error("rows: read-only queries only (WITH without a SELECT)");
}
