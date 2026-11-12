#!/usr/bin/env python3
"""Part B baseline: upstream Hermes gateway (API server platform) against the scripted model.

Runs inside the OrbStack VM from the worktree root:
    python3 bench/upstream/work/bench.py <phase> ...
phases: cold, turns, idle, kill-model, kill-tool
Every phase prints and appends JSON results to bench/upstream/work/results/<phase>.json.
"""
import json, os, shutil, signal, sqlite3, statistics, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORK = os.path.join(ROOT, "bench/upstream/work")
G = os.path.join(ROOT, "packages/golden/scripted-server")
BUN = os.path.expanduser("~/.bun/bin/bun")
HERMES = os.path.expanduser("~/hvenv/bin/hermes")
MODEL_PORT, API_PORT, KEY = 8090, 8642, "bench-key-0123456789abcdef"
os.makedirs(f"{WORK}/results", exist_ok=True)
os.makedirs(f"{WORK}/scripts", exist_ok=True)


def write_script(name, steps, commands=None):
    p = f"{WORK}/scripts/{name}.json"
    json.dump({"name": name, "mode": "chat_completions", "steps": steps, "commands": commands or {},
               "inputs": [{"send": "x"}], "expect": {}}, open(p, "w"), indent=1)
    return p


def fresh_home(tag):
    home = os.path.expanduser(f"~/hb/{tag}")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    cfg = {"_config_version": 52,
           "auxiliary": {"title_generation": {"enabled": False}},
           "model": {"default": "gpt-4o", "provider": "custom", "base_url": f"http://127.0.0.1:{MODEL_PORT}/v1",
                     "api_key": "x", "streaming": False}}
    json.dump(cfg, open(f"{home}/config.yaml", "w"), indent=2)
    with open(f"{home}/.env", "w") as f:
        f.write(f"API_SERVER_ENABLED=true\nAPI_SERVER_KEY={KEY}\nAPI_SERVER_PORT={API_PORT}\n")
    return home


def free_ports():
    subprocess.run(["fuser", "-k", "-n", "tcp", str(MODEL_PORT), str(API_PORT)], capture_output=True)
    time.sleep(0.5)


