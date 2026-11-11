#!/usr/bin/env bun
/**
 * The shared driver of the verify skills. Runs on bun (default) or node >= 22.18.
 *
 *   bun .claude/skills/verify/verify.ts doctor
 *   bun .claude/skills/verify/verify.ts list
 *   bun .claude/skills/verify/verify.ts run <subsystem|all> [--rt bun|node] [--linux]
 *   bun .claude/skills/verify/verify.ts clean
 *
 * `run` writes its evidence to .verify/evidence/<stamp>-<subsystem>-<rt>/ and
 * its scratch files to .verify/tmp/. `clean` removes the scratch files only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE = join(ROOT, ".verify/evidence");
const TMP = join(ROOT, ".verify/tmp");
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
const LINUX_IMAGE = `oven/bun:${readFileSync(join(ROOT, ".bun-version"), "utf8").trim()}`;

type Runtime = "bun" | "node";

/** One real command a person would type, and what it must leave behind. */
interface Drive {
  name: string;
  /** Arguments after the runtime, relative to the repository root. `$TMP` is the scratch directory. */
  args: string[];
  env?: Record<string, string>;
  linuxOnly?: boolean;
  /** Return an error text if the side effect is missing. `out` is stdout only: runtimes print warnings on stderr. */
  check?: (out: string, tmp: string) => string | undefined;
}

interface Subsystem {
  guide: string;
  what: string;
  /** Directories or files that hold `*.test.ts`. */
  tests: string[];
  drives: Drive[];
}

/** Test files that need Linux: /proc, a kernel boot ID, process groups as units. */
const LINUX_ONLY = ["packages/guest-helper/src/shim.test.ts", "packages/guest-helper/src/units.test.ts", "packages/faults/src/guest/"];

const GOLDEN = "packages/golden/src/cli.ts";
const STATE = "packages/state-port/src/cli.ts";
const GUEST = "packages/guest-helper/src/cli.ts";

const sameLines = (n: number) => (out: string) => {
  const same = out.split("\n").filter((l) => l.startsWith("same ")).length;
  return same === n && !out.includes("DIFFERS") ? undefined : `expected ${n} "same" lines and no DIFFERS, got ${same}`;
};
const cleanTree = (path: string) => () => {
  const s = sh("git", ["status", "--porcelain", "--", path]).out.trim();
  return s === "" ? undefined : `the drive changed committed files:\n${s}`;
};
const both = (...fs: Array<(out: string, tmp: string) => string | undefined>) => (out: string, tmp: string) =>
  fs.map((f) => f(out, tmp)).find((e) => e !== undefined);

