// First-party fixture plugin. The register(ctx) shape is the same as upstream.
const DANGEROUS = [/\brm\s+-rf\s+\//, /\bmkfs\b/, /:\(\)\s*\{/];

export function register(ctx) {
  ctx.registerHook("pre_tool_call", guard);
  ctx.registerHook("pre_llm_call", note);
}

// Keyword arguments arrive as one object. Extra keys are normal: ignore them.
function guard({ tool_name, args }) {
  if (tool_name === "terminal") {
    const command = String(args?.command ?? "");
    if (DANGEROUS.some((re) => re.test(command))) {
      return { action: "block", message: "guard: dangerous command" };
    }
  }
  return { action: "approve" };
}

function note({ session_id }) {
  return `guard: session ${session_id} is watched`;
}
