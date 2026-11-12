#!/bin/bash
# run inside the VM from the worktree root
cd "$(dirname "$0")/../../.."
R="python3 bench/upstream/work/record.py"
for n in plain-reply one-tool-call format-chat-completions format-anthropic-messages format-codex-responses parallel-tools tool-error-text hook-blocks-tool hook-crashes hook-time-budget three-plugins-hook-order dropped-stream-mid-token provider-fallback-429; do
  echo "=== $n"; $R $n 2>&1 | grep -E "wrote|\"rc\""
done
echo "=== compaction-50"; $R compaction-50 --extra-config '{"model":{"context_length":4000},"compression":{"threshold":0.5}}' 2>&1 | grep -E "wrote|\"rc\""
