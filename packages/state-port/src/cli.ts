import { fileURLToPath } from "node:url";
import { loadPlainActors } from "./plain.ts";
import { readActors } from "./read-actors.ts";
import { readStateDb } from "./read-db.ts";
import { buildSampleStateDb } from "./sample.ts";
import { writeStateDb } from "./write-db.ts";

/**
 * Two commands for a person at a terminal. Run with `bun packages/state-port/src/cli.ts`.
 *
 *   sample <out.db>
 *     Write the small sample state.db that the migration test uses.
 *
 *   roundtrip <in.db> <out.db> [--partial]
 *     Import <in.db> (a COPY of a real state.db: this reads it read-only, but
 *     keep a backup anyway), split it into the actors, read the actors back,
 *     and export a fresh <out.db>. No turns run. The result is what you give
 *     to contracts/resume-check.sh.
 *
 * `--partial` leaves out the four ledger tables on import and export.
 */

export function main(argv: string[]): number {
  const [cmd, a, b, ...flags] = argv;
  if (cmd === "sample" && a) {
    buildSampleStateDb(a);
    process.stdout.write(`wrote ${a}\n`);
    return 0;
  }
  if (cmd === "roundtrip" && a && b) {
    const partial = flags.includes("--partial");
    const { image, report } = readStateDb(a, { ledger: partial ? "exclude" : "keep" });
    const actors = loadPlainActors(image);
    try {
      const out = writeStateDb(b, readActors(actors.sources), { mode: partial ? "partial" : "full", now: Date.now() });
      process.stdout.write(`${JSON.stringify({ import: report, export: out }, null, 2)}\n`);
    } finally {
      actors.close();
    }
    return 0;
  }
  process.stderr.write("usage: cli.ts sample <out.db> | cli.ts roundtrip <in.db> <out.db> [--partial]\n");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
