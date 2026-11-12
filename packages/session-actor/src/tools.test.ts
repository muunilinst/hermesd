import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSurface, type ToolSchemasSurface } from "@hermesd/contracts";
import type { CommandResult } from "@hermesd/executor-protocol";
import { answerResult, parseClarify, renderQuestions } from "./tools/clarify.ts";
import { TERMINAL_SCHEMA } from "./tools/provisional-schemas.ts";
import { SUPPORTED_TOOLS, loadToolDefs, toolDefinitions } from "./tools/schemas.ts";
import { canonicalJson, inputHash, parseTerminal, shellCommand, terminalResult } from "./tools/terminal.ts";
import { applyTodo, type TodoItem } from "./tools/todo.ts";

describe("tool schemas are data", () => {
  const surface = loadSurface<ToolSchemasSurface>("tool-schemas");

  it("emits the literal upstream schema for clarify and todo, unchanged", () => {
    const defs = loadToolDefs();
    for (const name of ["clarify", "todo_list", "session_search"] as const) {
      const upstream = surface.tools.find((t) => t.name === name)!.schema;
      assert.deepEqual(defs[name].schema, upstream, name);
      assert.equal(defs[name].provisional, false);
    }
  });

  it("marks the schemas that are not literal as provisional, and only those", () => {
    const defs = loadToolDefs();
    assert.deepEqual(
      Object.values(defs).filter((d) => d.provisional).map((d) => d.name),
      ["terminal"],
    );
    assert.equal(TERMINAL_SCHEMA.provisional, true);
    assert.match(TERMINAL_SCHEMA.source, /tools\/terminal_tool\.py/);
    // The extractor lists terminal as non-literal: that is why it is provisional.
    assert.equal(surface.non_literal.some((n) => n.name === "terminal"), true);
    assert.equal(surface.tools.some((t) => t.name === "terminal"), false);
  });

  it("keeps session_search off by default: the default requests do not change", () => {
    assert.equal((SUPPORTED_TOOLS as readonly string[]).includes("session_search"), false);
    assert.equal(toolDefinitions().some((t) => t.function.name === "session_search"), false);
    assert.equal(toolDefinitions([...SUPPORTED_TOOLS, "session_search"]).some((t) => t.function.name === "session_search"), true);
  });

  it("gives the model OpenAI function definitions for the supported tools only", () => {
    const tools = toolDefinitions();
    assert.deepEqual(tools.map((t) => t.function.name).sort(), [...SUPPORTED_TOOLS].sort());
    assert.equal(tools.every((t) => t.type === "function"), true);
  });
});

describe("todo", () => {
  const item = (id: string, status: TodoItem["status"] = "pending"): TodoItem => ({ id, content: `do ${id}`, status });

  it("reads the list when called without todos", () => {
    const out = applyTodo([item("1")], {});
    assert.equal(out.changed, false);
    assert.equal((JSON.parse(out.result) as { summary: { total: number } }).summary.total, 1);
  });

  it("replaces the list, or merges by id", () => {
    const replaced = applyTodo([item("1")], { todos: [item("2")] });
    assert.deepEqual(replaced.items.map((i) => i.id), ["2"]);
    const merged = applyTodo([item("1"), item("2")], { todos: [item("2", "completed"), item("3")], merge: true });
    assert.deepEqual(merged.items.map((i) => `${i.id}:${i.status}`), ["1:pending", "2:completed", "3:pending"]);
  });

  it("refuses a bad item and changes nothing", () => {
    const out = applyTodo([item("1")], { todos: [{ id: "x", content: "c", status: "doing" }] });
    assert.equal(out.changed, false);
    assert.match(out.result, /status must be one of/);
  });
});

describe("clarify", () => {
  it("accepts 1 to 5 questions with at most 4 choices", () => {
    assert.deepEqual(parseClarify({ questions: [{ question: "A?", choices: ["x", "y"] }] }), [{ question: "A?", choices: ["x", "y"] }]);
    assert.equal(typeof parseClarify({ questions: [] }), "string");
    assert.equal(typeof parseClarify({ questions: [{ question: "A?", choices: ["1", "2", "3", "4", "5"] }] }), "string");
    assert.equal(typeof parseClarify({}), "string");
  });

  it("renders the question and numbers the choices", () => {
    assert.equal(renderQuestions([{ question: "Colour?", choices: ["red", "blue"] }]), "Colour?\n  1) red\n  2) blue");
  });

  it("turns the answer into the tool result", () => {
    const one = JSON.parse(answerResult([{ question: "Colour?" }], "blue")) as { outcome: string; responses: Array<{ status: string; user_response: string }> };
    assert.equal(one.outcome, "submitted");
    assert.deepEqual(one.responses, [{ question: "Colour?", status: "answered", user_response: "blue" }]);
    const two = JSON.parse(answerResult([{ question: "A?" }, { question: "B?" }], "yes\nno")) as { responses: Array<{ user_response: string }> };
    assert.deepEqual(two.responses.map((r) => r.user_response), ["yes", "no"]);
    const loose = JSON.parse(answerResult([{ question: "A?" }, { question: "B?" }], "just one")) as { responses: Array<{ status: string }> };
    assert.deepEqual(loose.responses.map((r) => r.status), ["answered", "unanswered"]);
  });
});

describe("terminal", () => {
  it("needs a command", () => {
    assert.equal(typeof parseTerminal({}), "string");
    assert.deepEqual(parseTerminal({ command: "ls", workdir: "/w" }), { command: "ls", workdir: "/w" });
  });

  it("runs the string in a shell by default", () => {
    assert.deepEqual(shellCommand({ command: "ls -l", workdir: "/w" }), { argv: ["bash", "-lc", "ls -l"], cwd: "/w" });
  });

  it("hashes the input in a stable way, whatever the key order", async () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
    assert.equal(await inputHash({ argv: ["a"], cwd: "/x" }), await inputHash({ cwd: "/x", argv: ["a"] }));
    assert.notEqual(await inputHash({ argv: ["a"] }), await inputHash({ argv: ["b"] }));
  });

  it("returns upstream's result shape", () => {
    const r: CommandResult = { exitCode: 3, stdout: "out", stderr: "err" };
    assert.deepEqual(JSON.parse(terminalResult(r, true)), { output: "out\nerr", exit_code: 3, error: null });
  });
});
