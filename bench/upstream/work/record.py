#!/usr/bin/env python3
"""Record one golden script against upstream Hermes (run inside the OrbStack VM).

    python3 record.py <name> [--keep] [--extra-config JSON] [--yolo]

Follows packages/golden/UPSTREAM.md: fresh HERMES_HOME, plugins, config, scripted
server on 8089, inputs through `hermes chat -q` (first) and `hermes chat -c -q` (rest),
then assemble.mjs into transcripts/upstream/<name>.json.
"""
import json, os, shutil, signal, socket, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchlib import (capture_failures, count_lines, find_tool_trigger, proc_cmdline, trigger_observed,
                      validate_fixture_file)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
G = os.path.join(ROOT, "packages/golden/scripted-server")
BUN = os.path.expanduser("~/.bun/bin/bun")
HERMES = os.path.expanduser("~/hvenv/bin/hermes")
PORT = 8089
LOCAL = f"http://127.0.0.1:{PORT}"
# context window written for scripts that do not set one: large enough to skip Hermes' context probe and
# above its 64K floor; compaction scripts override it through --extra-config.
BEDROCK_CONTEXT = 200000
DEFAULT_MODEL = {
    "chat_completions": "gpt-4o",
    "anthropic_messages": "claude-sonnet-4-5",
    "codex_responses": "gpt-5-codex",
    "bedrock_converse": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
}


def deep_merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep_merge(a[k], v)
        else:
            a[k] = v
    return a


def config_for(script):
    mode = script.get("mode", "chat_completions")
    model = script.get("model") or DEFAULT_MODEL[mode]
    cfg = {"_config_version": 52, "auxiliary": {"title_generation": {"enabled": False}}}
    if mode == "chat_completions":
        cfg["model"] = {"default": model, "provider": "custom", "base_url": "http://127.0.0.1:8089/v1",
                        "api_key": "x", "streaming": bool(script.get("stream"))}
    elif mode in ("anthropic_messages", "codex_responses"):
        base = "http://127.0.0.1:8089" if mode == "anthropic_messages" else "http://127.0.0.1:8089/v1"
        cfg["providers"] = {"scripted": {"base_url": base, "api_mode": mode, "model": model, "api_key": "x"}}
        # UPSTREAM.md "What changed after the first run" 5: named providers need api_key and streaming:false
        # (codex_responses streams anyway).
        cfg["model"] = {"default": model, "provider": "scripted", "api_key": "x", "streaming": False}
    elif mode == "bedrock_converse":
        # UPSTREAM.md 6: context_length skips the context probe; the endpoint and token are environment (see env_for)
        cfg["model"] = {"default": model, "provider": "bedrock", "api_mode": "bedrock_converse", "streaming": False,
                        "context_length": BEDROCK_CONTEXT}
    if script.get("fallback"):
        fb = script["fallback"]
        cfg["fallback_providers"] = [{"provider": "custom", "model": fb["model"],
                                      "base_url": "http://127.0.0.1:8089/v1", "api_key": "x"}]
    return cfg


def env_for(home, script, extra_env=None):
    """Environment for Hermes. Bedrock is pinned to the scripted server (UPSTREAM.md 6): endpoint override and
    bearer token. Ambient AWS credentials/profile are removed so nothing can sign a request for real Bedrock."""
    env = dict(os.environ, HERMES_HOME=home)
    if script.get("mode", "chat_completions") == "bedrock_converse":
        for k in list(env):
            if k.startswith("AWS_") or k in ("BEDROCK_API_KEY",):
                del env[k]
        env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"] = LOCAL
        env["AWS_BEARER_TOKEN_BEDROCK"] = "x"
        env["AWS_REGION"] = env["AWS_DEFAULT_REGION"] = "us-east-1"
    env.update(extra_env or {})
    return env