class Model:
    def __init__(self, script, log):
        free_ports()
        self.p = subprocess.Popen([BUN, f"{G}/server.mjs", script, "--port", str(MODEL_PORT), "--log", log],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = self.p.stdout.readline()
        if '"listening"' not in line:
            raise RuntimeError("model server did not start: " + line)
        self.log = log

    def count(self):
        return sum(1 for _ in open(self.log))

    def release(self, name):
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{MODEL_PORT}/__release/{name}", method="POST"), timeout=5).read()

    def stop(self):
        self.p.terminate(); self.p.wait()


class Gateway:
    def __init__(self, home):
        self.home = home
        self.env = dict(os.environ, HERMES_HOME=home)
        self.out = open(f"{home}/gateway-run.out", "a")

    def start(self):
        self.t0 = time.time()
        self.p = subprocess.Popen([HERMES, "gateway", "run"], env=self.env, stdout=self.out, stderr=subprocess.STDOUT,
                                  cwd=self.home, start_new_session=True)
        return self

    def wait_health(self, timeout=180):
        while time.time() - self.t0 < timeout:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/health", timeout=2).read()
                return time.time() - self.t0
            except Exception:
                time.sleep(0.05)
        raise RuntimeError("gateway not healthy")

    def pids(self):
        """the gateway process and all descendants"""
        out = subprocess.run(["ps", "-e", "-o", "pid=,ppid="], capture_output=True, text=True).stdout.split()
        kids = {}
        for pid, ppid in zip(out[0::2], out[1::2]):
            kids.setdefault(int(ppid), []).append(int(pid))
        res, stack = [], [self.p.pid]
        while stack:
            x = stack.pop(); res.append(x); stack += kids.get(x, [])
        return res

    def rss_kib(self):
        tot, per = 0, {}
        for pid in self.pids():
            try:
                for l in open(f"/proc/{pid}/status"):
                    if l.startswith("VmRSS:"):
                        v = int(l.split()[1]); tot += v
                        per[pid] = (open(f"/proc/{pid}/comm").read().strip(), v)
            except FileNotFoundError:
                pass
        return tot, per

    def cpu_ticks(self):
        t = 0
        for pid in self.pids():
            try:
                f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
                t += int(f[11]) + int(f[12])  # utime, stime
            except FileNotFoundError:
                pass
        return t

    def kill9(self):
        os.kill(self.p.pid, signal.SIGKILL); self.p.wait()

    def stop(self):
        try:
            os.killpg(self.p.pid, signal.SIGTERM); self.p.wait(timeout=60)
        except Exception:
            try: os.killpg(self.p.pid, signal.SIGKILL)
            except Exception: pass
        subprocess.run(["pkill", "-f", "gateway run"], capture_output=True)
        time.sleep(1)


def chat(text, session_id=None, timeout=600, idem=None):
    h = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if session_id: h["X-Hermes-Session-Id"] = session_id
    if idem: h["Idempotency-Key"] = idem
    body = json.dumps({"model": "hermes-agent", "messages": [{"role": "user", "content": text}]}).encode()
    t0 = time.time()
    r = urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{API_PORT}/v1/chat/completions", data=body, headers=h), timeout=timeout)
    data = json.loads(r.read())
    return time.time() - t0, r.headers.get("X-Hermes-Session-Id"), data


def counts(db):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        names = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
        out = {}
        for n in names:
            try:
                out[n] = c.execute(f'select count(*) from "{n}"').fetchone()[0]
            except sqlite3.DatabaseError:
                pass
        return out
    finally:
        c.close()


def save(phase, obj):
    p = f"{WORK}/results/{phase}.json"
    allr = json.load(open(p)) if os.path.exists(p) else []
    allr.append(obj)
    json.dump(allr, open(p, "w"), indent=1)
    print(json.dumps(obj)[:3000])


def pct(xs, q):
    xs = sorted(xs); k = (len(xs) - 1) * q; f = int(k)
    return xs[f] + (xs[min(f + 1, len(xs) - 1)] - xs[f]) * (k - f)


# ---------------------------------------------------------------- phases

def phase_cold(n=5):
    script = write_script("cold", [{"reply": "ok"}] * (n + 2))
    res = []
    for i in range(n):
        home = fresh_home(f"cold{i}") if i == 0 or "--fresh" in sys.argv else os.path.expanduser("~/hb/cold0")
        m = Model(script, f"{home}/requests-{i}.jsonl")
        g = Gateway(home).start()
        health = g.wait_health()
        # first request accepted: first chat completion that returns 200
        first = None
        while first is None:
            try:
                dt, sid, data = chat(f"cold {i}")
                first = time.time() - g.t0
            except urllib.error.HTTPError as e:
                time.sleep(0.1)
        rss, _ = g.rss_kib()
        res.append({"run": i, "home": "fresh" if i == 0 or "--fresh" in sys.argv else "warm(reused HERMES_HOME)",
                    "health_s": round(health, 3), "first_reply_s": round(first, 3), "rss_kib_after_first": rss})
        g.stop(); m.stop()
    save("cold", {"runs": res, "median_health_s": statistics.median(r["health_s"] for r in res),
                  "median_first_reply_s": statistics.median(r["first_reply_s"] for r in res)})


def strace_start(pid, path):
    return subprocess.Popen(["sudo", "strace", "-f", "-qq", "-p", str(pid), "-e", "trace=pwrite64,write,fsync,fdatasync",
                             "-yy", "-o", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wal_stats(path):
    """count syscalls on state.db-wal / state.db from an strace log"""
    s = {"wal_writes": 0, "wal_fsyncs": 0, "db_writes": 0, "db_fsyncs": 0}
    if not os.path.exists(path): return s
    for l in open(path, errors="replace"):
        if "state.db-wal>" in l:
            if "fsync" in l or "fdatasync" in l: s["wal_fsyncs"] += 1
            elif "write" in l: s["wal_writes"] += 1
        elif "state.db>" in l:
            if "fsync" in l or "fdatasync" in l: s["db_fsyncs"] += 1
            elif "write" in l: s["db_writes"] += 1
    return s


def wal_commit_frames(walpath):
    """number of commit frames in the current WAL generation (valid salts only)"""
    import struct
    try: b = open(walpath, "rb").read()
    except FileNotFoundError: return 0, 0
    if len(b) < 32: return 0, 0
    psz = struct.unpack(">I", b[8:12])[0]; s1, s2 = b[16:20], b[20:24]
    frames = commits = 0; off = 32
    while off + 24 + psz <= len(b):
        h = b[off:off + 24]
        if h[8:12] != s1 or h[12:16] != s2: break
        frames += 1
        if struct.unpack(">I", h[4:8])[0] != 0: commits += 1
        off += 24 + psz
    return frames, commits


def phase_turns(kind, n=20):
    if kind == "plain":
        steps = [{"reply": f"Hello {i}!"} for i in range(2 * n + 5)]
    else:
        steps = []
        for i in range(4 * n + 10):
            steps += [{"reply": "I will run it.", "toolCalls": [{"id": f"call_{i}", "name": "terminal", "arguments": {"command": "echo hello"}}]},
                      {"reply": "It printed hello."}]
    script = write_script(f"turns-{kind}", steps)
    home = fresh_home(f"turns-{kind}")
    m = Model(script, f"{home}/requests.jsonl")
    g = Gateway(home).start(); g.wait_health()
    db = f"{home}/state.db"
    # warm-up turn (session creation), not counted
    _, sid, _ = chat("warm up")
    rss_start, per_start = g.rss_kib()
    turns = []
    for i in range(n):
        before = counts(db)
        f0, c0 = wal_commit_frames(db + "-wal")
        tr = f"{home}/strace-{i}.log"
        st = strace_start(g.p.pid, tr); time.sleep(0.7)
        dt, sid2, data = chat(f"turn {i}", session_id=sid)
        time.sleep(0.3); subprocess.run(["sudo", "kill", "-INT", str(st.pid)]); st.wait()
        after = counts(db)
        f1, c1 = wal_commit_frames(db + "-wal")
        delta = {k: after.get(k, 0) - before.get(k, 0) for k in set(before) | set(after) if after.get(k, 0) != before.get(k, 0)}
        turns.append({"turn": i, "wall_s": round(dt, 4), "reply": data["choices"][0]["message"]["content"],
                      "row_count_delta": delta, "wal_frames": f1 - f0 if f1 >= f0 else None,
                      "wal_commit_frames": c1 - c0 if c1 >= c0 else None, "syscalls": wal_stats(tr)})
    # timings without strace attached (strace slows syscalls): a second pass
    clean = []
    for i in range(n):
        dt, _, data = chat(f"clean turn {i}", session_id=sid)
        clean.append(round(dt, 4))
    rss_20, per_20 = g.rss_kib()
    jm = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    pragmas = {p: jm.execute(f"pragma {p}").fetchone()[0] for p in ("journal_mode", "page_size")}
    jm.close()
    save(f"turns-{kind}", {"kind": kind, "session_id": sid, "pragmas": pragmas,
                           "rss_kib_after_start_and_warmup": rss_start, "rss_kib_after_20_turns": rss_20,
                           "rss_after_20_per_process": per_20,
                           "clean_wall_s": clean, "clean_median_s": statistics.median(clean), "clean_p95_s": round(pct(clean, 0.95), 4),
                           "traced_median_s": statistics.median(t["wall_s"] for t in turns), "turns_traced": turns,
                           "model_requests": m.count()})
    g.stop(); m.stop()


def phase_idle(secs=300):
    script = write_script("idle", [{"reply": "ok"}] * 3)
    home = fresh_home("idle")
    m = Model(script, f"{home}/requests.jsonl")
    g = Gateway(home).start(); h = g.wait_health()
    chat("one turn so the session machinery is loaded")
    time.sleep(5)
    rss0, _ = g.rss_kib()
    hz = os.sysconf("SC_CLK_TCK")
    c0, t0 = g.cpu_ticks(), time.time()
    samples = []
    while time.time() - t0 < secs:
        time.sleep(30)
        samples.append({"t": round(time.time() - t0), "rss_kib": g.rss_kib()[0], "cpu_ticks": g.cpu_ticks() - c0})
    c1, t1 = g.cpu_ticks(), time.time()
    rss1, per1 = g.rss_kib()
    save("idle", {"secs": round(t1 - t0, 1), "cpu_percent_of_one_core": round(100 * (c1 - c0) / hz / (t1 - t0), 3),
                  "cpu_seconds": (c1 - c0) / hz, "rss_kib_start": rss0, "rss_kib_after_idle": rss1, "per_process": per1,
                  "samples": samples, "ncpu": os.cpu_count()})
    g.stop(); m.stop()


def session_rows(db, sid):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        cols = [r[1] for r in c.execute("pragma table_info(messages)")]
        rows = c.execute("select role, content, tool_calls from messages where session_id=? order by rowid", (sid,)).fetchall()
        adm = []
        try:
            acols = [r[1] for r in c.execute("pragma table_info(session_admissions)")]
            adm = [dict(zip(acols, r)) for r in c.execute("select * from session_admissions order by rowid")]
        except sqlite3.DatabaseError:
            pass
        return [{"role": r[0], "content": (r[1] or "")[:200], "tool_calls": (r[2] or "")[:200]} for r in rows], adm
    finally:
        c.close()


def phase_kill(kind, run):
    import threading
    marker = os.path.expanduser(f"~/hb/kill-{kind}-{run}.marker")
    if os.path.exists(marker): os.remove(marker)
    if kind == "model":
        steps = [{"reply": "warm"}, {"hold": "h", "reply": "REPLY-A (the held answer)"}, {"reply": "REPLY-B (a second request)"},
                 {"reply": "REPLY-C"}, {"reply": "REPLY-D"}]
    else:
        cmd = f"echo start >> {marker}; sleep 30; echo end >> {marker}"
        steps = [{"reply": "warm"}, {"reply": "running", "toolCalls": [{"id": "call_s", "name": "terminal", "arguments": {"command": cmd}}]},
                 {"reply": "REPLY-AFTER-TOOL"}, {"reply": "REPLY-C"}, {"reply": "REPLY-D"}]
    script = write_script(f"kill-{kind}", steps)
    home = fresh_home(f"kill-{kind}-{run}")
    m = Model(script, f"{home}/requests.jsonl")
    g = Gateway(home).start(); g.wait_health()
    _, sid, _ = chat("warm")
    db = f"{home}/state.db"
    result = {"kind": kind, "run": run, "events": []}
    ev = result["events"]
    holder = {}

    def send():
        try:
            dt, s, data = chat("the turn under test", session_id=sid, timeout=900, idem=f"kill-{kind}-{run}")
            holder["reply"] = data["choices"][0]["message"]["content"]; holder["dt"] = dt
        except Exception as e:
            holder["error"] = repr(e)[:300]

    th = threading.Thread(target=send); th.start()
    t0 = time.time()
    # wait for the moment: model request held / sleep running
    while time.time() - t0 < 60:
        if kind == "model" and m.count() >= 2: break
        if kind == "tool" and os.path.exists(marker): break
        time.sleep(0.1)
    time.sleep(1.0)
    pids_before = g.pids()
    ev.append({"t": round(time.time() - t0, 2), "event": "kill -9 gateway", "model_requests": m.count()})
    g.kill9()
    th.join(timeout=30)
    ev.append({"t": round(time.time() - t0, 2), "event": "client result after kill", **holder})
    survivors = [p for p in pids_before if os.path.exists(f"/proc/{p}")]
    ev.append({"event": "processes of old gateway tree still alive", "pids": [(p, open(f"/proc/{p}/cmdline").read().replace("\0", " ")[:120]) for p in survivors if os.path.exists(f"/proc/{p}")]})
    rows_at_kill, adm_at_kill = session_rows(db, sid)
    g2 = Gateway(home).start(); g2.wait_health()
    ev.append({"t": round(time.time() - t0, 2), "event": "gateway restarted"})
    if kind == "model":
        time.sleep(3)
        m.release("h")
        ev.append({"t": round(time.time() - t0, 2), "event": "released hold", "model_requests": m.count()})
    # watch for 75 s: does the gateway replay/resume on its own?
    t1 = time.time()
    while time.time() - t1 < 75:
        time.sleep(5)
    ev.append({"t": round(time.time() - t0, 2), "event": "after 75s watch", "model_requests": m.count()})
    # client retries with the same idempotency key (what a careful client does)
    holder.clear(); th = threading.Thread(target=send); th.start(); th.join(timeout=120)
    ev.append({"t": round(time.time() - t0, 2), "event": "client retry with same Idempotency-Key", **holder, "model_requests": m.count()})
    rows, adm = session_rows(db, sid)
    reqs = [json.loads(l) for l in open(m.log)]
    result.update({"rows_at_kill": rows_at_kill, "admissions_at_kill": adm_at_kill, "rows_final": rows, "admissions_final": adm,
                   "model_request_count": len(reqs),
                   "model_requests_last_user": [[x["content"] for x in r["body"]["messages"] if x["role"] == "user"][-1:] for r in reqs],
                   "marker": open(marker).read() if os.path.exists(marker) else None})
    save(f"kill-{kind}", result)
    g2.stop(); m.stop()


if __name__ == "__main__":
    ph = sys.argv[1]
    if ph == "cold": phase_cold()
    elif ph == "turns": phase_turns(sys.argv[2])
    elif ph == "idle": phase_idle()
    elif ph == "kill": phase_kill(sys.argv[2], int(sys.argv[3]))
