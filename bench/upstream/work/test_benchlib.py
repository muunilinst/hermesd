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
        good = {"format": "hermesd-golden/1", "side": "upstream", "script": "x", "requests": [{}], "rows": {"messages": [{}], "admissions": [{}]}}
        def w(d): return self.write(json.dumps(d).encode())
        B.validate_fixture_file(w(good), "x")
        for bad in ({**good, "script": "y"}, {**good, "side": "port"}, {**good, "format": "v0"}, {**good, "requests": []},
                    {**good, "rows": {"messages": [], "admissions": [{}]}},
                    {**good, "rows": {"messages": [{}], "admissions": []}}, []):
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


class Safety(unittest.TestCase):
    def test_scenario_names(self):
        known = ["plain-reply", "one-tool-call"]
        self.assertEqual(B.check_scenario_name("plain-reply", known), "plain-reply")
        for bad in ("../x", "a/b", "", "-x", "Plain", "a.b", "unknown-one", "x" * 80, None, "a b"):
            with self.assertRaises(ValueError, msg=repr(bad)): B.check_scenario_name(bad, known)
        self.assertEqual(B.check_scenario_name("any-ok"), "any-ok")

    def test_local_endpoint(self):
        for ok in ("http://127.0.0.1:8089", "http://127.0.0.1:8089/v1", "http://localhost:8089/", "http://[::1]:8089/v1"):
            B.validate_local_endpoint(ok, 8089)
        for bad in ("http://127.0.0.1:8089@remote.example/v1", "http://u:p@127.0.0.1:8089/", "http://127.0.0.1@remote.example:8089/",
                    "https://127.0.0.1:8089", "http://127.0.0.1", "http://127.0.0.1:8090", "http://127.0.0.1.evil.example:8089",
                    "http://127.0.0.1:8089\\@remote.example", "http://remote.example:8089", "http://127.0.0.1:abc", "", None, "ftp://127.0.0.1:8089"):
            with self.assertRaises(ValueError, msg=repr(bad)): B.validate_local_endpoint(bad, 8089)

    def test_rundirs_remove_only_own(self):
        base = tempfile.mkdtemp(); self.addCleanup(__import__("shutil").rmtree, base, True)
        other = os.path.join(base, "plain-reply"); os.makedirs(other); open(other + "/keep", "w").write("x")
        d = B.RunDirs(base)
        a, b = d.make("plain-reply"), d.make("plain-reply")
        self.assertNotEqual(a, b); self.assertNotEqual(a, other)
        open(a + "/f", "w").write("y")
        d.cleanup()
        self.assertFalse(os.path.exists(a)); self.assertFalse(os.path.exists(b))
        self.assertTrue(os.path.exists(other + "/keep"))

    def test_rundirs_keep(self):
        base = tempfile.mkdtemp(); self.addCleanup(__import__("shutil").rmtree, base, True)
        d = B.RunDirs(base, keep=True); a = d.make("x"); d.cleanup()
        self.assertTrue(os.path.isdir(a))

    def test_rundirs_unmounts_only_recorded_and_skips_stuck(self):
        base = tempfile.mkdtemp(); self.addCleanup(__import__("shutil").rmtree, base, True)
        calls = []
        d = B.RunDirs(base, umount=lambda p: calls.append(p) or False)
        a = d.make("m"); d.record_mount(a)
        d.cleanup()
        self.assertEqual(calls, [a])
        self.assertTrue(os.path.isdir(a), "a directory whose unmount failed must not be deleted")
        d2 = B.RunDirs(base, umount=lambda p: calls.append(p) or True)
        c = d2.make("n"); d2.record_mount(c); d2.cleanup()
        self.assertFalse(os.path.exists(c)); self.assertEqual(calls[-1], c)

    def test_remaining_time(self):
        self.assertEqual(B.remaining_time(10, 4), 6)
        with self.assertRaises(TimeoutError): B.remaining_time(10, 10)

    def test_request_delta(self):
        B.check_request_delta("t", 4, 6, 2)
        with self.assertRaises(RuntimeError): B.check_request_delta("t", 4, 8, 2)

    def test_retry_exit_code(self):
        self.assertEqual(B.retry_exit_code({"valid": True}), 0)
        self.assertEqual(B.retry_exit_code({"valid": False}), 1)
        self.assertEqual(B.retry_exit_code({}), 1)

    def test_validate_reply_requires_ok(self):
        B.validate_reply({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}, "ok")
        with self.assertRaises(ValueError): B.validate_reply({"choices": [{"message": {"content": "hi"}}]}, "ok")


GOOD = {"format": "hermesd-golden/1", "side": "upstream", "script": "s", "requests": [{}],
        "rows": {"messages": [{"role": "user"}], "admissions": [{"status": "x"}]}}


class Fixture(unittest.TestCase):
    def test_validator_matches_ts_rules(self):
        self.assertEqual(B.validate_fixture_data(GOOD, "s"), [])
        import copy
        for mut, frag in ((lambda r: r.update(requests=[]), "no requests"),
                          (lambda r: r["rows"].update(admissions=[]), "no admissions"),
                          (lambda r: r["rows"].update(messages=[]), "no messages"),
                          (lambda r: r.update(rows=None), "no messages"),
                          (lambda r: r.update(side="port"), "side"),
                          (lambda r: r.update(script="t"), "script"),
                          (lambda r: r.update(format="x"), "format")):
            r = copy.deepcopy(GOOD); mut(r)
            self.assertTrue(any(frag in p for p in B.validate_fixture_data(r, "s")), frag)
        self.assertTrue(B.validate_fixture_data([], "s"))

    def test_commit_validated_is_atomic(self):
        import json
        d = tempfile.mkdtemp(); self.addCleanup(__import__("shutil").rmtree, d, True)
        out = os.path.join(d, "s.json"); open(out, "w").write("OLD")
        tmp = os.path.join(d, ".s.json.tmp")
        bad = dict(GOOD, rows={"messages": [{}], "admissions": []}); json.dump(bad, open(tmp, "w"))
        with self.assertRaises(ValueError): B.commit_validated(tmp, out, "s")
        self.assertEqual(open(out).read(), "OLD")
        json.dump(GOOD, open(tmp, "w")); B.commit_validated(tmp, out, "s")
        self.assertEqual(json.load(open(out))["script"], "s"); self.assertFalse(os.path.exists(tmp))

    def test_pre_tool_failure(self):
        import copy
        pre = copy.deepcopy(GOOD)
        self.assertTrue(B.pre_tool_failure(pre))
        post = copy.deepcopy(GOOD); post["rows"]["messages"].append({"role": "tool"})
        self.assertFalse(B.pre_tool_failure(post))
        two = copy.deepcopy(GOOD); two["requests"].append({})
        self.assertFalse(B.pre_tool_failure(two))
        self.assertFalse(B.pre_tool_failure(None))

    def test_checked_in_persistence_fixture_status(self):
        # documents the current canonical fixture: it does NOT show a pre-tool failure (a tool row exists)
        import json
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "packages/golden/transcripts/upstream/persistence-failure-before-tool.json")
        if os.path.exists(p):
            self.assertEqual(B.validate_fixture_data(json.load(open(p)), "persistence-failure-before-tool"), [])


if __name__ == "__main__":
    unittest.main()
