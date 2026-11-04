import { cleanLabel } from "../core/untrusted.js";
import { positive } from "../providers/fleet/compare.js";
import { resolveShip, type VehicleRow } from "../providers/fleet/resolve.js";

/**
 * The hold sizes the server knows for the player, for the "Soute" list of the commerce form (action `holds` of
 * `sc_trade_suggest`). PURE: saved trade trips, the fleet list and UEX's ship list in, a short bounded list out. No clock
 * of its own, no network, no file: the caller reads those and passes them (tests pass invented rows).
 *
 * WHAT A NUMBER HERE MEANS (read before changing a label):
 *  - A trade trip's SCU is the quantity MOVED by that run, not the ship's capacity. A run is at most as big as the hold, so
 *    it is a floor, and a partial load understates it. The View says "transportés", never "ta soute".
 *  - The game log does not name the ship of a run (the cargo kiosk line only carries an entity id, which this project never
 *    keeps). So a run never gets a ship name from history. A name appears next to a size in two cases only, and says which:
 *      "flotte": the player listed that ship in his fleet file (sc_fleet_add) and UEX gives it exactly that hold;
 *      "taille": exactly ONE ship in UEX's list has exactly that hold. That is a statement about the SIZE, not proof that
 *                this ship was used, and the View words it as such.
 *  - Nothing is invented: no ship, no size, no "typical" list. Nothing known gives an empty list.
 *  - No balance anywhere: sizes, counts, times and ship names only.
 */

export const HOLDS_MAX = 12;
/** Newest trade trips read from the sessions. */
export const HOLDS_MAX_TRIPS = 60;
/** Older trips say little about the ship flown now. */
export const HOLDS_MAX_AGE_MS = 180 * 24 * 3_600_000;
const NAME_MAX = 60;
const SCU_MAX = 100_000;

export interface HoldTrip {
  scu: number | null;
  /** ISO time the trip ended. */
  ended_at: string;
}

export interface KnownHold {
  /** Whole SCU, at least 1. */
  scu: number;
  /** Recent trade trips of exactly this size (0: only known from the fleet). */
  trips: number;
  /** ISO time of the latest such trip, or null. */
  last_at: string | null;
  ship: string | null;
  basis: "flotte" | "taille" | null;
}

export interface HoldsInput {
  /** Trade trips of the saved sessions, any order. */
  trips: readonly HoldTrip[];
  /** Ship names the player listed in his fleet file. */
  fleet: readonly string[];
  /** UEX's vehicle list, or null when it could not be read. */
  vehicles: readonly VehicleRow[] | null;
  nowMs: number;
}

const wholeScu = (v: unknown): number | null => {
  const n = positive(v);
  if (n === undefined) return null;
  const r = Math.round(n);
  return r >= 1 && r <= SCU_MAX ? r : null;
};

const shipName = (v: VehicleRow): string | null => cleanLabel(v.name_full ?? v.name, NAME_MAX);

export function buildKnownHolds(input: HoldsInput): KnownHold[] {
  // 1. The sizes of recent trade trips, newest first.
  const groups = new Map<number, { trips: number; lastMs: number }>();
  const dated = input.trips
    .map((t) => ({ scu: wholeScu(t.scu), ms: Date.parse(t.ended_at) }))
    .filter(
      (t): t is { scu: number; ms: number } =>
        t.scu !== null &&
        Number.isFinite(t.ms) &&
        t.ms <= input.nowMs + 24 * 3_600_000 &&
        input.nowMs - t.ms <= HOLDS_MAX_AGE_MS,
    )
    .sort((a, b) => b.ms - a.ms)
    .slice(0, HOLDS_MAX_TRIPS);
  for (const t of dated) {
    const g = groups.get(t.scu);
    if (g) {
      g.trips += 1;
      g.lastMs = Math.max(g.lastMs, t.ms);
    } else groups.set(t.scu, { trips: 1, lastMs: t.ms });
  }

  // 2. The ships of UEX by size (a size shared by two ships names none), and the player's own ships by size.
  const vehicles = input.vehicles ?? [];
  const bySize = new Map<number, string[]>();
  for (const v of vehicles) {
    const scu = wholeScu(v.scu);
    const name = shipName(v);
    if (scu === null || name === null) continue;
    const list = bySize.get(scu) ?? [];
    if (!list.includes(name)) list.push(name);
    bySize.set(scu, list);
  }
  const fleetBySize = new Map<number, string[]>();
  if (input.vehicles !== null) {
    for (const typed of input.fleet.slice(0, 300)) {
      const found = resolveShip(typed, vehicles as VehicleRow[]);
      if (found.match !== "found") continue;
      const scu = wholeScu(found.vehicle.scu);
      const name = shipName(found.vehicle);
      if (scu === null || name === null) continue;
      const list = fleetBySize.get(scu) ?? [];
      if (!list.includes(name)) list.push(name);
      fleetBySize.set(scu, list);
    }
  }

  const named = (scu: number): Pick<KnownHold, "ship" | "basis"> => {
    const own = fleetBySize.get(scu);
    if (own && own.length > 0) {
      return { ship: cleanLabel(own.slice(0, 2).join(" / "), NAME_MAX), basis: "flotte" };
    }
    const only = bySize.get(scu);
    if (only && only.length === 1) return { ship: only[0] as string, basis: "taille" };
    return { ship: null, basis: null };
  };

  // 3. History first (newest, then biggest), then the fleet's sizes that no trip has used.
  const out: KnownHold[] = [...groups.entries()]
    .sort((a, b) => b[1].lastMs - a[1].lastMs || b[0] - a[0])
    .map(([scu, g]) => ({
      scu,
      trips: g.trips,
      last_at: new Date(g.lastMs).toISOString(),
      ...named(scu),
    }));
  for (const scu of [...fleetBySize.keys()].sort((a, b) => b - a)) {
    if (groups.has(scu)) continue;
    out.push({ scu, trips: 0, last_at: null, ...named(scu) });
  }
  return out.slice(0, HOLDS_MAX);
}
