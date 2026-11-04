import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { parseUexDate } from "./freshness.js";
import { toNumber, unwrapData } from "./normalize.js";

/**
 * Distances between places, in Gm (1 Gm = one million km), from UEX.
 *
 *  - `orbits_distances`: a whole system's orbit-to-orbit matrix in ONE call (Stanton: 810 rows,
 *    about 330 KB). The distance is a STRING in the answer. Two terminals in the same orbit have no
 *    row at all: that is "same place", not "unknown".
 *  - `terminals_distances`: ONE pair per call, an object, and `data: false` (HTTP 200) when UEX
 *    does not know the pair. Used only as a last resort, a few times per answer.
 */

export type DistanceResult =
  | { kind: "found"; gm: number; source: "terminals_distances" | "orbits_distances" }
  | { kind: "no_data"; why: string };

/** One pair of terminals. `data: false`, a missing or a non-numeric distance are all an explicit `no_data`. */
export async function fetchTerminalDistance(
  client: HttpClient,
  originTerminal: number,
  destinationTerminal: number,
): Promise<DistanceResult> {
  const res = await fetchWithCache(
    client,
    "/terminals_distances",
    {
      params: { id_terminal_origin: originTerminal, id_terminal_destination: destinationTerminal },
    },
    { record: false },
  );
  const data = unwrapData(res.data);
  if (data.kind === "no_data") return { kind: "no_data", why: data.why };
  const row = data.kind === "object" ? data.row : data.rows[0];
  const gm = toNumber(row?.distance);
  if (gm === undefined || gm < 0) {
    return { kind: "no_data", why: "UEX gave no usable distance for this pair" };
  }
  return { kind: "found", gm, source: "terminals_distances" };
}

export interface OrbitMatrix {
  /** Distance in Gm from `${originOrbit}>${destinationOrbit}`. */
  gm: Map<string, number>;
  rows: number;
  /** Oldest `date_modified` of the matrix rows (epoch ms), null when none is dated. */
  oldest: number | null;
}

export const orbitKey = (from: number, to: number): string => `${from}>${to}`;

/**
 * The orbit matrix between two systems (the same id twice for inside one system). Distances are
 * symmetric, so both directions are stored. An answer that is not a list gives an empty matrix, so
 * the caller falls back to something else instead of failing.
 */
export async function fetchOrbitMatrix(
  client: HttpClient,
  systemOrigin: number,
  systemDestination: number,
): Promise<OrbitMatrix> {
  const res = await fetchWithCache(
    client,
    "/orbits_distances",
    {
      params: {
        id_star_system_origin: systemOrigin,
        id_star_system_destination: systemDestination,
      },
    },
    { record: false },
  );
  const data = unwrapData(res.data);
  const matrix: OrbitMatrix = { gm: new Map(), rows: 0, oldest: null };
  if (data.kind !== "rows") return matrix;
  for (const row of data.rows) {
    const from = toNumber(row.id_orbit_origin);
    const to = toNumber(row.id_orbit_destination);
    const gm = toNumber(row.distance);
    if (from === undefined || to === undefined || gm === undefined || gm < 0) continue;
    matrix.gm.set(orbitKey(from, to), gm);
    if (!matrix.gm.has(orbitKey(to, from))) matrix.gm.set(orbitKey(to, from), gm);
    matrix.rows++;
    const t = parseUexDate(row.date_modified);
    if (t !== null && (matrix.oldest === null || t < matrix.oldest)) matrix.oldest = t;
  }
  return matrix;
}

export interface Place {
  system: number;
  orbit: number;
}

export type DistanceBasis = "same_orbit" | "orbits_distances" | "route" | "terminals_distances";

export type Distance =
  { kind: "known"; gm: number; basis: DistanceBasis } | { kind: "unknown"; why: string };

/**
 * Distance between two places from the orbit matrices already loaded.
 *  - same orbit (a planet's terminals, a station's): 0 Gm, basis `same_orbit`;
 *  - same system, both orbits in the matrix: its value;
 *  - another system, a terminal without an orbit (id 0) or a pair UEX has no row for: unknown.
 * Crossing from one system to another is not estimated here: the jump transit time is not in UEX.
 */
export function orbitDistance(
  from: Place | undefined,
  to: Place | undefined,
  matrices: ReadonlyMap<number, OrbitMatrix>,
): Distance {
  if (!from || !to) return { kind: "unknown", why: "a terminal's place is not known" };
  if (from.system !== to.system) {
    return { kind: "unknown", why: "the two places are in different star systems" };
  }
  if (from.orbit <= 0 || to.orbit <= 0) {
    return { kind: "unknown", why: "UEX gives no orbit for one of the terminals" };
  }
  if (from.orbit === to.orbit) return { kind: "known", gm: 0, basis: "same_orbit" };
  const gm = matrices.get(from.system)?.gm.get(orbitKey(from.orbit, to.orbit));
  return gm === undefined
    ? { kind: "unknown", why: "UEX has no distance row for these two orbits" }
    : { kind: "known", gm, basis: "orbits_distances" };
}
