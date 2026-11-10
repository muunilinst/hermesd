import type { Backend, FaultId } from "./catalogue.ts";
import { DEMONSTRATING_BACKENDS } from "./catalogue.ts";
import type { FaultBackend } from "./backend.ts";
import { FAULT_DEFINITIONS } from "./definitions.ts";

/** The result of one test case on one backend. */
export interface FaultResult {
  id: FaultId;
  caseId?: string;
  /** Every result carries its backend. */
  backend: Backend;
  outcome: "pass" | "fail";
  /**
   * True only for a pass on a backend with a real executor, a real guest
   * helper and a real VM. A pass on "model" or "node" is never demonstrated.
   */
  demonstrated: boolean;
  error?: string;
}

/** Whether a pass on this backend counts as demonstrated. */
export function countsAsDemonstrated(backend: Backend): boolean {
  return DEMONSTRATING_BACKENDS.has(backend);
}

/** A short label, such as `D11(c)@model: pass (not demonstrated)`. */
export function labelResult(r: FaultResult): string {
  const name = `${r.id}${r.caseId ? `(${r.caseId})` : ""}@${r.backend}`;
  if (r.outcome === "fail") return `${name}: fail`;
  return `${name}: pass${r.demonstrated ? " (demonstrated)" : " (not demonstrated)"}`;
}

/** Run one case in a fresh world. */
export async function runFaultCase(backend: FaultBackend, id: FaultId, caseId?: string): Promise<FaultResult> {
  const def = FAULT_DEFINITIONS.find((d) => d.id === id);
  const c = def?.cases.find((x) => x.caseId === caseId);
  if (!def || !c) throw new Error(`no fault test ${id}${caseId ? `(${caseId})` : ""}`);
  const base = { id, ...(caseId === undefined ? {} : { caseId }), backend: backend.name };
  const world = await backend.create();
  try {
    await c.run(world);
    return { ...base, outcome: "pass", demonstrated: countsAsDemonstrated(backend.name) };
  } catch (e) {
    return { ...base, outcome: "fail", demonstrated: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await world.close();
  }
}

/** Run every defined case. */
export async function runAllFaultTests(backend: FaultBackend): Promise<FaultResult[]> {
  const results: FaultResult[] = [];
  for (const def of FAULT_DEFINITIONS) {
    for (const c of def.cases) results.push(await runFaultCase(backend, def.id, c.caseId));
  }
  return results;
}
