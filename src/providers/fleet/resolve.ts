/**
 * Turn a name the player typed ("Crusader Hercules Starlifter C2") into a ship in UEX's list
 * ("Crusader C2 Hercules Starlifter"). Words are compared, not the string, so word order and
 * the maker's name do not matter; several possible ships are returned as candidates, never
 * guessed between.
 */

export interface VehicleRow {
  name: string;
  name_full?: string;
  [key: string]: unknown;
}

export type Resolution =
  | { match: "found"; vehicle: VehicleRow }
  | { match: "ambiguous"; candidates: VehicleRow[] }
  | { match: "not_found" };

const words = (s: unknown): string[] =>
  typeof s === "string"
    ? s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean)
    : [];

export function resolveShip(query: string, vehicles: VehicleRow[]): Resolution {
  const wanted = words(query);
  if (wanted.length === 0) return { match: "not_found" };

  const full = (v: VehicleRow) => words(v.name_full ?? v.name);
  const candidates = vehicles.filter((v) => {
    const have = new Set(full(v));
    return wanted.every((w) => have.has(w));
  });
  if (candidates.length === 0) return { match: "not_found" };
  if (candidates.length === 1) return { match: "found", vehicle: candidates[0] };

  // Several ships contain every word: one whose words are exactly the query's is the intended one.
  const key = [...wanted].sort().join(" ");
  const exact = candidates.filter((v) => [...full(v)].sort().join(" ") === key);
  if (exact.length === 1) return { match: "found", vehicle: exact[0] };

  // Also accept the same words once the maker's name is dropped from the ship's name.
  const exactWithoutMaker = candidates.filter((v) => [...words(v.name)].sort().join(" ") === key);
  if (exactWithoutMaker.length === 1) return { match: "found", vehicle: exactWithoutMaker[0] };

  return { match: "ambiguous", candidates: candidates.slice(0, 8) };
}