const SUBSYSTEMS: Record<string, Subsystem> = {
  contracts: {
    guide: "7.1, 2.4",
    what: "the extracted upstream surfaces match the pin, and every table has a decision",
    tests: ["packages/contracts/src"],
    drives: [],
  },
  hosts: {
    guide: "4.6, 6.8",
    what: "the Host adapters (node simulator, workerd, rivetkit) and the wake, outbox, inbox and sweeper rules",
    tests: ["packages/host-node/src", "packages/host-cloudflare/src", "packages/host-rivet/src", "packages/runtime/src", "packages/faults/src/actor"],
    drives: [],
  },
  executor: {
    guide: "3.4",
    what: "derived operation IDs, the executor cell model, the VM lifecycle, the guest launch journal and claim file",
    tests: ["packages/executor-protocol/src", "packages/executor-model/src", "packages/guest-helper/src", "packages/faults/src/guest", "packages/faults/src/model-backend.test.ts", "packages/faults/src/catalogue.test.ts"],
    drives: [
      {
        name: "guest-handshake",
        args: [GUEST, "$TMP/ws", "handshake"],
        env: { HERMESD_UNIT_MANAGER: "process" },
        linuxOnly: true,
        check: (out) => (out.includes("{") ? undefined : "no JSON answer from the helper"),
      },
      {
        name: "guest-launch",
        args: [GUEST, "$TMP/ws", "launch", "op-verify-1", "1", "echo verify-ran > $TMP/ws-ran.txt"],
        env: { HERMESD_UNIT_MANAGER: "process" },
        linuxOnly: true,
        check: (out) => (out.includes("{") ? undefined : "no JSON answer from the helper"),
      },
      {
        name: "guest-launch-again",
        args: [GUEST, "$TMP/ws", "launch", "op-verify-1", "1", "echo second-run >> $TMP/ws-ran.txt"],
        env: { HERMESD_UNIT_MANAGER: "process" },
        linuxOnly: true,
        check: (_out, tmp) => {
          for (let i = 0; i < 50 && !existsSync(join(tmp, "ws-ran.txt")); i++) sh("sleep", ["0.1"]);
          const ran = existsSync(join(tmp, "ws-ran.txt")) ? readFileSync(join(tmp, "ws-ran.txt"), "utf8") : "";
          return ran === "verify-ran\n" ? undefined : `the command must run once; the counter file holds ${JSON.stringify(ran)}`;
        },
      },
      {
        name: "guest-status",
        args: [GUEST, "$TMP/ws", "status", "op-verify-1"],
        env: { HERMESD_UNIT_MANAGER: "process" },
        linuxOnly: true,
        check: (out) => (/done|running/.test(out) ? undefined : `status is not done or running: ${out.trim()}`),
      },
    ],
  },
  loop: {
    guide: "6.3, 6.4, 2.3",
    what: "the session actor, its async loop, compaction, the prompt builder, the provider formats, the profile actor",
    tests: ["packages/session-actor/src", "packages/prompt/src", "packages/providers/src", "packages/faults/src/loop"],
    drives: [
      { name: "golden-plain-and-tools", args: [GOLDEN, "check", "plain-reply", "one-tool-call", "parallel-tools", "clarify-sequential", "compaction-50"], check: sameLines(5) },
    ],
  },
  plugins: {
    guide: "6.6, 3.5, 9.1",
    what: "the manifest loader, hook dispatch with upstream semantics, the python/shadow/ts flag of each call site",
    tests: ["packages/plugin-host/src"],
    drives: [
      { name: "golden-hooks", args: [GOLDEN, "check", "hook-blocks-tool", "hook-crashes", "hook-time-budget", "three-plugins-hook-order"], check: sameLines(4) },
    ],
  },
  golden: {
    guide: "7.2",
    what: "the 20 scripts play to the committed port transcripts; the comparator names a difference",
    tests: ["packages/golden/src"],
    drives: [
      { name: "list", args: [GOLDEN, "list"], check: (out) => (out.trim().split("\n").length === 20 ? undefined : "expected 20 scripts") },
      { name: "check-all", args: [GOLDEN, "check"], check: both(sameLines(20), cleanTree("packages/golden/transcripts")) },
      { name: "compare", args: [GOLDEN, "compare"] },
    ],
  },
  faults: {
    guide: "7.3, 7.4",
    what: "the D1 to D17 catalogue on the backends this machine has (model, node, guest-process on Linux)",
    tests: ["packages/faults/src"],
    drives: [],
  },
  "state-port": {
    guide: "6.4 (migration test)",
    what: "a state.db splits into the actors and comes back as a file with upstream's tables",
    tests: ["packages/state-port/src"],
    drives: [
      { name: "sample", args: [STATE, "sample", "$TMP/sample.db"], check: (_o, tmp) => (existsSync(join(tmp, "sample.db")) ? undefined : "sample.db was not written") },
      {
        name: "roundtrip",
        args: [STATE, "roundtrip", "$TMP/sample.db", "$TMP/exported.db"],
        check: (out, tmp) => {
          if (!existsSync(join(tmp, "exported.db"))) return "exported.db was not written";
          const start = out.indexOf("{");
          const report = start >= 0 ? (JSON.parse(out.slice(start)) as { import?: unknown; export?: unknown }) : {};
          return report.import && report.export ? undefined : "the report has no import and export parts";
        },
      },
      { name: "roundtrip-partial", args: [STATE, "roundtrip", "$TMP/sample.db", "$TMP/partial.db", "--partial"], check: (_o, tmp) => (existsSync(join(tmp, "partial.db")) ? undefined : "partial.db was not written") },
    ],
  },
};

