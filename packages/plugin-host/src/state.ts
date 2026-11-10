/**
 * Per-plugin state (`ctx.state`). Upstream caps it at 10 MiB per plugin.
 */

export const STATE_CAP_BYTES = 10 * 1024 * 1024;

export class StateCapError extends Error {
  constructor(plugin: string, size: number, cap: number) {
    super(`plugin ${plugin}: state would be ${size} bytes, the cap is ${cap}`);
    this.name = "StateCapError";
  }
}

/**
 * A JSON key-value store. The size is the UTF-8 length of the JSON text of the
 * whole map. A write that would pass the cap throws and changes nothing.
 */
export class PluginState {
  readonly #data = new Map<string, unknown>();
  readonly #sizes = new Map<string, number>();
  #bytes = 2; // "{}"

  readonly plugin: string;
  readonly capBytes: number;

  constructor(plugin: string, capBytes: number = STATE_CAP_BYTES) {
    this.plugin = plugin;
    this.capBytes = capBytes;
  }

  get(key: string): unknown {
    return this.#data.get(key);
  }

  has(key: string): boolean {
    return this.#data.has(key);
  }

  get bytes(): number {
    return this.#bytes;
  }

  set(key: string, value: unknown): void {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("state values must be JSON values");
    const entry = Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(text);
    const old = this.#sizes.get(key);
    // Each entry costs its own bytes plus one comma, except the first one.
    const commas = (n: number) => (n > 1 ? n - 1 : 0);
    const nextCount = this.#data.size + (old === undefined ? 1 : 0);
    const next =
      this.#bytes - commas(this.#data.size) - (old ?? 0) + entry + commas(nextCount);
    if (next > this.capBytes) throw new StateCapError(this.plugin, next, this.capBytes);
    this.#data.set(key, JSON.parse(text));
    this.#sizes.set(key, entry);
    this.#bytes = next;
  }

  delete(key: string): void {
    const old = this.#sizes.get(key);
    if (old === undefined) return;
    const commas = (n: number) => (n > 1 ? n - 1 : 0);
    this.#bytes = this.#bytes - commas(this.#data.size) - old + commas(this.#data.size - 1);
    this.#data.delete(key);
    this.#sizes.delete(key);
  }
}
