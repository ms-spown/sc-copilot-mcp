import { isRow, label, toNumber, type Row } from "./normalize.js";

/**
 * Turn a place name a player reads in the mobiGlas ("Port Tressler", "Checkmate", "Lorville") into the
 * (star system, orbit) pair that UEX distances are indexed by. Pure over the rows of UEX `/terminals`.
 *
 * Distances in UEX are ORBIT-level, so a name is accepted when every terminal it could mean sits in ONE
 * orbit; a name that fits several orbits is reported as ambiguous with a few suggestions, never guessed.
 * Names are compared by their words (case, accents and punctuation do not matter).
 */

export interface PlaceMatch {
  query: string;
  status: "resolved" | "ambiguous" | "not_found";
  /** How the name matched: the whole name of a place, or the query's words inside a longer name. */
  basis?: "exact" | "partial";
  /** The place as UEX names it (cleaned). */
  label?: string;
  system?: number;
  systemName?: string | null;
  /** UEX orbit id; 0 when UEX gives the place no orbit (then no distance can be computed). */
  orbit?: number;
  /** Up to three candidate labels when ambiguous. */
  suggestions?: string[];
}

interface Entry {
  system: number;
  orbit: number;
  systemName: string | null;
  label: string;
  keys: Set<string>;
}

export interface PlaceIndex {
  entries: Entry[];
}

const MAX_SUGGESTIONS = 3;

export const words = (s: unknown): string[] =>
  typeof s === "string"
    ? s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean)
    : [];

const norm = (s: unknown): string => words(s).join(" ");

const NAME_FIELDS = [
  "space_station_name",
  "outpost_name",
  "city_name",
  "poi_name",
  "nickname",
  "displayname",
  "fullname",
  "name",
  "orbit_name",
] as const;

/** One entry per (system, orbit, place); the keys are every name UEX gives that place. */
export function buildPlaceIndex(terminals: readonly unknown[]): PlaceIndex {
  const byKey = new Map<string, Entry>();
  for (const t of terminals) {
    if (!isRow(t)) continue;
    const system = toNumber(t.id_star_system);
    if (system === undefined) continue;
    const orbit = toNumber(t.id_orbit) ?? 0;
    const placeName = [
      t.space_station_name,
      t.outpost_name,
      t.city_name,
      t.poi_name,
      t.orbit_name,
      t.name,
    ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    const shown = label(placeName, 60);
    if (!shown) continue;
    const id = `${system}|${orbit}|${norm(shown)}`;
    let entry = byKey.get(id);
    if (!entry) {
      entry = {
        system,
        orbit,
        systemName: label(t.star_system_name, 40),
        label: shown,
        keys: new Set(),
      };
      byKey.set(id, entry);
    }
    // The shop-level fields (name, fullname) say "Commodity Shop - Admin - ARC-L1": they only help an exact match.
    for (const f of NAME_FIELDS) {
      const k = norm((t as Row)[f]);
      if (k) entry.keys.add(k);
    }
  }
  return { entries: [...byKey.values()] };
}

function pick(candidates: Entry[]): { orbits: Entry[]; distinct: number } {
  const seen = new Map<string, Entry>();
  for (const e of candidates) {
    const k = `${e.system}|${e.orbit}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  return { orbits: [...seen.values()], distinct: seen.size };
}

/** Resolve one name. Never throws. */
export function resolvePlace(index: PlaceIndex, query: string): PlaceMatch {
  const q = norm(query);
  const shown = label(query, 60) ?? "";
  if (!q) return { query: shown, status: "not_found" };
  const qWords = q.split(" ");

  const attempt = (matches: Entry[], basis: "exact" | "partial"): PlaceMatch | null => {
    if (matches.length === 0) return null;
    const { orbits, distinct } = pick(matches);
    if (distinct === 1) {
      const e = orbits[0];
      // Several entries in one orbit: the first one's label stands for the orbit's place.
      const named = matches.find((m) => m.keys.has(q)) ?? matches[0];
      return {
        query: shown,
        status: "resolved",
        basis,
        label: named.label,
        system: e.system,
        systemName: e.systemName,
        orbit: e.orbit,
      };
    }
    return {
      query: shown,
      status: "ambiguous",
      suggestions: [...new Set(matches.map((m) => m.label))].slice(0, MAX_SUGGESTIONS),
    };
  };

  const exact = attempt(
    index.entries.filter((e) => e.keys.has(q)),
    "exact",
  );
  if (exact) return exact;
  const partial = attempt(
    index.entries.filter((e) =>
      [...e.keys].some((k) => qWords.every((w) => k.split(" ").includes(w))),
    ),
    "partial",
  );
  return partial ?? { query: shown, status: "not_found" };
}
