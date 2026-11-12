#!/bin/bash
# Part B, run inside the VM from the worktree root. Stops at the first failed phase.
set -euo pipefail
cd "$(dirname "$0")/../../.."
B="python3 bench/upstream/work/bench.py"
set -x
$B turns plain
$B turns tool
$B idle
for i in 1 2 3; do $B kill model $i; done
for i in 1 2 3; do $B kill tool $i; done
