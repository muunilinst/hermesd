# plugin-host notes

Where the guide or the upstream record is unclear, this package takes the safest reading. Each choice is below.

## What is real and what is a stand-in

- The Python RPC client is a stub. Methods `plugin.load`, `plugin.call_hook` and `plugin.call_tool` are our own names. The gateway host must serve them. The tests use a fake gateway.
- The round trip printed by the test is a placeholder for a fake in the same process. It says nothing about TeenyTiny or Cloudflare. That number must be measured on the real platforms.
- `fixtures/python-side-pre_tool_call.json` is hand-written, not a recording from a real Python plugin. Replace it with a real recording when the gateway host exists.
- `contracts/upstream/manifests.json` holds parsed records, not the YAML text. The manifest test renders YAML from each of the 106 records, in two list styles, and parses it back. It proves the parser on the keys and shapes that were recorded, not on the original text. Re-run it against the real files when the upstream tree is at hand.

## Ambiguities

1. **pre_tool_call result.** Read from `hermes_cli/plugins.py` (`_get_pre_tool_call_directive_details`) and `hermes_cli/plugins_dispatch.py` (`_run_hook_callbacks`) at the pin. A callback returns `{action: "block", message}` to block. The message must be a non-empty string, because it becomes the tool result. A block with no message is ignored. The first block, in plugin-directory order, wins. `pre_tool_call` fails closed: a callback that throws gives a block with the text `pre_tool_call plugin callback <name> raised <ErrorName>: <message cut to 200>`, and a callback that runs past the budget gives a block with the text `pre_tool_call plugin callback timed out or is still running`. All other hooks fail open. Changed by the golden-transcript work (before, a crash did not block). Not ported: `approve` (upstream sends it to the human approval gate; here it is treated as no decision), `modify` (rewrites the arguments), the 60 s suppression of a callback after a timeout, and the cap of 3 abandoned workers.
2. **pre_llm_call join.** A callback may return a string or `{context: string}`. Other values are dropped. Parts are joined with a blank line (`\n\n`). The guide gives the order (alphabetical by plugin directory) but not the separator. The separator is a guess. Check it against upstream.
3. **Order inside one directory.** Callbacks of one plugin keep their registration order. Sort is by directory name in code-unit order. This is the same as Python for ASCII names.
4. **Time budget.** A timeout counts as a crash: logged, aborted through an `AbortSignal`, skipped (for `pre_tool_call`: skipped and turned into a block, see item 1). A synchronous infinite loop in the same thread cannot be stopped by a timer (guide, section 3.5). The budget is API discipline, not isolation. Third-party JS is therefore refused in the actor (`PlacementError`), as section 6.6 says.
5. **Third-party plugins.** Only a `first-party` JS plugin runs in the actor. A third-party JS plugin is refused here, because the sandbox form is not built. A Python plugin goes to the gateway sidecar for either trust level. This package does not decide whether that sidecar is a shared host or a per-plugin sandbox. That is the host adapter's job (section 3.5).
6. **Undeclared hooks and tools.** `ctx.registerHook` and `ctx.registerTool` fail when the manifest does not list the name in `provides_hooks` or `provides_tools`. Upstream may not check this. The check is added because the guide says capabilities fail closed. If a plugin fails in `register`, all its registrations are removed.
7. **Hook names.** Registration and dispatch both fail for a name that is not in `contracts/known-hooks.json` (46 names, not the 38 the guide says). A name that is new upstream fails until someone reviews it, as the contracts test requires.
8. **Keyword arguments.** Each callback gets a shallow copy of the same object. Nothing is checked, removed or added. For JS, kwargs arrive as one object; for Python, as `**kwargs` on the other side of the RPC.
9. **Version.** `version` is always a string. A YAML number such as `1.5` becomes `"1.5"`. Trailing zeros in a bare number are lost by YAML itself; quote such versions.
10. **Classification.** The manifest key `runtime:` wins. Without it the upstream survey rule is used: any `.py` file means python; else JS files or a `package.json` means js; else portable. A directory with both `.py` and `.js` is python.
11. **Pure and effectful.** The manifest keys `pure_tools` and `pure_hooks` (our extension) mark a site pure. Every other site is effectful, and an unknown site is `python` plus effectful. A bad `effect` value in stored flag data reads back as effectful. Hook sites are named `<plugin>:<hook>` so each ported plugin moves on its own.
12. **Live shadow on a pure site** gives the TS side an Effects object that throws. A site marked pure that tries an effect shows up as a diff, and Python still answers.
13. **Replay shadow** needs the Python side to report its outbound calls (`calls` in the RPC reply). If the gateway host does not report them, the record has no calls and the comparison is weak. The gateway host must add that. This is not built here.
14. **A site with no TS port** stays on Python even if its flag says shadow or ts. That is safe: Python still works.
15. **State size** is the UTF-8 length of the JSON text of the whole map. Upstream measures in its own way; this is a close and strict stand-in.
16. **Middleware** (the guide's "call next once" rule) is not built. The pre_tool_call kwargs list has `middleware_trace`; the middleware chain is outside this task.
17. **Sandbox for 'js' third party, requires_auth, and the isolation tests** of section 9.2.5 are not built. They need the platform adapters.

## What should change outside this package

- Root `README.md` and `STATUS.md`: add the plugin host line. Do not mark the real Python round trip as measured.
- Root `package.json` needs no change; the workspace glob already includes `packages/*`.
