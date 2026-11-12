"""Pure helpers for bench.py (no Hermes needed; unit-tested by test_benchlib.py)."""
import os
import socket
import struct

WAL_HEADER = 32
FRAME_HEADER = 24


def pct(xs, q):
    """linear-interpolated percentile, q in [0, 1]"""
    if not xs:
        raise ValueError("pct of an empty sample")
    xs = sorted(xs)
    k = (len(xs) - 1) * q
    f = int(k)
    return xs[f] + (xs[min(f + 1, len(xs) - 1)] - xs[f]) * (k - f)


def wal_snapshot(walpath):
    """(salts, frames, commits) of the current WAL generation, or None if there is no usable WAL.

    salts is bytes 16..23 of the -wal header (salt-1, salt-2). SQLite picks new salts every time it
    restarts the WAL after a checkpoint, so two snapshots with different salts belong to different
    generations and their frame counts must not be subtracted. Only frames whose own header carries
    the header's salts are valid frames of this generation."""
    try:
        b = open(walpath, "rb").read()
    except FileNotFoundError:
        return None
    if len(b) < WAL_HEADER:
        return None
    psz = struct.unpack(">I", b[8:12])[0]
    if psz < 512 or psz & (psz - 1):
        return None
    salts = bytes(b[16:24])
    frames = commits = 0
    off = WAL_HEADER
    while off + FRAME_HEADER + psz <= len(b):
        h = b[off:off + FRAME_HEADER]
        if h[8:16] != salts:
            break
        frames += 1
        if struct.unpack(">I", h[4:8])[0] != 0:
            commits += 1
        off += FRAME_HEADER + psz
    return salts, frames, commits


def wal_delta(before, after):
    """{'wal_frames','wal_commit_frames','wal_reset'}: counts are None unless both snapshots are one generation."""
    if before is None or after is None:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": None, "wal_note": "no usable WAL snapshot"}
    if before[0] != after[0]:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": True,
                "wal_note": "WAL salts changed (checkpoint/restart): not comparable"}
    if after[1] < before[1] or after[2] < before[2]:
        return {"wal_frames": None, "wal_commit_frames": None, "wal_reset": None,
                "wal_note": "frame count went down within one salt generation"}
    return {"wal_frames": after[1] - before[1], "wal_commit_frames": after[2] - before[2], "wal_reset": False}


def port_in_use(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def require_ports_free(*ports):
    busy = [p for p in ports if port_in_use(p)]
    if busy:
        raise RuntimeError(f"port(s) {busy} are already in use; refusing to start (and not killing whoever holds them)")


def proc_cmdline(pid):
    try:
        return open(f"/proc/{pid}/cmdline").read().replace("\0", " ")
    except OSError:
        return None


def validate_reply(data, expected):
    """Raise unless `data` is a normal chat completion whose text is exactly `expected`."""
    if not isinstance(data, dict):
        raise ValueError(f"response is not an object: {data!r:.200}")
    if data.get("error"):
        raise ValueError(f"error envelope: {data['error']!r:.300}")
    ch = data.get("choices")
    if not ch or not isinstance(ch, list):
        raise ValueError(f"no choices: {data!r:.300}")
    got = (ch[0].get("message") or {}).get("content")
    if got != expected:
        raise ValueError(f"unexpected reply {got!r}, wanted {expected!r}")
    if ch[0].get("finish_reason") not in (None, "stop"):
        raise ValueError(f"finish_reason {ch[0].get('finish_reason')!r}")
