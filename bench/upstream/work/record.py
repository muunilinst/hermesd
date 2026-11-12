#!/usr/bin/env python3
"""Record one golden script against upstream Hermes (run inside the OrbStack VM).

    python3 record.py <name> [--keep] [--extra-config JSON] [--yolo]

Follows packages/golden/UPSTREAM.md: fresh HERMES_HOME, plugins, config, scripted
server on 8089, inputs through `hermes chat -q` (first) and `hermes chat -c -q` (rest),
then assemble.mjs into transcripts/upstream/<name>.json.
"""
import json, os, shutil, signal, subprocess, sys, time, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
G = os.path.join(ROOT, "packages/golden/scripted-server")
BUN = os.path.expanduser("~/.bun/bin/bun")
HERMES = os.path.expanduser("~/hvenv/bin/hermes")
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
        cfg["model"] = {"default": model, "provider": "scripted"}
    elif mode == "bedrock_converse":
        cfg["model"] = {"default": model, "provider": "bedrock", "api_mode": "bedrock_converse", "streaming": False}
    if script.get("fallback"):
        fb = script["fallback"]
        cfg["fallback_providers"] = [{"provider": "custom", "model": fb["model"],
                                      "base_url": "http://127.0.0.1:8089/v1", "api_key": "x"}]
    return cfg


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
    env = dict(os.environ, HERMES_HOME=home)
    if "--env" in args:
        env.update(json.loads(args[args.index("--env") + 1]))
    cfg = config_for(script)
    if script.get("hooks"):
        out = subprocess.run([BUN, f"{G}/make-plugins.mjs", spath, f"{home}/plugins"], capture_output=True, text=True, check=True).stdout
        plugins = script["hooks"]["plugins"]
        cfg["plugins"] = {"enabled": [p["name"] for p in plugins],
                          "hook_callback_timeout": script["hooks"].get("timeoutMs", 30000) / 1000}
    deep_merge(cfg, extra)
    with open(f"{home}/config.yaml", "w") as f:
        json.dump(cfg, f, indent=2)  # JSON is valid YAML
    log = f"{home}/requests.jsonl"
    srv = subprocess.Popen([BUN, f"{G}/server.mjs", spath, "--port", "8089", "--log", log],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    srv.stdout.readline()
    inputs = [json.loads(l) for l in subprocess.run([BUN, f"{G}/inputs.mjs", spath], capture_output=True, text=True, check=True).stdout.splitlines()]
    transcript = []
    try:
        for i, inp in enumerate(inputs):
            cmd = [HERMES, "chat"] + (["-c"] if i else []) + ["-q", inp["send"]] + (["--yolo"] if yolo else [])
            t0 = time.time()
            p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=home)
            if inp.get("interrupt"):
                # wait for the trigger, then SIGINT (stands in for Ctrl-C)
                n0 = sum(1 for _ in open(log)) if os.path.exists(log) else 0
                deadline = time.time() + 120
                while time.time() < deadline and p.poll() is None:
                    n = sum(1 for _ in open(log)) if os.path.exists(log) else 0
                    if inp["interrupt"] == "model_call" and n > n0:
                        break
                    if inp["interrupt"] == "tool_running" and subprocess.run(["pgrep", "-f", "sleep 60"], capture_output=True).returncode == 0:
                        break
                    time.sleep(0.2)
                time.sleep(0.5)
                p.send_signal(signal.SIGINT)
                transcript.append({"input": i, "event": "SIGINT sent", "at": round(time.time() - t0, 2)})
                if inp["interrupt"] == "model_call":
                    time.sleep(1)
                    for hold in {s["hold"] for s in script["steps"] if s.get("hold")}:
                        try:
                            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:8089/__release/{hold}", method="POST"), timeout=5).read()
                        except Exception as e:
                            transcript.append({"release_error": str(e)})
            try:
                out, _ = p.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                p.kill()
                out, _ = p.communicate()
            transcript.append({"input": i, "cmd": cmd[1:], "rc": p.returncode, "secs": round(time.time() - t0, 2), "out": out[-3000:]})
    finally:
        srv.terminate()
        subprocess.run(["pkill", "-f", f"HERMES_HOME={home}"], capture_output=True)
        # stop the gateway hermes chat spawned for this home
        subprocess.run([HERMES, "gateway", "stop"], env=env, capture_output=True, timeout=60)
        subprocess.run(["pkill", "-f", "gateway run"], capture_output=True)
        time.sleep(1)
    json.dump(transcript, open(f"{home}/driver.json", "w"), indent=2)
    shutil.copy(f"{home}/driver.json", os.path.join(ROOT, "bench/upstream/work", name + ".driver.json"))
    out = os.path.join(ROOT, "packages/golden/transcripts/upstream", name + ".json")
    r = subprocess.run([BUN, f"{G}/assemble.mjs", spath, "--log", log, "--db", f"{home}/state.db", "--out", out], capture_output=True, text=True)
    print(r.stdout + r.stderr)
    for t in transcript:
        print(json.dumps({k: v for k, v in t.items() if k != "out"}), "\n", t.get("out", "")[-800:])


if __name__ == "__main__":
    main()
