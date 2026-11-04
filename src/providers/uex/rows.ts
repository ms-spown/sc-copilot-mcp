import { parseUexDate } from "./freshness.js";

/**
 * Small helpers shared by the UEX commerce tools (refining, items, player marketplace). UEX sends
 * some numbers as strings ("6000000", "23"), `false` instead of an empty list, and Unix seconds
 * for dates: every one of those is normalised here, once.
 */

export type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;

/** UEX's `data` as a list of rows. `false`, an object or null (HTTP 200 with nothing) is an empty list. */
export function asRows(data: unknown): Row[] {
  return Array.isArray(data)
    ? data.filter((r): r is Row => typeof r === "object" && r !== null && !Array.isArray(r))
    : [];
}

/** A finite number from a number or a numeric string ("5633", "4000.5"); null for anything else. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** A price: a positive number, or null (UEX writes 0 for "no price"). */
export function toPrice(value: unknown): number | null {
  const n = toNumber(value);
  return n !== null && n > 0 ? n : null;
}

/** Whole days between a UEX date and `now`, one decimal; null when the row has no usable date. */
export function ageDays(value: unknown, now: number): number | null {
  const t = parseUexDate(value);
  return t === null ? null : Math.round(Math.max(0, now - t) / (DAY_MS / 10)) / 10;
}

/** The date of a row as an ISO string, or null. */
export function isoDate(value: unknown): string | null {
  const t = parseUexDate(value);
  return t === null ? null : new Date(t).toISOString();
}

/** Median of a non-empty list of numbers; null for an empty list. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Where a terminal is, in the words UEX gives (only the parts that exist). */
export function placeOf(r: Row): string | null {
  const parts = [
    r.star_system_name,
    r.planet_name,
    r.orbit_name,
    r.moon_name,
    r.space_station_name,
    r.city_name,
    r.outpost_name,
    r.poi_name,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  // The same name often appears twice (planet and orbit): keep the first occurrence.
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length ? unique.join(" / ") : null;
}

/** An integer limit inside [1, max], with a default. */
export function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  const n = value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value);
  return Math.min(Math.max(n, 1), max);
}
