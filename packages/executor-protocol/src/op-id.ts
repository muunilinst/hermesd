import type { OpId } from "./contract.ts";

const encoder = new TextEncoder();

/** The domain tag. Change it only with a new derivation version. */
const DOMAIN = "hermesd/op_id/v1";

/**
 * Derive the operation ID: op_id = H(tenant, session, intent_id).
 *
 * For a tool call the intent ID is the tool call's `tool_call_uid`, which
 * Hermes already stores in `messages`. Because the ID is derived, a lost
 * response never loses the identity (porting guide rev 5.1, section 3.4).
 *
 * Each field is length-prefixed, so ("a|b", "c") and ("a", "b|c") give
 * different IDs. The function uses Web Crypto, which every target platform
 * has.
 */
export async function deriveOpId(tenant: string, session: string, intentId: string): Promise<OpId> {
  for (const [name, value] of [
    ["tenant", tenant],
    ["session", session],
    ["intentId", intentId],
  ] as const) {
    if (value.length === 0) throw new TypeError(`deriveOpId: ${name} is empty`);
  }
  const digest = await crypto.subtle.digest("SHA-256", frame([DOMAIN, tenant, session, intentId]));
  return `op_${toHex(new Uint8Array(digest))}` as OpId;
}

function frame(fields: string[]): Uint8Array {
  const parts = fields.map((f) => encoder.encode(f));
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of parts) {
    view.setUint32(offset, p.length);
    out.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
