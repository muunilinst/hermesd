#!/usr/bin/env python3
"""persistence-failure-before-tool, two variants kept under distinct names.

    python3 persist_fail.py            # chmod variant (UPSTREAM.md): chmod a-w state.db{,-wal,-shm} after request 0
    python3 persist_fail.py --full     # disk-full variant: HERMES_HOME on a small tmpfs, filled after request 0

Both use a copy of the script whose step 0 holds (name "p0") so the fault lands after request 0 is logged and
before Hermes gets the tool call; the hold is released after the fault. Nothing else in the script changes.

Outputs (work/ = bench/upstream/work):
    work/<name>.<variant>.driver.json       what the driver saw
    work/<name>.<variant>.transcript.json   the assembled transcript of that variant
The canonical packages/golden/transcripts/upstream/<name>.json is the DISK-FULL capture. It is published (validated,
atomically, the same path record.py uses) only by a --full run whose transcript shows the failure BEFORE the tool
ran (no tool row, no second model request). Otherwise the capture stays a diagnostic file next to the driver log and
the script exits nonzero. The chmod variant never touches the canonical fixture.

Every run works in its own directory under ~/hh (HERMES_HOME, request log, snapshot, tmpfs mount point). Only the
mount this run made is unmounted and only the directory it made is removed; --keep leaves the directory.
"""
import json, os, shutil, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record as R
from benchlib import RunDirs, commit_validated, pre_tool_failure, validate_fixture_data

name = "persistence-failure-before-tool"
WORK = os.path.join(R.ROOT, "bench/upstream/work")
CANONICAL = os.path.join(R.ROOT, "packages/golden/transcripts/upstream", name + ".json")


def n_lines(p):
    return sum(1 for _ in open(p)) if os.path.exists(p) else 0


def main():
    dirs = RunDirs(os.path.expanduser("~/hh"), keep="--keep" in sys.argv)
    try:
        rc = run(dirs)
    except BaseException:
        dirs.keep = True  # keep the evidence of a failed run
        raise
    finally:
        left = dirs.unmount_all()
        if left: print(f"persist_fail: could not unmount {left}; leaving those directories", file=sys.stderr)
        dirs.cleanup()
    sys.exit(rc)


