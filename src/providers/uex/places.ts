import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { isRow, label, toNumber, unwrapData, type Row } from "./normalize.js";
import type { Place } from "./distances.js";

/**
 * Where a terminal is, and what UEX says about the place around it.
 *
 * A UEX terminal row carries `id_star_system`, `id_orbit` and ONE of `id_space_station`, `id_city`,
 * `id_outpost` (or none: a point of interest). The place tables (`space_stations`, `cities`,
 * `outposts`, about 190 rows together) carry `is_armistice` and `jurisdiction_name`. Those two
 * facts are what the safety heuristic below may use; UEX has no piracy, player-density or
 * crime-stat data, and the heuristic never pretends to.
 */

export type PlaceKind = "station" | "city" | "outpost" | "other";

export interface TerminalPlace extends Place {
  terminalId: number;
  planetId: number;
  systemName: string | null;
  planetName: string | null;
  /** The moon the terminal is on (UEX `moon_name`); null on a planet, a station or a point of interest. */
  moonName: string | null;
  kind: PlaceKind;
  /** UEX `is_armistice` of the station, city or outpost; null when the place is not in UEX's tables. */
  armistice: boolean | null;
  jurisdiction: string | null;
}

export interface PlaceIndex {
  byTerminal: Map<number, TerminalPlace>;
  /** Why the armistice data are missing, when they are. */
  armisticeUnavailable: string | null;
}

interface PlaceFacts {
  armistice: boolean | null;
  jurisdiction: string | null;
}

function factsOf(rows: Row[]): Map<number, PlaceFacts> {
  const m = new Map<number, PlaceFacts>();
  for (const r of rows) {
    const id = toNumber(r.id);
    if (id === undefined) continue;
    const flag = toNumber(r.is_armistice);
    m.set(id, {
      armistice: flag === undefined ? null : flag === 1,
      jurisdiction: label(r.jurisdiction_name, 60),
    });
  }
  return m;
}

async function rowsOf(client: HttpClient, path: string): Promise<Row[]> {
  const res = await fetchWithCache(client, path, undefined, { record: false });
  const data = unwrapData(res.data);
  return data.kind === "rows" ? data.rows : [];
}

/** Build the index from the terminals list and the three place tables. A place table that cannot be read leaves armistice unknown, not false. */
export async function loadPlaces(client: HttpClient): Promise<PlaceIndex> {
  const terminals = await rowsOf(client, "/terminals");
  let stations = new Map<number, PlaceFacts>();
  let cities = new Map<number, PlaceFacts>();
  let outposts = new Map<number, PlaceFacts>();
  let unavailable: string | null = null;
  try {
    [stations, cities, outposts] = (
      await Promise.all([
        rowsOf(client, "/space_stations"),
        rowsOf(client, "/cities"),
        rowsOf(client, "/outposts"),
      ])
    ).map(factsOf) as [Map<number, PlaceFacts>, Map<number, PlaceFacts>, Map<number, PlaceFacts>];
    if (stations.size + cities.size + outposts.size === 0) {
      unavailable = "UEX's station, city and outpost tables came back empty";
    }
  } catch (error) {
    unavailable = `UEX's station, city and outpost tables could not be read (${error instanceof Error ? label(error.message, 120) : "error"})`;
  }
  const byTerminal = new Map<number, TerminalPlace>();
  for (const t of terminals) {
    if (!isRow(t)) continue;
    const terminalId = toNumber(t.id);
    const system = toNumber(t.id_star_system);
    if (terminalId === undefined || system === undefined) continue;
    const ss = toNumber(t.id_space_station) ?? 0;
    const city = toNumber(t.id_city) ?? 0;
    const outpost = toNumber(t.id_outpost) ?? 0;
    const kind: PlaceKind =
      ss > 0 ? "station" : city > 0 ? "city" : outpost > 0 ? "outpost" : "other";
    const facts =
      kind === "station"
        ? stations.get(ss)
        : kind === "city"
          ? cities.get(city)
          : kind === "outpost"
            ? outposts.get(outpost)
            : undefined;
    byTerminal.set(terminalId, {
      terminalId,
      planetId: toNumber(t.id_planet) ?? 0,
      system,
      orbit: toNumber(t.id_orbit) ?? 0,
      systemName: label(t.star_system_name, 40),
      planetName: label(t.planet_name, 60),
      moonName: label(t.moon_name, 60),
      kind,
      armistice: facts?.armistice ?? null,
      jurisdiction: facts?.jurisdiction ?? null,
    });
  }
  return { byTerminal, armisticeUnavailable: unavailable };
}

// ---------------------------------------------------------------------------------------------
// The safety heuristic
// ---------------------------------------------------------------------------------------------

export type Exposure = "lower" | "medium" | "higher";

export interface SafetyHeuristic {
  /** Always true: this is a rule of thumb over a few UEX facts, never a measurement. */
  heuristic: true;
  exposure: Exposure;
  points: number;
  factors: string[];
  caveat: string;
}

export const SAFETY_CAVEAT =
  "Rule of thumb built only from UEX place data (armistice flag, jurisdiction, system, kind of place) and the number of quantum flights. UEX has no piracy, player-density or crime data: no route is safe, and a lower exposure only means fewer of these risk factors.";

/** The risk points of a set of stops and the number of quantum flights in the cycle. Pure. */
export function safetyOf(
  stops: readonly (TerminalPlace | undefined)[],
  quantumFlights: number,
): SafetyHeuristic {
  const factors: string[] = [];
  let points = 0;
  const seen = new Set<number>();
  for (const p of stops) {
    if (!p) {
      points += 1;
      factors.push("a stop whose place UEX does not describe (+1)");
      continue;
    }
    if (seen.has(p.terminalId)) continue;
    seen.add(p.terminalId);
    if (p.armistice === false) {
      points += 1;
      factors.push(`a stop outside an armistice zone according to UEX (${p.kind}) (+1)`);
    } else if (p.armistice === null) {
      points += 1;
      factors.push(`a stop whose armistice status UEX does not give (${p.kind}) (+1)`);
    }
    if (p.kind === "outpost") {
      points += 1;
      factors.push("a surface outpost stop (+1)");
    }
    if (p.systemName?.toLowerCase() === "pyro") {
      points += 2;
      factors.push("a stop in the Pyro system (+2)");
    }
  }
  if (quantumFlights > 2) {
    points += quantumFlights - 2;
    factors.push(`${quantumFlights} quantum flights in the cycle (+${quantumFlights - 2})`);
  }
  if (factors.length === 0)
    factors.push("every stop is in an armistice zone according to UEX, in few flights");
  return {
    heuristic: true,
    exposure: points <= 1 ? "lower" : points <= 3 ? "medium" : "higher",
    points,
    factors: [...new Set(factors)],
    caveat: SAFETY_CAVEAT,
  };
}
