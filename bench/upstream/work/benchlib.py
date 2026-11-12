"""Pure helpers for bench.py (no Hermes needed; unit-tested by test_benchlib.py)."""
import json
import os
import re
import socket
import struct

WAL_HEADER = 32
FRAME_HEADER = 24


def pct(xs, q):
    """linear-interpolated percentile, q in [0, 1]"""
    if not xs:
        raise ValueError("pct of an empty sample")
    xs = sorted(xs)
    k = (len(xs) - 1) * q
    f = int(k)
    return xs[f] + (xs[min(f + 1, len(xs) - 1)] - xs[f]) * (k - f)


def wal_snapshot(walpath):
    """(salts, frames, commits) of the current WAL generation, or None if there is no usable WAL.

    salts is bytes 16..23 of the -wal header (salt-1, salt-2). SQLite picks new salts every time it
    restarts the WAL after a checkpoint, so two snapshots with different salts belong to different
    generations and their frame counts must not be subtracted. Only frames whose own header carries
    the header's salts are valid frames of this generation."""
    try:
        b = open(walpath, "rb").read()
    except FileNotFoundError:
        return None
    if len(b) < WAL_HEADER:
        return None
    psz = struct.unpack(">I", b[8:12])[0]
    if psz < 512 or psz & (psz - 1):
        return None
    salts = bytes(b[16:24])
    frames = commits = 0
    off = WAL_HEADER
    while off + FRAME_HEADER + psz <= len(b):
        h = b[off:off + FRAME_HEADER]
        if h[8:16] != salts:
            break
        frames += 1
        if struct.unpack(">I", h[4:8])[0] != 0:
            commits += 1
        off += FRAME_HEADER + psz
    return salts, frames, commits


def wal_delta(before, after):
    """{'wal_frames','wal_commit_frames','wal_reset'}: counts are None unless both snapshots are one generation."""
    if before is None or after is None:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": None, "wal_note": "no usable WAL snapshot"}
    if before[0] != after[0]:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": True,
                "wal_note": "WAL salts changed (checkpoint/restart): not comparable"}
    if after[1] < before[1] or after[2] < before[2]:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": None,
                "wal_note": "frame count went down within one salt generation"}
    return {"wal_frames": after[1] - before[1], "wal_commit_frames": after[2] - before[2], "wal_reset": False}


