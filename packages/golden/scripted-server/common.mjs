// Shared helpers of the scripts in this folder. Plain Node, no dependencies.
import { readFileSync } from "node:fs";

/** Read a golden script (packages/golden/scripts/<name>.json). */
export function loadScript(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The text of a user input. A string stays as it is. `{prefix, lorem: n}` is the prefix and then
 * filler text, n characters in all. The same function is in packages/golden/src/script.ts.
 */
export function expandText(t) {
  if (typeof t === "string") return t;
  const body = "lorem ipsum dolor ".repeat(Math.ceil(t.lorem / 18)).slice(0, t.lorem);
  return (t.prefix ?? "") + body;
}

/** The user inputs of a script, as plain strings. */
export function inputTexts(script) {
  return script.inputs.map((i) => expandText(i.send));
}

/** Read the value of `--name value` from argv, or the default. */
export function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}
