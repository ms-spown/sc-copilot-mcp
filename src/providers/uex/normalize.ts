import { cleanLabel } from "../../core/untrusted.js";

/**
 * Small normalisers for the UEX answers read by the trade-intelligence tools.
 *
 * UEX types are not stable: a distance is the string "23", a marketplace price is a string, a count
 * can be a number or a numeric string, and an unknown pair comes back as HTTP 200 with `data: false`.
 * Everything below turns such values into plain numbers or into an explicit "absent".
 */

export type Row = Record<string, unknown>;

export const isRow = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number from a number or a numeric string ("23", " 4.5 "); anything else is undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A finite number, 0 when absent: for stock and price fields where 0 and "not given" mean the same. */
export const amount = (value: unknown): number => toNumber(value) ?? 0;

/** A name from UEX where it enters an answer: cleaned, one line, bounded. */
export const label = (value: unknown, max = 80): string | null => cleanLabel(value, max);

/** What a UEX envelope's `data` holds, with the "no data" shapes made explicit. */
export type Unwrapped =
  { kind: "rows"; rows: Row[] } | { kind: "object"; row: Row } | { kind: "no_data"; why: string };

/**
 * The `data` of a UEX answer. The client interceptor lets `{status:"ok", data:false}` through (UEX
 * answers it for a terminal pair it has no distance for, and for filters that match nothing), so
 * that case is turned into an explicit `no_data` here instead of being read as an empty list or,
 * worse, as a value. `null`, `false`, an empty list and an empty object are all "no data".
 */
export function unwrapData(body: unknown): Unwrapped {
  const data = isRow(body) ? body.data : undefined;
  if (data === false || data === null || data === undefined) {
    return {
      kind: "no_data",
      why: data === false ? "UEX answered `data: false`" : "UEX answered without data",
    };
  }
  if (Array.isArray(data)) {
    const rows = data.filter(isRow);
    return rows.length > 0
      ? { kind: "rows", rows }
      : { kind: "no_data", why: "UEX answered an empty list" };
  }
  if (isRow(data)) {
    return Object.keys(data).length > 0
      ? { kind: "object", row: data }
      : { kind: "no_data", why: "UEX answered an empty object" };
  }
  return { kind: "no_data", why: "UEX answered with a value that is not a record" };
}

const DAY_MS = 86_400_000;

/** Whole days between a UEX timestamp (epoch ms) and now, one decimal; null for no date. */
export function ageDays(timestamp: number | null, now: number): number | null {
  if (timestamp === null) return null;
  return Math.max(0, Math.round(((now - timestamp) / DAY_MS) * 10) / 10);
}

export const round = (n: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
