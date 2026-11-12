#!/usr/bin/env bun
// Write the Python plugins of a golden script, so upstream Hermes runs the same hooks as the port.
//
//   node make-plugins.mjs <script.json> <plugins-dir>
//
// <plugins-dir> is usually ~/.hermes/plugins. For each plugin of the script it writes
// <plugins-dir>/<dir>/plugin.yaml and <plugins-dir>/<dir>/__init__.py. It then prints the
// config lines to add to ~/.hermes/config.yaml. A script with no hooks writes nothing.
// Plain Node, no dependencies.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadScript } from "./common.mjs";

const [file, root] = process.argv.slice(2);
if (!file || !root) {
  console.error("usage: node make-plugins.mjs <script.json> <plugins-dir>");
  process.exit(2);
}
const script = loadScript(file);
const plugins = script.hooks?.plugins ?? [];
// Only exception classes that exist in Python without an import.
const EXCEPTIONS = new Set(["RuntimeError", "ValueError", "TypeError", "KeyError", "OSError"]);

function py(s) {
  return JSON.stringify(s); // a JSON string is a valid Python string literal for the text used here
}

function pythonFor(p) {
  const b = p.behavior;
  let body;
  if (b.kind === "block") body = `    return {"action": "block", "message": ${py(b.message)}}`;
  else if (b.kind === "throw") {
    if (!EXCEPTIONS.has(b.error)) throw new Error(`plugin ${p.name}: exception ${b.error} is not one of ${[...EXCEPTIONS].join(", ")}`);
    body = `    raise ${b.error}(${py(b.message)})`;
  } else if (b.kind === "hang") body = "    import time\n    time.sleep(3600)";
  else body = "    return None";
  return `def ${p.callback}(**kwargs):\n${body}\n\n\ndef register(ctx):\n    ctx.register_hook(${py(p.hook)}, ${p.callback})\n`;
}

for (const p of plugins) {
  const dir = join(root, p.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), `name: ${p.name}\nversion: 1.0.0\ndescription: "Golden transcript hook (${script.name})"\nprovides_hooks:\n  - ${p.hook}\n`);
  writeFileSync(join(dir, "__init__.py"), pythonFor(p));
  console.log(`wrote ${dir}`);
}
if (plugins.length > 0) {
  const timeoutS = (script.hooks.timeoutMs ?? 30000) / 1000;
  console.log("\nAdd to ~/.hermes/config.yaml:\n\nplugins:");
  console.log(`  enabled: [${plugins.map((p) => p.name).join(", ")}]`);
  console.log(`  hook_callback_timeout: ${timeoutS}`);
}
