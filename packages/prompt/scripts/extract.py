# Static extraction: parse upstream source with ast (no import, no execution)
# and write string constants as JSON.
import ast, json, sys
import os
UP = os.environ["HERMES_UPSTREAM"].rstrip("/") + "/"
OUT = sys.argv[1]


def ev(n, env):
    if isinstance(n, ast.Constant):
        return n.value
    if isinstance(n, ast.JoinedStr):
        out = ""
        for v in n.values:
            if isinstance(v, ast.Constant):
                out += v.value
            elif isinstance(v, ast.FormattedValue):
                out += str(ev(v.value, env))
            else:
                raise ValueError(ast.dump(v))
        return out
    if isinstance(n, ast.Name):
        return env[n.id]
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add):
        return ev(n.left, env) + ev(n.right, env)
    if isinstance(n, (ast.Tuple, ast.List)):
        return [ev(e, env) for e in n.elts]
    if isinstance(n, ast.Set):
        return sorted(ev(e, env) for e in n.elts)
    if isinstance(n, ast.Dict):
        return {ev(k, env): ev(v, env) for k, v in zip(n.keys, n.values)}
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "split":
        return ev(n.func.value, env).split(*[ev(a, env) for a in n.args])
    if isinstance(n, ast.Subscript):
        return ev(n.value, env)[ev(n.slice, env)]
    raise ValueError("unsupported " + ast.dump(n)[:120])


def collect(path, names):
    tree = ast.parse(open(UP + path, encoding="utf-8").read())
    env, got = {}, {}
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            t = node.targets[0] if isinstance(node, ast.Assign) else node.target
            if isinstance(t, ast.Name) and node.value is not None:
                try:
                    v = ev(node.value, env)
                except Exception:
                    continue
                env[t.id] = v
                if t.id in names:
                    got[t.id] = v
    missing = [n for n in names if n not in got]
    if missing:
        raise SystemExit(f"missing in {path}: {missing}")
    return got


pb = collect("agent/prompt_builder.py", [
    "DEFAULT_AGENT_IDENTITY", "HERMES_AGENT_HELP_GUIDANCE", "HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS",
    "SESSION_SEARCH_GUIDANCE", "SKILLS_GUIDANCE", "TOOL_USE_ENFORCEMENT_GUIDANCE", "TOOL_USE_ENFORCEMENT_MODELS",
    "EXECUTION_GUIDANCE_MODELS", "TASK_COMPLETION_GUIDANCE", "PARALLEL_TOOL_CALL_GUIDANCE",
    "OPENAI_MODEL_EXECUTION_GUIDANCE", "_EXECUTION_GUIDANCE_LINE_TOOLS", "GOOGLE_MODEL_OPERATIONAL_GUIDANCE",
    "STEER_MARKER_OPEN", "STEER_MARKER_CLOSE", "STEER_CHANNEL_NOTE", "PLATFORM_HINTS", "TELEGRAM_RICH_MESSAGES_HINT",
    "WSL_ENVIRONMENT_HINT", "RUNTIME_ENVIRONMENT_HEADING", "RUNTIME_ENVIRONMENT_END", "_BACKEND_FALLBACK_DESCRIPTIONS",
    "CONTEXT_FILE_MAX_CHARS",
])
cc = collect("agent/context_compressor.py", [
    "HISTORICAL_TASK_HEADING", "SUMMARY_PREFIX", "LEGACY_SUMMARY_PREFIX", "_NO_USER_TASK_SENTINEL",
    "COMPRESSION_CONTINUATION_USER_CONTENT", "_SUMMARY_END_MARKER", "_MERGED_PRIOR_CONTEXT_HEADER",
    "_MERGED_SUMMARY_DELIMITER", "_SECTION_INSTRUCTIONS", "_PRUNED_TOOL_PLACEHOLDER",
])
pr = collect("agent/context_compressor_prompt_rules.py", ["UNVERIFIED_SECTION_HEADING", "EPISTEMIC_STANCE_RULE", "UNVERIFIED_HYPOTHESES_SECTION"])
cm = collect("agent/compression_marker.py", ["_COMPRESSION_MARKER_TEMPLATE", "_ELISION_MARKER_TEMPLATE"])
# _COMPRESSION_NOTE is a class attribute.
t2 = ast.parse(open(UP + "agent/context_compressor.py", encoding="utf-8").read())
for node in ast.walk(t2):
    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "_COMPRESSION_NOTE":
        cc["_COMPRESSION_NOTE"] = ev(node.value, {})
json.dump({"pb": pb, "cc": cc, "pr": pr, "cm": cm}, open(OUT, "w"), ensure_ascii=False, indent=1)
print("ok", {k: len(v) for k, v in dict(pb=pb, cc=cc, pr=pr, cm=cm).items()})
