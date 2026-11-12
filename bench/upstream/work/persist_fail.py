#!/usr/bin/env python3
"""persistence-failure-before-tool. Variant A (UPSTREAM.md): chmod a-w state.db{,-wal,-shm} after request 0.
Variant B (--full): HERMES_HOME on a small tmpfs, filled to 100% after request 0.
Both use a copy of the script whose step 0 holds (name "p0") so the fault lands after request 0 is logged and
before Hermes gets the tool call; the hold is released after the fault. Nothing else in the script changes."""
import json, os, subprocess, sys, time, shutil, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import record as R
full = "--full" in sys.argv
name = "persistence-failure-before-tool"
spath = os.path.join(R.ROOT, "packages/golden/scripts", name + ".json")
script = json.load(open(spath))
held = json.loads(json.dumps(script)); held["steps"][0]["hold"] = "p0"
hpath = os.path.join(R.ROOT, "bench/upstream/work/scripts", name + ".held.json"); os.makedirs(os.path.dirname(hpath), exist_ok=True)
json.dump(held, open(hpath, "w"), indent=1)
home = os.path.expanduser(f"~/hh/{name}")
subprocess.run(["sudo", "umount", home], capture_output=True); shutil.rmtree(home, ignore_errors=True); os.makedirs(home)
if full:
    subprocess.run(["sudo", "mount", "-t", "tmpfs", "-o", f"size=400m,uid={os.getuid()},gid={os.getgid()}", "tmpfs", home], check=True)
json.dump(R.config_for(script), open(f"{home}/config.yaml", "w"))
log = os.path.expanduser(f"~/hh/{name}.requests.jsonl")
srv = subprocess.Popen([R.BUN, f"{R.G}/server.mjs", hpath, "--port", "8089", "--log", log], stdout=subprocess.PIPE, text=True); srv.stdout.readline()
env = dict(os.environ, HERMES_HOME=home)
p = subprocess.Popen([R.HERMES, "chat", "-q", script["inputs"][0]["send"]], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=home)
t0 = time.time()
while time.time() - t0 < 120 and sum(1 for _ in open(log)) < 1: time.sleep(0.2)
time.sleep(0.5)
db = f"{home}/state.db"
if full:
    subprocess.run(["dd", "if=/dev/zero", f"of={home}/filler", "bs=1M", "count=1000"], capture_output=True)
    fault = subprocess.run(["df", "-k", home], capture_output=True, text=True).stdout
else:
    for f in (db, db + "-wal", db + "-shm"):
        if os.path.exists(f): os.chmod(f, 0o444)
    fault = subprocess.run(["ls", "-l", db, db + "-wal", db + "-shm"], capture_output=True, text=True).stdout
urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8089/__release/p0", method="POST")).read()
try: out, _ = p.communicate(timeout=240)
except subprocess.TimeoutExpired: p.kill(); out, _ = p.communicate()
time.sleep(1)
srv.terminate()
subprocess.run([R.HERMES, "gateway", "stop"], env=env, capture_output=True, timeout=60); subprocess.run(["pkill", "-f", "gateway run"]); time.sleep(1)
# read the rows back from a copy with write access restored
snap = os.path.expanduser(f"~/hh/{name}.snap"); shutil.rmtree(snap, ignore_errors=True); os.makedirs(snap)
for f in ("state.db", "state.db-wal", "state.db-shm"):
    if os.path.exists(f"{home}/{f}"): shutil.copy(f"{home}/{f}", f"{snap}/{f}"); os.chmod(f"{snap}/{f}", 0o644)
logs = subprocess.run(f"grep -h -i 'readonly\\|read-only\\|disk\\|full\\|persist\\|OperationalError' {home}/logs/*.log | tail -25", shell=True, capture_output=True, text=True).stdout
if full: subprocess.run(["sudo", "umount", home])
variant = "full" if full else "chmod"
rec = {"variant": variant, "fault": fault, "rc": p.returncode, "out": out[-2500:], "requests": sum(1 for _ in open(log)), "log_lines": logs}
json.dump(rec, open(os.path.join(R.ROOT, f"bench/upstream/work/{name}.{variant}.driver.json"), "w"), indent=1)
o = os.path.join(R.ROOT, "packages/golden/transcripts/upstream", f"{name}.json" if not full else f"../../../../bench/upstream/work/{name}.full.transcript.json")
print(subprocess.run([R.BUN, f"{R.G}/assemble.mjs", spath, "--log", log, "--db", f"{snap}/state.db", "--out", o], capture_output=True, text=True))
print(json.dumps({k: v for k, v in rec.items() if k != "out"}, indent=1)); print(out[-1500:])
