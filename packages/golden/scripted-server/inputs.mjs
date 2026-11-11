#!/usr/bin/env bun
// Print the user inputs of a golden script, one JSON object per line:
//   {"send": "<the text>", "interrupt": "model_call"}     (interrupt only when the script has it)
//
//   node inputs.mjs <script.json>
//
// A driver sends each text to Hermes in order. Plain Node, no dependencies.
import { expandText, loadScript } from "./common.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node inputs.mjs <script.json>");
  process.exit(2);
}
for (const input of loadScript(file).inputs) {
  console.log(JSON.stringify({ send: expandText(input.send), ...(input.interrupt ? { interrupt: input.interrupt } : {}) }));
}
