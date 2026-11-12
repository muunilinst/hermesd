"""Pure helpers for bench.py (no Hermes needed; unit-tested by test_benchlib.py)."""
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import urllib.parse

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


def validate_fixture_data(rec, name):
    """Problems (list of str) that make transcript `rec` of script `name` unusable. Mirrors validateFixture in
    packages/golden/src/baseline.ts for side "upstream": format, side, script, nonempty requests, nonempty
    messages rows and nonempty admissions rows."""
    if not isinstance(rec, dict):
        return ["transcript is not an object"]
    problems = []
    if rec.get("format") != GOLDEN_FORMAT: problems.append(f"format {rec.get('format')!r}")
    if rec.get("side") != "upstream": problems.append(f"side {rec.get('side')!r}")
    if rec.get("script") != name: problems.append(f"script {rec.get('script')!r}, wanted {name!r}")
    reqs = rec.get("requests")
    if not isinstance(reqs, list) or not reqs: problems.append("no requests")
    rows = rec.get("rows")
    msgs = rows.get("messages") if isinstance(rows, dict) else None
    adm = rows.get("admissions") if isinstance(rows, dict) else None
    if not isinstance(msgs, list) or not msgs: problems.append("no messages rows")
    if not isinstance(adm, list) or not adm: problems.append("no admissions rows")
    return problems


def validate_fixture_file(path, name):
    """Raise ValueError unless `path` is a usable upstream transcript of script `name`."""
    try:
        rec = json.load(open(path))
    except (OSError, ValueError) as e:
        raise ValueError(f"{path}: unreadable: {e}")
    problems = validate_fixture_data(rec, name)
    if problems:
        raise ValueError("invalid transcript: " + "; ".join(problems))


def commit_validated(tmp, out, name):
    """Validate the staged transcript `tmp` and only then atomically replace `out` with it (os.replace; `tmp` must
    be on the same filesystem). Raises ValueError and leaves `out` untouched when it is not usable."""
    validate_fixture_file(tmp, name)
    os.replace(tmp, out)


def pre_tool_failure(rec):
    """True only if transcript `rec` shows the persistence failure landed BEFORE the tool ran: no `tool` message
    row was stored and the model was never asked a second time (the second request carries the tool result)."""
    if not isinstance(rec, dict):
        return False
    rows = rec.get("rows") or {}
    msgs = rows.get("messages") or []
    if any(isinstance(m, dict) and m.get("role") == "tool" for m in msgs):
        return False
    return len(rec.get("requests") or []) == 1


# ---------------------------------------------------------------- run-owned resources and input checks

SCENARIO_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def check_scenario_name(name, known=None):
    """The scenario name, or ValueError. Must match a safe pattern (no separators, dots, leading dash) and, when
    `known` is given, be one of the known scripts."""
    if not isinstance(name, str) or not SCENARIO_RE.match(name):
        raise ValueError(f"invalid scenario name {name!r}")
    if known is not None and name not in known:
        raise ValueError(f"unknown scenario {name!r}")
    return name


def known_scenarios(scripts_dir):
    try:
        return sorted(f[:-5] for f in os.listdir(scripts_dir) if f.endswith(".json"))
    except OSError:
        return []


LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


def validate_local_endpoint(url, port):
    """Raise ValueError unless `url` is an http URL whose parsed host is 127.0.0.1/localhost/::1, port is `port`
    and that carries no user information (so 'http://127.0.0.1:8089@remote/' is refused)."""
    if not isinstance(url, str) or any(c.isspace() or c == chr(92) or ord(c) < 32 for c in url):
        raise ValueError(f"unusable URL {url!r}")
    try:
        u = urllib.parse.urlsplit(url)
        host, uport = u.hostname, u.port
    except ValueError as e:
        raise ValueError(f"unparseable URL {url!r}: {e}")
    if u.scheme != "http": raise ValueError(f"{url!r}: scheme must be http")
    if "@" in u.netloc or u.username is not None or u.password is not None:
        raise ValueError(f"{url!r}: user information is not allowed")
    if host not in LOCAL_HOSTS: raise ValueError(f"{url!r}: host {host!r} is not local")
    if uport != port: raise ValueError(f"{url!r}: port {uport!r}, wanted {port}")


class RunDirs:
    """Directories (and mounts) created by THIS invocation, under `base`. Only what make()/record_mount() saw is
    ever removed or unmounted; with keep=True nothing is removed."""

    def __init__(self, base, keep=False, umount=None):
        self.base, self.keep = base, keep
        self.dirs, self.mounts = [], []
        self._umount = umount or (lambda p: subprocess.run(["sudo", "umount", p], capture_output=True).returncode == 0)

    def make(self, prefix):
        os.makedirs(self.base, exist_ok=True)
        p = tempfile.mkdtemp(prefix=prefix + "-", dir=self.base)
        self.dirs.append(p)
        return p

    def record_mount(self, path):
        self.mounts.append(path)

    def unmount_all(self):
        """unmount only the mounts we recorded; returns the paths that could not be unmounted"""
        stuck = []
        for m in reversed(list(self.mounts)):
            if self._umount(m): self.mounts.remove(m)
            else: stuck.append(m)
        return stuck

    def cleanup(self):
        """remove what we created (not with keep); a directory that is still mounted is left alone"""
        stuck = self.unmount_all()
        if self.keep:
            return
        for d in reversed(self.dirs):
            if any(m == d or m.startswith(d + os.sep) for m in stuck):
                continue
            shutil.rmtree(d, ignore_errors=True)
        self.dirs = [d for d in self.dirs if os.path.exists(d)]


def remaining_time(deadline, now):
    """seconds left until `deadline` (same clock as `now`); raises TimeoutError when none are left."""
    left = deadline - now
    if left <= 0:
        raise TimeoutError("deadline passed")
    return left


def retry_exit_code(result):
    """Process exit status for a kill sample: nonzero unless the sample is valid."""
    return 0 if result.get("valid") else 1
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


def check_request_delta(label, before, after, want):
    """Raise RuntimeError unless exactly `want` model requests happened between two counts of the request log
    (a retry inside Hermes would inflate whatever is being measured)."""
    if after - before != want:
        raise RuntimeError(f"{label}: {after - before} model requests, wanted {want}")
