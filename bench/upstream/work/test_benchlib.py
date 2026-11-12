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


if __name__ == "__main__":
    unittest.main()