function sh(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): { code: number; out: string; stdout: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `${r.error.message}\n` : ""}`, stdout: r.stdout ?? "" };
}

function version(cmd: string): string | undefined {
  const r = sh(cmd, ["--version"]);
  return r.code === 0 ? r.out.trim().split("\n")[0] : undefined;
}

function testFiles(paths: string[]): string[] {
  const found: string[] = [];
  const walk = (p: string): void => {
    const abs = join(ROOT, p);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const e of readdirSync(abs).sort()) walk(join(p, e));
    else if (p.endsWith(".test.ts")) found.push(p);
  };
  for (const p of paths) walk(p);
  return [...new Set(found)];
}

const isLinuxOnly = (file: string): boolean => LINUX_ONLY.some((p) => file === p || file.startsWith(p));

interface TestCounts {
  pass: number;
  fail: number;
  skip: number;
  failures: string[];
}

function parseTests(rt: Runtime, out: string): TestCounts {
  const num = (re: RegExp): number => Number(out.match(re)?.[1] ?? 0);
  if (rt === "bun") {
    const failures = [...new Set(out.split("\n").filter((l) => l.startsWith("(fail) ")).map((l) => l.slice(7).replace(/ \[[\d.]+m?s\]$/, "")))];
    return { pass: num(/^\s*(\d+) pass$/m), fail: num(/^\s*(\d+) fail$/m), skip: num(/^\s*(\d+) skip$/m), failures };
  }
  const failures = [...new Set(out.split("\n").filter((l) => /^\s*✖ /.test(l) && !l.includes("failing tests:")).map((l) => l.trim().slice(2).replace(/ \([\d.]+ms\)$/, "")))];
  return { pass: num(/^ℹ pass (\d+)$/m), fail: num(/^ℹ fail (\d+)$/m), skip: num(/^ℹ skipped (\d+)$/m), failures };
}

function gitState(): { sha: string; dirty: boolean } {
  return { sha: sh("git", ["rev-parse", "--short", "HEAD"]).out.trim(), dirty: sh("git", ["status", "--porcelain"]).out.trim() !== "" };
}

function doctor(): number {
  const lines: Array<[boolean | "note", string]> = [];
  const pin = JSON.parse(readFileSync(join(ROOT, "upstream/pin.json"), "utf8")) as { commit: string; stateSchemaVersion: number };
  const bun = version("bun");
  const pinned = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  const node = version("node");
  lines.push([bun === pinned, `bun ${bun ?? "not found"} (the repository pins ${pinned} in .bun-version; CI uses it)`]);
  lines.push(["note", `node ${node ?? "not found"}: only for --rt node, a second opinion; the repository runs on bun`]);
  // bun installs each workspace package with its own node_modules, holding only what it declares.
  const installed = (pkg: string, dep: string): boolean => existsSync(join(ROOT, "packages", pkg, "node_modules", dep));
  lines.push([installed("faults", "@hermesd/host"), "the workspace packages are linked (else: bun install)"]);
  lines.push([installed("host-cloudflare", "miniflare"), "miniflare is installed (the workerd tests of host-cloudflare)"]);
  lines.push([installed("host-rivet", "rivetkit"), "rivetkit is installed (the real-rivetkit tests of host-rivet)"]);
  const fts = sh(process.execPath, ["-e", 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");d.exec("create virtual table f using fts5(x)");console.log(d.prepare("select sqlite_version() v").get().v)']);
  lines.push([fts.code === 0, `node:sqlite with FTS5 in this runtime: ${fts.code === 0 ? `sqlite ${fts.out.trim()}` : "missing"}`]);
  lines.push([/^[0-9a-f]{40}$/.test(pin.commit), `upstream pin ${pin.commit.slice(0, 8)}, state schema ${pin.stateSchemaVersion}`]);
  const linux = process.platform === "linux";
  const docker = sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
  lines.push(["note", linux ? "linux: the guest-helper tests and drives run here" : `${process.platform}: the guest-helper shim and unit tests and faults/guest need Linux; run them with --linux (docker ${docker.code === 0 ? docker.out.trim() : "is not running"})`]);
  const g = gitState();
  lines.push(["note", `git ${g.sha}${g.dirty ? " with uncommitted changes" : ""}`]);
  lines.push(["note", "nothing here is a real host: a pass is never 'demonstrated' (STATUS.md)"]);
  for (const [ok, text] of lines) console.log(`${ok === "note" ? "note" : ok ? "ok  " : "FAIL"}  ${text}`);
  return lines.some(([ok]) => ok === false) ? 1 : 0;
}

function runOne(name: string, rt: Runtime): boolean {
  const sub = SUBSYSTEMS[name]!;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const dir = join(EVIDENCE, `${stamp}-${name}-${rt}`);
  const tmp = join(TMP, `${stamp}-${name}-${rt}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const linux = process.platform === "linux";
  const all = testFiles(sub.tests);
  const files = all.filter((f) => linux || !isLinuxOnly(f));
  const skipped = all.filter((f) => !files.includes(f)).map((f) => `${f} (needs Linux)`);
  let ok = true;

  let counts: TestCounts = { pass: 0, fail: 0, skip: 0, failures: [] };
  if (files.length > 0) {
    const args = rt === "bun" ? ["test", "--timeout", "60000", ...files.map((f) => `./${f}`)] : ["--test", "--test-reporter=spec", ...files];
    const r = sh(rt, args);
    writeFileSync(join(dir, "tests.log"), `$ ${rt} ${args.join(" ")}\n${r.out}`);
    counts = parseTests(rt, r.out);
    if (r.code !== 0 || counts.fail > 0 || counts.pass === 0) ok = false;
  }

  const drives: Array<{ name: string; command: string; exit: number; problem?: string }> = [];
  try {
    for (const d of sub.drives) {
      if (d.linuxOnly && !linux) {
        skipped.push(`drive ${d.name} (needs Linux)`);
        continue;
      }
      const args = d.args.map((a) => a.replaceAll("$TMP", tmp));
      const r = sh(rt, args, d.env ? { env: d.env } : {});
      writeFileSync(join(dir, `drive-${d.name}.log`), `$ ${rt} ${args.join(" ")}\n${r.out}`);
      let problem: string | undefined;
      try {
        problem = r.code !== 0 ? `exit ${r.code}` : d.check?.(r.stdout, tmp);
      } catch (e) {
        problem = `the check threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      drives.push({ name: d.name, command: `${rt} ${d.args.join(" ")}`, exit: r.code, ...(problem ? { problem } : {}) });
      if (problem) ok = false;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const summary = {
    subsystem: name,
    guide: sub.guide,
    proves: sub.what,
    result: ok ? "pass" : "fail",
    demonstrated: false,
    runtime: `${rt} ${version(rt)}`,
    platform: `${process.platform}/${process.arch}`,
    git: gitState(),
    at: new Date().toISOString(),
    tests: { files: files.length, ...counts },
    drives,
    skipped,
  };
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`${ok ? "PASS" : "FAIL"} ${name} on ${rt}: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip in ${files.length} files; ${drives.filter((d) => !d.problem).length}/${drives.length} drives`);
  for (const f of counts.failures) console.log(`  failed test: ${f}`);
  for (const d of drives) if (d.problem) console.log(`  failed drive ${d.name}: ${d.problem}`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  console.log(`  evidence: ${relative(ROOT, dir)}/summary.json`);
  return ok;
}

/** Run the same command in a Linux container, on a copy of the tree, and copy the evidence back. */
function runInLinux(target: string): number {
  mkdirSync(EVIDENCE, { recursive: true });
  const script = [
    // The bun image has no git; the golden drive checks the tree with it.
    "apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null 2>&1 || { echo 'could not install git'; exit 1; }",
    "mkdir /work && cd /src",
    // Every node_modules is left behind: the packages have their own, with native binaries for this host.
    "tar --exclude=node_modules --exclude=./.verify --exclude=./.git -cf - . | tar -xf - -C /work",
    "cd /work && git init -q && git add -A && git -c user.name=verify -c user.email=verify@localhost commit -qm tree",
    "bun install --frozen-lockfile >/dev/null 2>&1 || { echo 'bun install --frozen-lockfile failed'; exit 1; }",
    `bun ${SELF} run ${target}; code=$?`,
    "cp -r /work/.verify/evidence/. /evidence/",
    "exit $code",
  ].join("\n");
  const r = spawnSync("docker", ["run", "--rm", "-v", `${ROOT}:/src:ro`, "-v", `${EVIDENCE}:/evidence`, LINUX_IMAGE, "bash", "-c", script], { stdio: "inherit" });
  return r.status ?? 1;
}

function main(argv: string[]): number {
  const [cmd, target] = argv;
  const flag = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  if (cmd === "doctor") return doctor();
  if (cmd === "list") {
    for (const [n, s] of Object.entries(SUBSYSTEMS)) console.log(`${n.padEnd(11)} guide ${s.guide.padEnd(22)} ${s.what}`);
    return 0;
  }
  if (cmd === "clean") {
    rmSync(TMP, { recursive: true, force: true });
    console.log(`removed ${relative(ROOT, TMP)}; evidence stays in ${relative(ROOT, EVIDENCE)}`);
    return 0;
  }
  if (cmd === "run" && target && (target === "all" || SUBSYSTEMS[target])) {
    if (argv.includes("--linux")) return runInLinux(target);
    const rt = (flag("--rt") ?? (version("bun") ? "bun" : "node")) as Runtime;
    if (rt !== "bun" && rt !== "node") return usage();
    const names = target === "all" ? Object.keys(SUBSYSTEMS) : [target];
    const results = names.map((n) => runOne(n, rt));
    return results.every(Boolean) ? 0 : 1;
  }
  return usage();
}

function usage(): number {
  console.error(`usage: verify.ts doctor | list | run <${Object.keys(SUBSYSTEMS).join("|")}|all> [--rt bun|node] [--linux] | clean`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
