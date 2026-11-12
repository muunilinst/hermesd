#!/usr/bin/env bash
# The last step of the migration test (porting guide 6.4):
# "run hermes chat --resume on it. If upstream can resume what the port wrote,
#  the rows are interchangeable."
#
# Run this by hand on your own machine, where Hermes is installed. The agent
# environment of this repo may not execute upstream Hermes, so the matching test
# in packages/state-port/src/migration.test.ts is skipped.
#
# Usage:
#   contracts/resume-check.sh <exported-state.db> <session-id> [message]
#
# How to get an exported file:
#   - from the sample file of the migration test, on the command line:
#       bun packages/state-port/src/cli.ts sample /tmp/sample.db
#       bun packages/state-port/src/cli.ts roundtrip /tmp/sample.db /tmp/exported.db
#     then run this script with /tmp/exported.db and the session id s2b.
#   - or roundtrip a COPY of a real state.db the same way.
#
# What it does:
#   1. Copies the file into a new, empty HERMES_HOME. Your real ~/.hermes is not touched.
#   2. Runs `hermes chat --resume <session-id>` once with a short message.
#   3. Reads the file again with Python's sqlite3 module (the Python standard
#      library, not Hermes) and prints what Hermes changed: the runtime epoch,
#      the started admissions, the new messages.
#
# Pass if: Hermes resumes without a schema or migration error, the earlier
# messages are in its context, the new message is stored, runtime_epoch went up,
# and any admission that was `started` in the file is now `unknown`.
#
# Check the flags against `hermes chat --help` for your version. The one-shot
# message flag is set in HERMES_CHAT_ARGS (default: -q, an assumption). The
# variable that points Hermes at its home folder is assumed to be HERMES_HOME;
# the port did not check this against upstream. If yours differs, change it below.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: contracts/resume-check.sh <exported-state.db> <session-id> [message]" >&2
  echo "see the comment at the top of this file" >&2
  exit 2
fi

DB="$1"
SESSION="$2"
MESSAGE="${3:-Reply with the single word OK.}"
HERMES_BIN="${HERMES_BIN:-hermes}"
HERMES_CHAT_ARGS="${HERMES_CHAT_ARGS:--q}"

command -v "$HERMES_BIN" >/dev/null || { echo "hermes not found; set HERMES_BIN" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
[ -f "$DB" ] || { echo "no such file: $DB" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HERMES_HOME="$WORK/hermes-home"
mkdir -p "$HERMES_HOME"
cp "$DB" "$HERMES_HOME/state.db"

report() {
  python3 -I - "$HERMES_HOME/state.db" "$SESSION" <<'PY'
import sqlite3, sys
path, session = sys.argv[1], sys.argv[2]
db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
def one(sql, *a):
    return db.execute(sql, a).fetchall()
print("  schema_version      :", one("select version from schema_version"))
print("  runtime_epoch       :", one("select epoch, instance_id from runtime_epoch"))
print("  admissions by status:", one("select status, count(*) from session_admissions group by status"))
print("  messages in session :", one("select count(*) from messages where session_id = ?", session))
print("  last messages       :", one("select role, substr(content, 1, 60) from messages where session_id = ? order by id desc limit 3", session))
PY
}

echo "== before =="
report

echo "== hermes chat --resume $SESSION =="
# shellcheck disable=SC2086
"$HERMES_BIN" chat --resume "$SESSION" $HERMES_CHAT_ARGS "$MESSAGE"

echo "== after =="
report
echo
echo "Compare by eye with the rules above. Keep the output with the pin commit of Hermes you ran."
