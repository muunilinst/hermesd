import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record as R


class T(unittest.TestCase):
    def bedrock(self):
        return {"mode": "bedrock_converse"}

    def test_bedrock_pinned_to_local_server_and_ambient_aws_removed(self):
        os.environ.update(AWS_PROFILE="prod", AWS_ACCESS_KEY_ID="AKIA", AWS_ENDPOINT_URL="https://evil")
        env = R.env_for("/h", self.bedrock())
        self.assertEqual(env["AWS_ENDPOINT_URL_BEDROCK_RUNTIME"], R.LOCAL)
        self.assertEqual(env["AWS_BEARER_TOKEN_BEDROCK"], "x")
        for k in ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL"):
            self.assertNotIn(k, env)
        cfg = R.config_for(self.bedrock())
        self.assertEqual(cfg["model"]["context_length"], R.BEDROCK_CONTEXT)
        R.check_settings(self.bedrock(), cfg, env)

    def test_refuses_overridden_endpoint(self):
        env = R.env_for("/h", self.bedrock(), {"AWS_ENDPOINT_URL_BEDROCK_RUNTIME": "https://bedrock-runtime.us-east-1.amazonaws.com"})
        with self.assertRaises(SystemExit): R.check_settings(self.bedrock(), R.config_for(self.bedrock()), env)

    def test_refuses_missing_context_or_streaming(self):
        env = R.env_for("/h", self.bedrock()); cfg = R.config_for(self.bedrock())
        del cfg["model"]["context_length"]
        with self.assertRaises(SystemExit): R.check_settings(self.bedrock(), cfg, env)
        cfg = R.config_for({"mode": "anthropic_messages"}); cfg["model"]["streaming"] = True
        with self.assertRaises(SystemExit): R.check_settings({"mode": "anthropic_messages"}, cfg, R.env_for("/h", {}))

    def test_anthropic_non_streaming(self):
        cfg = R.config_for({"mode": "anthropic_messages"})
        self.assertIs(cfg["model"]["streaming"], False)
        R.check_settings({"mode": "anthropic_messages"}, cfg, R.env_for("/h", {}))

    def test_publish_does_not_replace_fixture_when_capture_failed(self):
        import tempfile
        d = tempfile.mkdtemp(); out = os.path.join(d, "x.json"); open(out, "w").write("OLD")
        with self.assertRaises(SystemExit): R.publish_transcript("s.json", "log", "db", out, "x", ["input 0: hermes chat exited 1"])
        self.assertEqual(open(out).read(), "OLD")
        self.assertEqual(os.listdir(d), ["x.json"])

    def test_publish_validates_before_replacing(self):
        import json, tempfile, unittest.mock as mock
        d = tempfile.mkdtemp(); out = os.path.join(d, "x.json"); open(out, "w").write("OLD")
        def fake_run(cmd, **kw):
            tmp = cmd[cmd.index("--out") + 1]
            json.dump(self.content, open(tmp, "w"))
            return mock.Mock(returncode=0, stdout="", stderr="")
        good = {"format": "hermesd-golden/1", "side": "upstream", "script": "x", "requests": [{}], "rows": {"messages": [{}], "admissions": [{}]}}
        with mock.patch.object(R.subprocess, "run", fake_run):
            self.content = {**good, "requests": []}
            with self.assertRaises(SystemExit): R.publish_transcript("s", "l", "d", out, "x", [])
            self.assertEqual(open(out).read(), "OLD"); self.assertEqual(os.listdir(d), ["x.json"])
            self.content = {**good, "rows": {"messages": [{}], "admissions": []}}
            with self.assertRaises(SystemExit): R.publish_transcript("s", "l", "d", out, "x", [])
            self.assertEqual(open(out).read(), "OLD"); self.assertEqual(os.listdir(d), ["x.json"])
            self.content = good
            R.publish_transcript("s", "l", "d", out, "x", [])
            self.assertEqual(json.load(open(out))["script"], "x"); self.assertEqual(os.listdir(d), ["x.json"])

    def test_publish_assembler_failure_keeps_fixture(self):
        import tempfile, unittest.mock as mock
        d = tempfile.mkdtemp(); out = os.path.join(d, "x.json"); open(out, "w").write("OLD")
        with mock.patch.object(R.subprocess, "run", lambda *a, **k: mock.Mock(returncode=1, stdout="", stderr="boom")):
            with self.assertRaises(SystemExit): R.publish_transcript("s", "l", "d", out, "x", [])
        self.assertEqual(open(out).read(), "OLD")

    def test_env_cannot_redirect_hermes_home(self):
        with self.assertRaises(SystemExit): R.env_for("/h", {}, {"HERMES_HOME": "/other"})
        self.assertEqual(R.env_for("/h", {}, {"HERMES_HOME": "/h", "X": "1"})["HERMES_HOME"], "/h")
        self.assertEqual(R.env_for("/h", {}, {"X": "1"})["HERMES_HOME"], "/h")

    def test_refuses_userinfo_and_remote_base_url(self):
        for url in ("http://127.0.0.1:8089@remote.example/v1", "https://127.0.0.1:8089/v1",
                    "http://remote.example:8089/v1", "http://127.0.0.1:9/v1"):
            cfg = R.config_for({}); cfg["model"]["base_url"] = url
            with self.assertRaises(SystemExit, msg=url): R.check_settings({}, cfg, R.env_for("/h", {}))
        cfg = R.config_for({})
        R.check_settings({}, cfg, R.env_for("/h", {}))

    def test_refuses_remote_fallback_url(self):
        s = {"fallback": {"model": "m"}}
        cfg = R.config_for(s); cfg["fallback_providers"][0]["base_url"] = "http://evil.example:8089/v1"
        with self.assertRaises(SystemExit): R.check_settings(s, cfg, R.env_for("/h", s))


if __name__ == "__main__":
    unittest.main()