def run(dirs):
    full = "--full" in sys.argv
    variant = "full" if full else "chmod"
    spath = os.path.join(R.ROOT, "packages/golden/scripts", name + ".json")
    script = json.load(open(spath))
    held = json.loads(json.dumps(script)); held["steps"][0]["hold"] = "p0"
    hpath = os.path.join(WORK, "scripts", name + ".held.json"); os.makedirs(os.path.dirname(hpath), exist_ok=True)
    json.dump(held, open(hpath, "w"), indent=1)
    if R.port_busy():
        raise SystemExit(f"persist_fail: port {R.PORT} is in use; refusing to start")
    runroot = dirs.make(f"{name}-{variant}")
    home = os.path.join(runroot, "home"); os.makedirs(home)
    srv = p = None
    env = R.env_for(home, script)
    try:
        if full:
            subprocess.run(["sudo", "mount", "-t", "tmpfs", "-o", f"size=400m,uid={os.getuid()},gid={os.getgid()}", "tmpfs", home], check=True)
            dirs.record_mount(home)
        cfg = R.config_for(script)
        R.check_settings(script, cfg, env)
        json.dump(cfg, open(f"{home}/config.yaml", "w"))
        log = os.path.join(runroot, "requests.jsonl")
        srv = subprocess.Popen([R.BUN, f"{R.G}/server.mjs", hpath, "--port", str(R.PORT), "--log", log], stdout=subprocess.PIPE, text=True)
        if '"listening"' not in srv.stdout.readline():
            raise SystemExit("persist_fail: scripted server did not start")
        p = subprocess.Popen([R.HERMES, "chat", "-q", script["inputs"][0]["send"]], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=home)
        t0 = time.time()
        while time.time() - t0 < 120 and n_lines(log) < 1 and p.poll() is None: time.sleep(0.2)
        if n_lines(log) < 1:
            raise SystemExit("persist_fail: request 0 never reached the scripted server; not injecting the fault")
        time.sleep(0.5)
        db = f"{home}/state.db"
        if not os.path.exists(db):
            raise SystemExit("persist_fail: no state.db at fault time; not injecting the fault")
        if full:
            subprocess.run(["dd", "if=/dev/zero", f"of={home}/filler", "bs=1M", "count=1000"], capture_output=True)  # ends with ENOSPC by design
            fault = subprocess.run(["df", "-k", home], capture_output=True, text=True).stdout
            free_kib = int(fault.strip().splitlines()[-1].split()[3])
            if free_kib > 64:
                raise SystemExit(f"persist_fail: disk not full after the filler ({free_kib} KiB free); variant invalid")
        else:
            for f in (db, db + "-wal", db + "-shm"):
                if os.path.exists(f): os.chmod(f, 0o444)
            fault = subprocess.run(["ls", "-l", db, db + "-wal", db + "-shm"], capture_output=True, text=True).stdout
        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{R.PORT}/__release/p0", method="POST"), timeout=10).read()
        try: out, _ = p.communicate(timeout=240)
        except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
        time.sleep(1)
        # read the rows back from a copy with write access restored
        snap = os.path.join(runroot, "snap"); os.makedirs(snap)
        for f in ("state.db", "state.db-wal", "state.db-shm"):
            if os.path.exists(f"{home}/{f}"): shutil.copy(f"{home}/{f}", f"{snap}/{f}"); os.chmod(f"{snap}/{f}", 0o644)
        logs = subprocess.run(f"grep -h -i 'readonly\\|read-only\\|disk\\|full\\|persist\\|OperationalError' {home}/logs/*.log | tail -25", shell=True, capture_output=True, text=True).stdout
        rec = {"variant": variant, "fault": fault, "rc": p.returncode, "out": out[-2500:], "requests": n_lines(log), "log_lines": logs}
        json.dump(rec, open(os.path.join(WORK, f"{name}.{variant}.driver.json"), "w"), indent=1)
        o = os.path.join(WORK, f"{name}.{variant}.transcript.json")
        r = subprocess.run([R.BUN, f"{R.G}/assemble.mjs", spath, "--log", log, "--db", f"{snap}/state.db", "--out", o], capture_output=True, text=True)
        print(r.stdout + r.stderr)
        if r.returncode != 0 or not os.path.exists(o):
            raise SystemExit(f"persist_fail: assemble.mjs exited {r.returncode}")
        print(json.dumps({k: v for k, v in rec.items() if k != "out"}, indent=1)); print(out[-1500:])
        print(f"wrote {o}")
        with open(o) as f: rec_t = json.load(f)
        if not full:
            return 0  # the chmod capture is never published
        problems = validate_fixture_data(rec_t, name)
        if problems or not pre_tool_failure(rec_t):
            why = problems or ["the failure was not observed before the tool ran (tool row stored or a second model request was made)"]
            print(f"persist_fail: NOT published; kept as diagnostic {o}: " + "; ".join(why), file=sys.stderr)
            return 1
        stage = os.path.join(os.path.dirname(CANONICAL), f".{name}.json.tmp")
        try:
            shutil.copyfile(o, stage)
            commit_validated(stage, CANONICAL, name)
        except ValueError as e:
            print(f"persist_fail: NOT published; kept as diagnostic {o}: {e}", file=sys.stderr)
            return 1
        finally:
            if os.path.exists(stage): os.unlink(stage)
        print(f"published {o} -> {CANONICAL}")
        return 0
    finally:
        if srv: srv.terminate()
        try: R.stop_home_gateway(env)  # this HERMES_HOME's gateway only
        except Exception as e: print("warning: gateway stop failed:", e, file=sys.stderr)
        if p and p.poll() is None: p.kill()


if __name__ == "__main__":
    main()
