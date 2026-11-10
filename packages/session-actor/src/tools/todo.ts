/**
 * The todo tool. It is agent-internal: it reads and writes rows and has no
 * effect outside the actor. So it runs inside the transaction that persists
 * the tool-call turn, and its result is recorded in the same commit.
 */

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  parent?: string;
}

export interface TodoOutcome {
  /** The list after the call. */
  items: TodoItem[];
  /** True if the rows must be written. */
  changed: boolean;
  /** The tool result: a JSON string. */
  result: string;
}

function summarize(items: TodoItem[]): Record<string, number> {
  const out: Record<string, number> = { total: items.length };
  for (const s of TODO_STATUSES) out[s] = items.filter((i) => i.status === s).length;
  return out;
}

function render(items: TodoItem[]): string {
  return JSON.stringify({ todos: items, summary: summarize(items) });
}

function parseItem(raw: unknown): TodoItem | string {
  if (typeof raw !== "object" || raw === null) return "each todo must be an object";
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return "each todo needs a string id";
  if (typeof o.content !== "string") return `todo ${o.id}: content must be a string`;
  if (typeof o.status !== "string" || !(TODO_STATUSES as readonly string[]).includes(o.status)) {
    return `todo ${o.id}: status must be one of ${TODO_STATUSES.join(", ")}`;
  }
  const item: TodoItem = { id: o.id, content: o.content, status: o.status as TodoStatus };
  if (typeof o.parent === "string") item.parent = o.parent;
  return item;
}

/** Apply one call to the current list. Pure: the caller writes the rows. */
export function applyTodo(current: TodoItem[], args: unknown): TodoOutcome {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (a.todos === undefined) return { items: current, changed: false, result: render(current) };
  if (!Array.isArray(a.todos)) return { items: current, changed: false, result: JSON.stringify({ error: "todos must be an array" }) };
  const parsed: TodoItem[] = [];
  for (const raw of a.todos) {
    const item = parseItem(raw);
    if (typeof item === "string") return { items: current, changed: false, result: JSON.stringify({ error: item }) };
    parsed.push(item);
  }
  let items: TodoItem[];
  if (a.merge === true) {
    items = current.map((c) => parsed.find((p) => p.id === c.id) ?? c);
    for (const p of parsed) if (!items.some((i) => i.id === p.id)) items.push(p);
  } else {
    items = parsed;
  }
  return { items, changed: true, result: render(items) };
}
