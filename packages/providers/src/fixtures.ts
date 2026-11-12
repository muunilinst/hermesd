import type { ApiMode, Message, ToolDefinition } from "./types.ts";

/** Shared test data: one conversation with parallel tool calls and a tool error. */

export const MODELS: Record<ApiMode, string> = {
  chat_completions: "gpt-4o",
  anthropic_messages: "claude-sonnet-4-5",
  codex_responses: "gpt-5-codex",
  bedrock_converse: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
};

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: { name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  },
];

export const PARALLEL_CONVERSATION: Message[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "List the files and read a.txt" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
      { id: "call_2", type: "function", function: { name: "shell", arguments: '{"command":"cat a.txt"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" },
  { role: "tool", tool_call_id: "call_2", content: "Error: cat: a.txt: Permission denied" },
];

export const ALL_MODES: readonly ApiMode[] = ["chat_completions", "anthropic_messages", "codex_responses", "bedrock_converse"];
