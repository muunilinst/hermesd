#!/bin/bash
# DIAGNOSTIC, not part of batch.sh. Tries compaction-50 with the script's 4,000-token window against upstream Hermes.
# Expected result today: it FAILS. Hermes' MINIMUM_CONTEXT_LENGTH is 64,000 tokens, so every turn ends with
# "Your local server is serving a 4,000-token window" and no request reaches the scripted server (UPSTREAM.md,
# Compaction). record.py rejects nonzero chat exits, so no fixture is written. Keep this only to re-check that
# behavior after a pin change; to record compaction, scale the script's window and inputs to >= 64K first.
# Run inside the VM from the worktree root.
set -uo pipefail
cd "$(dirname "$0")/../../.."
echo "diagnostic: compaction-50 at context_length 4000 (expected to fail)"
python3 bench/upstream/work/record.py compaction-50 --extra-config '{"model":{"context_length":4000},"compression":{"threshold":0.5}}'
echo "record.py exit status: $? (nonzero is the documented outcome)"
