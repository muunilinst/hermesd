import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyPlugin, ManifestError, parseManifest } from "./manifest.ts";
import { parseYaml, YamlError } from "./yaml.ts";

interface Record106 {
  class: "python" | "js" | "portable";
  keys: string[];
  kind?: string;
  name: string;
  path: string;
  provides_hooks: string[];
  provides_tools: string[];
  python_files: number;
  js_files: number;
  other_files: number;
  version: string;
}

const recorded = JSON.parse(
  readFileSync(new URL("../../../contracts/upstream/manifests.json", import.meta.url), "utf8"),
) as { manifests: Record106[] };

test("yaml: block mapping, lists, nested maps, comments", () => {
  const doc = parseYaml(`
# top comment
name: demo   # trailing comment
version: "1.0.0"
tags:
  - a
  - 'b c'
nested:
  key: value
  deep:
    n: 3
    f: 1.5
    yes: true
list_of_maps:
  - name: x
    url: "http://a/b#c"
  - name: y
empty:
flow: [a, "b, c", 3]
fmap: {k: v, n: 1}
`);
  assert.deepEqual(doc, {
    name: "demo",
    version: "1.0.0",
    tags: ["a", "b c"],
    nested: { key: "value", deep: { n: 3, f: 1.5, yes: true } },
    list_of_maps: [
      { name: "x", url: "http://a/b#c" },
      { name: "y" },
    ],
    empty: null,
    flow: ["a", "b, c", 3],
    fmap: { k: "v", n: 1 },
  });
});

test("yaml: block scalars, same-indent lists, multi-line flow lists", () => {
  const doc = parseYaml(`description: >
  one
  two

  three
literal: |
  a
  b
strip: >-
  x
  y
items:
- p
- q
multi: [a,
  b, c]
after: ok
`) as Record<string, unknown>;
  assert.equal(doc["description"], "one two\nthree\n");
  assert.equal(doc["literal"], "a\nb\n");
  assert.equal(doc["strip"], "x y");
  assert.deepEqual(doc["items"], ["p", "q"]);
  assert.deepEqual(doc["multi"], ["a", "b", "c"]);
  assert.equal(doc["after"], "ok");
});

test("yaml: bad input throws YamlError", () => {
  assert.throws(() => parseYaml("a: [1, 2"), YamlError);
  assert.throws(() => parseYaml("a: 1\n  b: 2"), YamlError);
});

test("manifest: required fields, unknown keys kept", () => {
  const m = parseManifest(`name: my-plugin
version: 1.0.0
provides_tools: [lookup]
provides_hooks: [pre_tool_call]
capabilities: [network]
requires_auth: true
future_key:
  a: 1
`);
  assert.equal(m.name, "my-plugin");
  assert.equal(m.version, "1.0.0");
  assert.deepEqual(m.providesTools, ["lookup"]);
  assert.deepEqual(m.providesHooks, ["pre_tool_call"]);
  assert.deepEqual(m.capabilities, ["network"]);
  assert.deepEqual(m.extra, { requires_auth: true, future_key: { a: 1 } });
  assert.throws(() => parseManifest("version: 1"), ManifestError);
  assert.throws(() => parseManifest("name: x\nruntime: ruby"), ManifestError);
  assert.throws(() => parseManifest("name: x\nprovides_tools: [1]"), ManifestError);
  assert.equal(parseManifest("name: x\nversion: 1.5").version, "1.5");
});

test("classify: runtime key wins, else file rule", () => {
  const m = parseManifest("name: x");
  assert.equal(classifyPlugin(m, ["a.py", "b.js"]), "python");
  assert.equal(classifyPlugin(m, ["b.mjs"]), "js");
  assert.equal(classifyPlugin(m, ["package.json"]), "js");
  assert.equal(classifyPlugin(m, ["README.md", "skills/a/SKILL.md"]), "portable");
  assert.equal(classifyPlugin(parseManifest("name: x\nruntime: portable"), ["a.py"]), "portable");
});

function quote(s: string): string {
  return JSON.stringify(s);
}

/** Write a manifest for a recorded entry. Two list styles, so both are tested. */
function render(r: Record106, style: number): string {
  const lines = [`# ${r.path}`, `name: ${quote(r.name)}`, `version: ${quote(r.version)}`];
  for (const k of r.keys) {
    if (["name", "version", "provides_hooks", "provides_tools"].includes(k)) continue;
    lines.push(style === 0 ? `${k}: ${quote(`text: with colon # and hash for ${k}`)}` : `${k}:\n  - item1\n  - key: value`);
  }
  for (const [k, list] of [
    ["provides_hooks", r.provides_hooks],
    ["provides_tools", r.provides_tools],
  ] as const) {
    if (!r.keys.includes(k)) continue;
    if (style === 0) lines.push(`${k}: [${list.join(", ")}]`);
    else lines.push(list.length ? `${k}:\n${list.map((x) => `  - ${x}`).join("\n")}` : `${k}: []`);
  }
  return lines.join("\n") + "\n";
}

test("manifest: every recorded upstream manifest shape parses and classifies", () => {
  assert.equal(recorded.manifests.length, 106);
  recorded.manifests.forEach((r, i) => {
    const m = parseManifest(render(r, i % 2));
    assert.equal(m.name, r.name, r.path);
    assert.equal(m.version, r.version, r.path);
    assert.deepEqual(m.providesHooks, r.provides_hooks, r.path);
    assert.deepEqual(m.providesTools, r.provides_tools, r.path);
    const known = new Set(["name", "version", "description", "provides_hooks", "provides_tools"]);
    assert.deepEqual(Object.keys(m.extra).sort(), r.keys.filter((k) => !known.has(k)).sort(), r.path);
    const files = [
      ...Array.from({ length: r.python_files }, (_, n) => `f${n}.py`),
      ...Array.from({ length: r.js_files }, (_, n) => `f${n}.js`),
      ...Array.from({ length: r.other_files }, (_, n) => `o${n}.md`),
    ];
    assert.equal(classifyPlugin(m, files), r.class, r.path);
  });
});