def check_settings(script, cfg, env):
    """Refuse to launch Hermes unless the documented settings are in force. Raises SystemExit."""
    mode = script.get("mode", "chat_completions")
    problems = []
    if mode == "bedrock_converse":
        if env.get("AWS_ENDPOINT_URL_BEDROCK_RUNTIME") != LOCAL:
            problems.append(f"AWS_ENDPOINT_URL_BEDROCK_RUNTIME must be {LOCAL} (got {env.get('AWS_ENDPOINT_URL_BEDROCK_RUNTIME')!r}); refusing to risk the real Bedrock endpoint")
        if not env.get("AWS_BEARER_TOKEN_BEDROCK"):
            problems.append("AWS_BEARER_TOKEN_BEDROCK is not set")
        for k in ("AWS_ENDPOINT_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN"):
            if env.get(k): problems.append(f"{k} is set; it could redirect or sign requests")
        if not isinstance(cfg.get("model", {}).get("context_length"), int):
            problems.append("model.context_length is not set")
    if mode in ("anthropic_messages", "codex_responses", "bedrock_converse") and cfg["model"].get("streaming") is not False:
        problems.append("model.streaming must be false for named providers")
    if mode in ("anthropic_messages", "codex_responses"):
        if not all(str(p.get("base_url", "")).startswith(LOCAL) for p in cfg["providers"].values()):
            problems.append("provider base_url is not the scripted server")
    if problems:
        raise SystemExit("record.py: refusing to start:\n  - " + "\n  - ".join(problems))


def port_busy():
    s = socket.socket(); s.settimeout(1)
    try: return s.connect_ex(("127.0.0.1", PORT)) == 0
    finally: s.close()


def stop_home_gateway(env):
    """stop the gateway `hermes chat` auto-started for THIS HERMES_HOME only (never pkill by name)"""
    subprocess.run([HERMES, "gateway", "stop"], env=env, capture_output=True, timeout=60)


def list_procs():
    """{pid: (ppid, cmdline)} of every process (Linux /proc)"""
    out = {}
    for d in os.listdir("/proc"):
        if not d.isdigit(): continue
        try:
            stat = open(f"/proc/{d}/stat").read()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        cmd = proc_cmdline(int(d))
        if cmd is not None: out[int(d)] = (ppid, cmd)
    return out


def home_of(pid):
    """HERMES_HOME in the environment of `pid`, or None (unreadable/gone)"""
    try:
        for kv in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
            if kv.startswith(b"HERMES_HOME="): return kv[len(b"HERMES_HOME="):].decode()
    except OSError:
        pass
    return None


def wait_for_trigger(kind, p, log, n0, before, home, timeout=120):
    """Block until the interrupt trigger of the current turn is observed. False if it never was (or the client ended)."""
    deadline = time.time() + timeout
    while time.time() < deadline and p.poll() is None:
        n = count_lines(log)
        pid = None
        if kind == "tool_running" and n > n0:
            pid = find_tool_trigger(list_procs(), before, home_of, home)
        if trigger_observed(kind, n0, n, pid):
            return True
        time.sleep(0.2)
    return False


