#!/usr/bin/env python3
"""clarify-sequential through a pty: hermes chat -q '<input 1>' on a TTY, answer the clarify prompt with input 2."""
import json, os, pty, re, select, subprocess, sys, time, shutil, signal
sys.path.insert(0, os.path.dirname(__file__))
import record as R
name = "clarify-sequential"
spath = os.path.join(R.ROOT, "packages/golden/scripts", name + ".json")
script = json.load(open(spath))
home = os.path.expanduser(f"~/hh/{name}"); shutil.rmtree(home, ignore_errors=True); os.makedirs(home)
json.dump(R.config_for(script), open(f"{home}/config.yaml", "w"))
log = f"{home}/requests.jsonl"
if R.port_busy(): raise SystemExit(f"clarify_pty: port {R.PORT} is already in use; refusing to start")
srv = subprocess.Popen([R.BUN, f"{R.G}/server.mjs", spath, "--port", str(R.PORT), "--log", log], stdout=subprocess.PIPE, text=True)
inputs = [i["send"] for i in script["inputs"]]
env = dict(os.environ, HERMES_HOME=home, TERM="xterm-256color", COLUMNS="120", LINES="40")
buf = b""; answered = exited = False; t0 = time.time(); events = []; failed = []
pid = None
def strip(b): return re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r", "", b.decode(errors="replace"))
try:
    if '"listening"' not in srv.stdout.readline():
        raise SystemExit("clarify_pty: scripted server did not start")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home); os.execve(R.HERMES, [R.HERMES, "chat", "-q", inputs[0]], env)
    while time.time() - t0 < 150:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            buf += d
        txt = strip(buf)
        if not answered and "Which file?" in txt:
            time.sleep(1.0); os.write(fd, b"\r"); answered = True;  # the menu highlights 1. a.txt (= inputs[1]); Enter locks it
            events.append(("answered", round(time.time()-t0,1)))
        if answered and not exited and "Done." in txt:
            time.sleep(2); os.write(fd, b"/exit\r"); exited = True; events.append(("exit sent", round(time.time()-t0,1)))
    else:
        failed.append("timed out after 150 s")
    if not answered: failed.append("the clarify menu 'Which file?' never appeared")
    if not exited: failed.append("'Done.' never appeared")
finally:
    # Only processes this run started: its own client child, its scripted server, and the gateway of its own
    # HERMES_HOME (`gateway stop` is scoped by HERMES_HOME). No pattern kill.
    if pid:
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
        for _ in range(50):  # reap our child; SIGKILL it (only it) if it ignores SIGTERM
            try:
                if os.waitpid(pid, os.WNOHANG)[0]: break
            except ChildProcessError: break
            time.sleep(0.1)
        else:
            try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError): pass
    srv.terminate()
    try: srv.wait(timeout=10)
    except subprocess.TimeoutExpired: srv.kill()
    try: subprocess.run([R.HERMES, "gateway", "stop"], env=env, capture_output=True, timeout=60)
    except Exception as e: print("warning: gateway stop failed:", e, file=sys.stderr)
open(os.path.join(R.ROOT, "bench/upstream/work", name + ".pty.txt"), "w").write(strip(buf))
out = os.path.join(R.ROOT, "packages/golden/transcripts/upstream", name + ".json")
print(events)
R.publish_transcript(spath, log, f"{home}/state.db", out, name, failed)
