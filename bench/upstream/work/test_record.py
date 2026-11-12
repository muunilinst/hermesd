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


if __name__ == "__main__":
    unittest.main()
