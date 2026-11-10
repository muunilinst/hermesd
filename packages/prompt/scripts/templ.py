# Static: turn upstream f-string templates into TypeScript string expressions.
import ast, json, sys
import os
UP = os.environ["HERMES_UPSTREAM"].rstrip("/") + "/"
src = open(UP + "agent/context_compressor.py", encoding="utf-8").read()
tree = ast.parse(src)

MAP = {
    "_summarizer_preamble": "preamble",
    "_bounded_previous_summary": "boundedPreviousSummary",
    "content_to_summarize": "contentToSummarize",
    "_memory_section": "memorySection",
    "HISTORICAL_TASK_HEADING": "HISTORICAL_TASK_HEADING",
    "_template_sections": "templateSections",
    '_section["historical_task"]': 'section.historical_task',
    '_section["goal"]': 'section.goal',
    '_section["constraints"]': 'section.constraints',
    '_section["resolved_questions"]': 'section.resolved_questions',
    "UNVERIFIED_HYPOTHESES_SECTION": "UNVERIFIED_HYPOTHESES_SECTION",
    "_session_log_section": "sessionLogSection",
    "_PRUNED_SKILLS_SECTION_HEADING": "PRUNED_SKILLS_SECTION_HEADING",
    "summary_budget + (_LEAN_SESSION_LOG_BUDGET_TOKENS if _session_log_section else 0)": "summaryBudgetTotal",
    "_temporal_anchoring_rule": "temporalAnchoringRule",
    "focus_topic": "focusTopic",
    "_today_str": "todayStr",
}


def to_ts(n):
    parts = []
    for v in n.values:
        if isinstance(v, ast.Constant):
            parts.append(json.dumps(v.value, ensure_ascii=False))
        else:
            key = ast.unparse(v.value).replace("'", '"')
            if key not in MAP:
                raise SystemExit("unmapped expr: " + key)
            parts.append(MAP[key])
    return " +\n    ".join(parts)


def find_func(name):
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node


out = []
f = find_func("_summary_template_sections")
for node in ast.walk(f):
    if isinstance(node, ast.Return):
        out.append("// _summary_template_sections\nexport const TEMPLATE_SECTIONS_EXPR = " + to_ts(node.value) + ";")
f = find_func("_build_summary_prompt")
js = [n for n in ast.walk(f) if isinstance(n, ast.JoinedStr)]
for i, n in enumerate(js):
    out.append(f"// _build_summary_prompt JoinedStr #{i}\nexport const PROMPT_{i} = " + to_ts(n) + ";")
f = find_func("_temporal_anchoring_rule")
js = [n for n in ast.walk(f) if isinstance(n, ast.JoinedStr)]
for i, n in enumerate(js):
    out.append(f"// _temporal_anchoring_rule JoinedStr #{i}\nexport const TEMPORAL_{i} = " + to_ts(n) + ";")
open(sys.argv[1], "w", encoding="utf-8").write("\n\n".join(out) + "\n")
print("ok")
