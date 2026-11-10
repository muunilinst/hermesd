/**
 * Server-sent events and the errors of a model call.
 */

/** The model answered with an HTTP error. `status` and `body` feed the error classifier. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly bodyText: string;
  readonly headers: Record<string, string>;
  constructor(status: number, bodyText: string, headers: Record<string, string> = {}) {
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    super(extractMessage(body, bodyText, status));
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    this.bodyText = bodyText;
    this.headers = headers;
  }
}

/**
 * The stream ended before the terminal event, or the connection broke in the
 * middle of it. The partial output is dropped and the call is sent again
 * (guide 6.3, porting rule 1). The text of the Anthropic and Bedrock cases is
 * upstream's: `agent/anthropic_adapter.py:_stream_final_message` and
 * `agent/bedrock_adapter.py:stream_converse_with_callbacks`.
 */
export class StreamDroppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamDroppedError";
  }
}

function extractMessage(body: unknown, text: string, status: number): string {
  if (typeof body === "object" && body !== null) {
    const o = body as { error?: unknown; message?: unknown };
    if (typeof o.error === "object" && o.error !== null && typeof (o.error as { message?: unknown }).message === "string") {
      return (o.error as { message: string }).message;
    }
    if (typeof o.message === "string") return o.message;
  }
  return text.trim() ? text : `HTTP ${status}`;
}

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Split a byte stream into SSE events. A comment line (starting with ":") and a
 * frame with no data are skipped, as the SSE rules say. A read error is passed on:
 * the caller turns it into a `StreamDroppedError`.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      const ev = parseFrame(buf);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

/** Read events, and turn a broken connection into a dropped-stream error. */
export async function* guardedEvents(body: ReadableStream<Uint8Array> | null, what: string): AsyncGenerator<SseEvent> {
  if (!body) throw new StreamDroppedError(`${what} stream has no body`);
  try {
    yield* sseEvents(body);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e; // an interrupt is not a drop
    throw new StreamDroppedError(`${what} stream connection broke: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