def main():
    args = sys.argv[1:]
    name = args[0]
    extra = {}
    if "--extra-config" in args:
        extra = json.loads(args[args.index("--extra-config") + 1])
    yolo = "--yolo" in args
    spath = os.path.join(ROOT, "packages/golden/scripts", name + ".json")
    script = json.load(open(spath))
    home = os.path.expanduser(f"~/hh/{name}")
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    cfg = config_for(script)
    env = env_for(home, script, json.loads(args[args.index("--env") + 1]) if "--env" in args else None)
    if script.get("hooks"):
        out = subprocess.run([BUN, f"{G}/make-plugins.mjs", spath, f"{home}/plugins"], capture_output=True, text=True, check=True).stdout
        plugins = script["hooks"]["plugins"]
        cfg["plugins"] = {"enabled": [p["name"] for p in plugins],
                          "hook_callback_timeout": script["hooks"].get("timeoutMs", 30000) / 1000}
    deep_merge(cfg, extra)
    check_settings(script, cfg, env)
    if port_busy():
        raise SystemExit(f"record.py: port {PORT} is already in use; refusing to start (not killing whoever holds it)")
    with open(f"{home}/config.yaml", "w") as f:
        json.dump(cfg, f, indent=2)  # JSON is valid YAML
    log = f"{home}/requests.jsonl"
    srv = subprocess.Popen([BUN, f"{G}/server.mjs", spath, "--port", str(PORT), "--log", log],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    first = srv.stdout.readline()
    if '"listening"' not in first:
        srv.kill()
        raise SystemExit("record.py: scripted server did not start: " + first)
    inputs = [json.loads(l) for l in subprocess.run([BUN, f"{G}/inputs.mjs", spath], capture_output=True, text=True, check=True).stdout.splitlines()]
    transcript = []
    failed = []
    try:
        for i, inp in enumerate(inputs):
            cmd = [HERMES, "chat"] + (["-c"] if i else []) + ["-q", inp["send"]] + (["--yolo"] if yolo else [])
            # snapshot BEFORE the client exists, so a fast request or an earlier process cannot be mistaken for this turn
            n0 = count_lines(log)
            before = set(list_procs())
            t0 = time.time()
            p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=home)
            aborted = False
            if inp.get("interrupt"):
                seen = wait_for_trigger(inp["interrupt"], p, log, n0, before, home)
                if not seen:
                    # never interrupt a turn whose trigger was not observed: the capture would be meaningless
                    failed.append(f"input {i}: interrupt trigger {inp['interrupt']!r} never observed; aborting")
                    p.kill(); aborted = True
                else:
                    time.sleep(0.5)
                    p.send_signal(signal.SIGINT)
                    transcript.append({"input": i, "event": "SIGINT sent", "at": round(time.time() - t0, 2)})
                if seen and inp["interrupt"] == "model_call":
                    time.sleep(1)
                    for hold in {s["hold"] for s in script["steps"] if s.get("hold")}:
                        try:
                            urllib.request.urlopen(urllib.request.Request(f"{LOCAL}/__release/{hold}", method="POST"), timeout=5).read()
                        except Exception as e:
                            transcript.append({"release_error": str(e)})
                            failed.append(f"input {i}: releasing hold {hold!r} failed: {e}")
            timed_out = False
            try:
                out, _ = p.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                p.kill(); timed_out = True
                out, _ = p.communicate()
            transcript.append({"input": i, "cmd": cmd[1:], "rc": p.returncode, "timed_out": timed_out,
                               "secs": round(time.time() - t0, 2), "out": out[-3000:]})
            if aborted:
                break
    finally:
        srv.terminate()
        # stop the gateway hermes chat spawned for this home (and only that one)
        try: stop_home_gateway(env)
        except Exception as e: print("warning: gateway stop failed:", e, file=sys.stderr)
        try: srv.wait(timeout=10)
        except subprocess.TimeoutExpired: srv.kill()
        time.sleep(1)
    failed += capture_failures(transcript, inputs)
    json.dump(transcript, open(f"{home}/driver.json", "w"), indent=2)
    # A failed capture keeps its driver log under a separate name, so the checked-in log of the last good run stays.
    shutil.copy(f"{home}/driver.json", os.path.join(ROOT, "bench/upstream/work", name + (".failed" if failed else "") + ".driver.json"))
    out = os.path.join(ROOT, "packages/golden/transcripts/upstream", name + ".json")
    for t in transcript:
        print(json.dumps({k: v for k, v in t.items() if k != "out"}), "\n", t.get("out", "")[-800:])
    publish_transcript(spath, log, f"{home}/state.db", out, name, failed)


def publish_transcript(spath, log, db, out, name, failed):
    """Assemble into a temporary file next to `out`, validate it, and only then atomically replace the canonical
    fixture. A capture that already failed (nonzero exit, timeout, missed trigger) never replaces anything."""
    if failed:
        raise SystemExit(f"record.py {name}: FAILED (fixture not written): " + "; ".join(failed))
    tmp = os.path.join(os.path.dirname(out), f".{name}.json.tmp")
    try:
        r = subprocess.run([BUN, f"{G}/assemble.mjs", spath, "--log", log, "--db", db, "--out", tmp], capture_output=True, text=True)
        print(r.stdout + r.stderr)
        if r.returncode != 0 or not os.path.exists(tmp):
            raise SystemExit(f"record.py {name}: FAILED (fixture not written): assemble.mjs exited {r.returncode}")
        try: validate_fixture_file(tmp, name)
        except ValueError as e: raise SystemExit(f"record.py {name}: FAILED (fixture not written): {e}")
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
