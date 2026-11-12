#!/bin/bash
# run inside the VM from the worktree root
set -euo pipefail
cd "$(dirname "$0")/../../.."
R="python3 bench/upstream/work/record.py"

run() {  # run <name> [record.py args...]: stop the batch at the first failed recording
  local n="$1" out
  echo "=== $n"
  if ! out=$($R "$@" 2>&1); then
    printf '%s\n' "$out" | tail -40
    echo "FAILED: $n" >&2
    exit 1
  fi
  printf '%s\n' "$out" | grep -E "wrote|\"rc\"" || { echo "FAILED: $n printed no 'wrote' line" >&2; exit 1; }
}

for n in plain-reply one-tool-call format-chat-completions format-anthropic-messages format-codex-responses parallel-tools tool-error-text hook-blocks-tool hook-crashes hook-time-budget three-plugins-hook-order dropped-stream-mid-token provider-fallback-429; do
  run "$n"
done
# compaction-50 is NOT part of this batch: it needs a 4,000-token window and Hermes refuses windows under 64K
# (UPSTREAM.md, Compaction), so every chat exits nonzero. diagnostic-compaction-50.sh shows that on purpose.
