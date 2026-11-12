import os, struct, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchlib as B

PSZ = 512


def wal(salts, frames):
    """synthetic WAL: header + frames; frames = [(commit_size, salts_or_None)]"""
    hdr = struct.pack(">IIIIII", 0x377F0682, 3007000, PSZ, 1, 0, 0)[:16] + salts + b"\0" * 8
    out = bytearray(hdr)
    for commit, s in frames:
        out += struct.pack(">II", 1, commit) + (s or salts) + b"\0" * 8 + b"\0" * PSZ
    return bytes(out)


class T(unittest.TestCase):
    def write(self, b):
        f = tempfile.NamedTemporaryFile(delete=False); f.write(b); f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_snapshot_counts_and_stops_at_foreign_salts(self):
        s = b"\x01\x02\x03\x04\x05\x06\x07\x08"
        p = self.write(wal(s, [(0, None), (2, None), (0, None), (3, b"\xff" * 8)]))
        self.assertEqual(B.wal_snapshot(p), (s, 3, 1))

    def test_missing_and_short(self):
        self.assertIsNone(B.wal_snapshot("/nonexistent/x-wal"))
        self.assertIsNone(B.wal_snapshot(self.write(b"\0" * 10)))

    def test_delta_same_generation(self):
        s = b"A" * 8
        d = B.wal_delta((s, 2, 1), (s, 7, 3))
        self.assertEqual((d["wal_frames"], d["wal_commit_frames"], d["wal_reset"]), (5, 2, False))

    def test_delta_reset_is_not_subtracted_even_if_count_grew(self):
        d = B.wal_delta((b"A" * 8, 2, 1), (b"B" * 8, 9, 4))
        self.assertIsNone(d["wal_frames"]); self.assertTrue(d["wal_reset"])

    def test_delta_none(self):
        self.assertIsNone(B.wal_delta(None, (b"A" * 8, 1, 1))["wal_frames"])

    def test_pct(self):
        xs = list(range(1, 21))
        self.assertAlmostEqual(B.pct(xs, 0.5), 10.5)
        self.assertAlmostEqual(B.pct(xs, 0.95), 19.05)
        self.assertEqual(B.pct([4.0], 0.95), 4.0)
        with self.assertRaises(ValueError): B.pct([], 0.5)

    def test_validate_reply(self):
        ok = {"choices": [{"message": {"content": "Hello 3!"}, "finish_reason": "stop"}]}
        B.validate_reply(ok, "Hello 3!")
        for bad in ({"error": {"message": "x"}}, {"choices": []}, ok, "str"):
            with self.assertRaises(ValueError): B.validate_reply(bad, "Hello 4!")
        with self.assertRaises(ValueError): B.validate_reply({**ok, "error": {"m": 1}}, "Hello 3!")

    # ---- recording helpers
    def test_validate_fixture_file(self):
        import json
        good = {"format": "hermesd-golden/1", "side": "upstream", "script": "x", "requests": [{}], "rows": {"messages": [{}], "admissions": []}}
        def w(d): return self.write(json.dumps(d).encode())
        B.validate_fixture_file(w(good), "x")
        for bad in ({**good, "script": "y"}, {**good, "side": "port"}, {**good, "format": "v0"}, {**good, "requests": []},
                    {**good, "rows": {"messages": [], "admissions": []}}, []):
            with self.assertRaises(ValueError): B.validate_fixture_file(w(bad), "x")
        with self.assertRaises(ValueError): B.validate_fixture_file(self.write(b"not json"), "x")
        with self.assertRaises(ValueError): B.validate_fixture_file("/nonexistent.json", "x")

    def test_capture_failures(self):
        inputs = [{"send": "a"}, {"send": "b", "interrupt": "model_call"}]
        ok = [{"input": 0, "cmd": [], "rc": 0}, {"input": 1, "cmd": [], "rc": 130}]
        self.assertEqual(B.capture_failures(ok, inputs), [])
        self.assertTrue(B.capture_failures([{"input": 0, "cmd": [], "rc": 2}, ok[1]], inputs))
        self.assertTrue(B.capture_failures([{"input": 0, "cmd": [], "rc": 0, "timed_out": True}, ok[1]], inputs))
        self.assertTrue(B.capture_failures(ok[:1], inputs), "an input that never ran")

    def test_tool_trigger_needs_a_new_process_of_this_home(self):
        procs = {10: (1, "hermes gateway"), 11: (10, "sleep 60"), 20: (1, "other gw"), 21: (20, "sleep 60"), 30: (10, "sleep 600")}
        home = lambda pid: {10: "/h", 20: "/other"}.get(pid)
        self.assertEqual(B.find_tool_trigger(procs, {21}, home, "/h"), 11)
        self.assertIsNone(B.find_tool_trigger(procs, {11, 21}, home, "/h"), "pre-existing sleep 60 is not this turn")
        self.assertIsNone(B.find_tool_trigger({21: (20, "sleep 60"), 20: (1, "x")}, set(), home, "/h"), "another home's sleep")

    def test_trigger_observed(self):
        self.assertFalse(B.trigger_observed("model_call", 3, 3, None))
        self.assertTrue(B.trigger_observed("model_call", 3, 4, None))
        self.assertFalse(B.trigger_observed("tool_running", 3, 3, 99))
        self.assertFalse(B.trigger_observed("tool_running", 3, 4, None))
        self.assertTrue(B.trigger_observed("tool_running", 3, 4, 99))

    # ---- strace and retry outcomes
    def test_parse_strace_unavailable_is_none_not_zeros(self):
        self.assertIsNone(B.parse_strace("/nonexistent/strace.log"))
        self.assertIsNone(B.parse_strace(self.write(b"\n")))
        p = self.write(b'1 write(3</h/state.db-wal>, "x", 1) = 1\n1 fsync(3</h/state.db-wal>) = 0\n1 pwrite64(4</h/state.db>, "", 0, 0) = 0\n')
        self.assertEqual(B.parse_strace(p), {"wal_writes": 1, "wal_fsyncs": 1, "db_writes": 1, "db_fsyncs": 0})
        self.assertEqual(B.parse_strace(self.write(b"1 write(1</dev/null>, ) = 1\n")), {"wal_writes": 0, "wal_fsyncs": 0, "db_writes": 0, "db_fsyncs": 0})

    def test_strace_problem(self):
        good = self.write(b"1 write(3</x>) = 1\n")
        self.assertIsNone(B.strace_problem("", None, good))
        self.assertIn("early", B.strace_problem("", 1, good))
        self.assertIn("strace reported", B.strace_problem("strace: attach: ptrace(PTRACE_SEIZE, 5): Operation not permitted", None, good))
        self.assertIn("no output", B.strace_problem("", None, self.write(b"")))
        self.assertIn("no output", B.strace_problem("", None, "/nonexistent/t.log"))

    def test_request_outcome_distinguishes_response_from_timeout(self):
        self.assertEqual(B.request_outcome({"reply": "x"}), "http_response")
        self.assertEqual(B.request_outcome({"http_status": 500, "error": "e"}), "http_response")
        self.assertEqual(B.request_outcome({"timeout": True, "error": "e"}), "observation_timeout")
        self.assertEqual(B.request_outcome({"error": "refused"}), "client_error")
        self.assertEqual(B.request_outcome({}), "no_response")


if __name__ == "__main__":
    unittest.main()