def port_in_use(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def require_ports_free(*ports):
    busy = [p for p in ports if port_in_use(p)]
    if busy:
        raise RuntimeError(f"port(s) {busy} are already in use; refusing to start (and not killing whoever holds them)")


def proc_cmdline(pid):
    try:
        return open(f"/proc/{pid}/cmdline").read().replace("\0", " ")
    except OSError:
        return None


def validate_reply(data, expected):
    """Raise unless `data` is a normal chat completion whose text is exactly `expected`."""
    if not isinstance(data, dict):
        raise ValueError(f"response is not an object: {data!r:.200}")
    if data.get("error"):
        raise ValueError(f"error envelope: {data['error']!r:.300}")
    ch = data.get("choices")
    if not ch or not isinstance(ch, list):
        raise ValueError(f"no choices: {data!r:.300}")
    got = (ch[0].get("message") or {}).get("content")
    if got != expected:
        raise ValueError(f"unexpected reply {got!r}, wanted {expected!r}")
    if ch[0].get("finish_reason") not in (None, "stop"):
        raise ValueError(f"finish_reason {ch[0].get('finish_reason')!r}")


# ---------------------------------------------------------------- recording helpers (record.py, clarify_pty.py)

GOLDEN_FORMAT = "hermesd-golden/1"


def count_lines(path):
    try:
        with open(path) as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def validate_fixture_file(path, name):
    """Raise ValueError unless `path` is a usable upstream transcript of script `name`."""
    try:
        rec = json.load(open(path))
    except (OSError, ValueError) as e:
        raise ValueError(f"{path}: unreadable: {e}")
    if not isinstance(rec, dict):
        raise ValueError("transcript is not an object")
    problems = []
    if rec.get("format") != GOLDEN_FORMAT: problems.append(f"format {rec.get('format')!r}")
    if rec.get("side") != "upstream": problems.append(f"side {rec.get('side')!r}")
    if rec.get("script") != name: problems.append(f"script {rec.get('script')!r}, wanted {name!r}")
    if not rec.get("requests"): problems.append("no requests")
    rows = rec.get("rows") or {}
    if not rows.get("messages"): problems.append("no messages rows")
    if problems:
        raise ValueError("invalid transcript: " + "; ".join(problems))


def capture_failures(transcript, inputs):
    """Reasons a recorded driver transcript cannot be trusted. `transcript` is the list of driver entries
    (entries with a 'cmd' are the chat runs); an interrupted input is expected to exit nonzero."""
    runs = {t["input"]: t for t in transcript if "cmd" in t}
    failed = []
    for i, inp in enumerate(inputs):
        t = runs.get(i)
        if t is None:
            failed.append(f"input {i}: never ran")
            continue
        if t.get("timed_out"):
            failed.append(f"input {i}: hermes chat timed out")
        elif t.get("rc") != 0 and not inp.get("interrupt"):
            failed.append(f"input {i}: hermes chat exited {t.get('rc')}")
    return failed


def find_tool_trigger(procs, before, home_of, home, needle="sleep 60"):
    """pid of a process of THIS run's tool: its cmdline contains `needle`, it did not exist before the client was
    spawned, and some ancestor (or itself) runs with HERMES_HOME == home. procs: {pid: (ppid, cmdline)}."""
    for pid, (_ppid, cmd) in procs.items():
        if pid in before or not re.search(r"(?<![\w.-])" + re.escape(needle) + r"(?![\w.-])", cmd):
            continue
        cur, hops = pid, 0
        while cur in procs and hops < 64:
            if home_of(cur) == home:
                return pid
            cur = procs[cur][0]; hops += 1
    return None


def trigger_observed(kind, log_lines_before, log_lines_now, tool_pid):
    """The interrupt trigger of the CURRENT turn: a model request logged after the turn started, and for a
    running tool also a tool process that started after it."""
    if kind == "model_call":
        return log_lines_now > log_lines_before
    if kind == "tool_running":
        return log_lines_now > log_lines_before and tool_pid is not None
    raise ValueError(f"unknown interrupt kind {kind!r}")


# ---------------------------------------------------------------- strace and retry outcomes (bench.py)

def parse_strace(path):
    """Counters from an strace -yy log of write/fsync calls on state.db / state.db-wal, or None when the trace is
    unavailable (no file, or an empty one). Zeros are only returned for a non-empty trace that had no such call."""
    s = {"wal_writes": 0, "wal_fsyncs": 0, "db_writes": 0, "db_fsyncs": 0}
    try:
        lines = open(path, errors="replace").read().splitlines()
    except FileNotFoundError:
        return None
    if not any(l.strip() for l in lines):
        return None
    for l in lines:
        if "state.db-wal>" in l:
            if "fsync" in l or "fdatasync" in l: s["wal_fsyncs"] += 1
            elif "write" in l: s["wal_writes"] += 1
        elif "state.db>" in l:
            if "fsync" in l or "fdatasync" in l: s["db_fsyncs"] += 1
            elif "write" in l: s["db_writes"] += 1
    return s


def strace_problem(stderr_text, returncode_while_running, trace_path):
    """Why a strace run cannot be trusted, or None. `returncode_while_running` is strace's poll() result just
    before it was stopped (None = still attached and running)."""
    low = (stderr_text or "").lower()
    if returncode_while_running is not None:
        return f"strace exited early with status {returncode_while_running}: {(stderr_text or '').strip()[:200]}"
    for bad in ("operation not permitted", "no such process", "permission denied", "ptrace", "attach:", "not found"):
        if bad in low:
            return f"strace reported: {(stderr_text or '').strip()[:200]}"
    if not os.path.exists(trace_path) or os.path.getsize(trace_path) == 0:
        return "strace produced no output"
    return None


def request_outcome(holder):
    """Classify what a client thread observed. holder keys: reply (parsed OK), http_status (an HTTP error response),
    timeout (no response within the client's deadline), error (anything else). Only 'http_response' is an observed outcome."""
    if "reply" in holder:
        return "http_response"
    if "http_status" in holder:
        return "http_response"
    if holder.get("timeout"):
        return "observation_timeout"
    if "error" in holder:
        return "client_error"
    return "no_response"
