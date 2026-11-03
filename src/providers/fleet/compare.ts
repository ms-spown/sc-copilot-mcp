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

/** UEX writes the crew as text: "1" for one seat, "1,2" for one to two, "1,8" for one to eight. */
export function parseUexCrew(raw: unknown): Range | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? { min: raw, max: raw } : undefined;
  if (typeof raw !== "string") return undefined;
  const parts = raw
    .split(/[,;\-–/]|\bto\b/i)
    .map((p) => num(p))
    .filter((n): n is number => n !== undefined);
  if (parts.length === 0) return undefined;
  return { min: Math.min(...parts), max: Math.max(...parts) };
}

/** The wiki gives {min, max}; one side alone stands for both. */
export function parseWikiCrew(raw: unknown): Range | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const min = num(c.min);
  const max = num(c.max);
  if (min === undefined && max === undefined) return undefined;
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
    cargo_scu: field(positive(uexRow.scu), positive(wikiVehicle.cargo_capacity), (a, b) => a === b),
  };
}

export const conflictingFields = (c: ShipComparison): string[] =>
  Object.entries(c)
    .filter(([, v]) => v?.conflict)
    .map(([k]) => k);
