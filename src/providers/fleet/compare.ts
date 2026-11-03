/**
 * Side-by-side comparison of what UEX and the Star Citizen Wiki say about the same ship.
 * The two sources disagree on some figures (crew above all); a disagreement is shown with both
 * values and their source, never settled in silence.
 */

export interface Range {
  min: number;
  max: number;
}

export interface FieldComparison<T> {
  conflict: boolean;
  uex?: T;
  wiki?: T;
}

export interface ShipComparison {
  crew?: FieldComparison<Range>;
  cargo_scu?: FieldComparison<number>;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * UEX writes the crew as text: "1" for one seat, "1,2" for one to two, "1-2" or "1 to 2". Text
 * after the figures ("10-20 crew", "1 to 2 (pilot + co)") is ignored; anything else ("2+", "-1",
 * "1-2-3", "0") gives no figure at all rather than a wrong one. 0 means "not provided".
 */
const AFTER = String.raw`(?:\s+[^\d+\-,.\s].*|\s*\(.*)?$`;
const RANGE = new RegExp(String.raw`^(\d+)\s*(?:-|\u2013|,|\bto\b)\s*(\d+)` + AFTER, "i");
const SINGLE = new RegExp(String.raw`^(\d+)` + AFTER);

export function parseUexCrew(raw: unknown): Range | undefined {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? { min: raw, max: raw } : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  const range = RANGE.exec(text);
  const single = range ? null : SINGLE.exec(text);
  const found = range
    ? [Number(range[1]), Number(range[2])]
    : single
      ? [Number(single[1])]
      : undefined;
  if (!found || found.some((n) => n <= 0)) return undefined;
  return { min: Math.min(...found), max: Math.max(...found) };
}

/**
 * The wiki gives {min, max} or a single number. One bound alone stands for both; 0 or a negative
 * number is a hole in the source, not a crew of 0.
 */
export function parseWikiCrew(raw: unknown): Range | undefined {
  if (typeof raw === "number" || typeof raw === "string") {
    const n = num(raw);
    return n !== undefined && Number.isInteger(n) && n > 0 ? { min: n, max: n } : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const min = num(c.min);
  const max = num(c.max);
  if (min === undefined && max === undefined) return undefined;
  const bounds = [min, max].filter((n): n is number => n !== undefined);
  if (bounds.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
  return { min: min ?? (max as number), max: max ?? (min as number) };
}

/** A figure of 0 or less is a hole in the source, not a ship that carries or moves nothing. */
export const positive = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};

function field<T>(
  uex: T | undefined,
  wiki: T | undefined,
  same: (a: T, b: T) => boolean,
): FieldComparison<T> | undefined {
  if (uex === undefined && wiki === undefined) return undefined;
  const conflict = uex !== undefined && wiki !== undefined && !same(uex, wiki);
  return {
    conflict,
    ...(uex !== undefined ? { uex } : {}),
    ...(wiki !== undefined ? { wiki } : {}),
  };
}

/** Two cargo figures within half a percent are the same ship (12 and 12.0001). */
const sameCargo = (a: number, b: number): boolean => Math.abs(a - b) / Math.max(a, b) < 0.005;

export function compareSources(
  uexRow: Record<string, unknown>,
  wikiVehicle: Record<string, unknown>,
): ShipComparison {
  return {
    crew: field(
      parseUexCrew(uexRow.crew),
      parseWikiCrew(wikiVehicle.crew),
      (a, b) => a.min === b.min && a.max === b.max,
    ),
    cargo_scu: field(positive(uexRow.scu), positive(wikiVehicle.cargo_capacity), sameCargo),
  };
}

export const conflictingFields = (c: ShipComparison): string[] =>
  Object.entries(c)
    .filter(([, v]) => v?.conflict)
    .map(([k]) => k);
