/**
 * The date lines of the system prompt.
 *
 * Port of upstream `agent/system_prompt.py`: `_zone_bits`, `_session_start_like`
 * and `_timestamp_line`. The line has a date only, so the prompt stays the
 * same bytes for the whole day. Zone and offset are in it so that tools need
 * not guess.
 *
 * Differences: the zone abbreviation comes from `Intl` ("EST", or "GMT+1" for
 * zones that `Intl` has no short name for), where Python gives "CET". A stamp in
 * a session id (`YYYYMMDD_HHMMSS`) is read as UTC, because the host of the port
 * is a Durable Object or a cell, not a user's machine.
 */

export interface TimestampInput {
  now: Date;
  sessionStart?: Date;
  timeZone: string;
  /** The session ids to read a start stamp from, in order of preference: the lineage root, then the session. */
  candidateIds?: ReadonlyArray<string | undefined>;
  /** `[label, value]` lines after the date. A line with an empty value is left out. */
  trailer?: ReadonlyArray<readonly [string, string | undefined]>;
}

interface Zoned {
  weekday: string;
  month: string;
  day: string;
  year: string;
  ymd: string;
  abbrev: string;
  /** "+HH:MM" */
  offset: string;
}

function zoned(d: Date, timeZone: string): Zoned {
  const part = (opts: Intl.DateTimeFormatOptions, type: string): string =>
    new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).formatToParts(d).find((p) => p.type === type)?.value ?? "";
  const weekday = part({ weekday: "long" }, "weekday");
  const month = part({ month: "long" }, "month");
  const day = part({ day: "2-digit" }, "day");
  const year = part({ year: "numeric" }, "year");
  const monthNum = part({ month: "2-digit" }, "month");
  const abbrev = part({ timeZoneName: "short" }, "timeZoneName");
  const longOffset = part({ timeZoneName: "longOffset" }, "timeZoneName");
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(longOffset);
  const offset = m && m[1] ? `${m[1]}${m[2]}:${m[3]}` : "+00:00";
  return { weekday, month, day, year, ymd: `${year}${monthNum}${day}`, abbrev, offset };
}

/** Upstream `_zone_bits`: IANA key, abbreviation (if different) and the UTC offset. */
export function zoneBits(now: Date, timeZone: string): string[] {
  const z = zoned(now, timeZone);
  const bits: string[] = [timeZone];
  if (z.abbrev && z.abbrev !== timeZone) bits.push(z.abbrev);
  if (z.offset) bits.push(`UTC${z.offset}`);
  return bits;
}

/** Upstream `_session_start_like`: the start of the conversation, the same bytes at every rebuild. */
function sessionStartLike(i: TimestampInput): Date {
  for (const id of i.candidateIds ?? []) {
    const m = typeof id === "string" ? /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(id) : null;
    if (!m) continue;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    const d = new Date(t);
    // Reject a stamp that rolled over (month 13 and so on), as strptime does.
    if (d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])) return d;
  }
  return i.sessionStart ?? i.now;
}

/** Upstream `_timestamp_line`. */
export function timestampLine(i: TimestampInput): string {
  const bits = zoneBits(i.now, i.timeZone);
  const zoneSuffix = bits.length > 0 ? ` (${bits.join(", ")})` : "";
  const startDate = sessionStartLike(i);
  const start = zoned(startDate, i.timeZone);
  const now = zoned(i.now, i.timeZone);
  let line = `Conversation started: ${start.weekday}, ${start.month} ${start.day}, ${start.year}${zoneSuffix}`;
  // A long session spans many days. Stamp the rebuild day too, so the start date is not read as today.
  if (now.ymd !== start.ymd) {
    line +=
      `\nToday's date (as of the last context rebuild): ${now.weekday}, ${now.month} ${now.day}, ${now.year} ` +
      "— trust this over the start date for what day it is now; query tools for exact time.";
  }
  return line + (i.trailer ?? []).filter(([, v]) => !!v).map(([label, value]) => `\n${label}: ${value}`).join("");
}
