/**
 * The travel-time model behind `uex_plan_trade`. It is an ESTIMATE, and every number it uses is
 * either read from a source (distance from UEX in Gm, quantum speed from the Star Citizen Wiki sheet)
 * or a documented assumption below that the caller can override.
 *
 * Why the QUANTUM speed and not the SCM speed: UEX distances are in gigametres (1 Gm = 10^9 m).
 * A ship at its SCM speed (about 200 m/s) would need years for 23 Gm; trade runs between places
 * are quantum jumps. The wiki gives each ship's `quantum.quantum_speed` (m/s) and
 * `quantum.quantum_spool_time` (s). Check against the wiki's own calibration point: the Cutlass
 * Black sheet says Port Olisar to ArcCorp takes 176 s, and UEX's orbit matrix says Crusader to
 * ArcCorp is 42 Gm: 42e9 m / 238 314 300 m/s = 176.2 s. So "distance / speed" matches the game's
 * own number for a straight quantum jump.
 *
 * What is NOT modelled: quantum fuel and its price, jump interruptions, the acceleration phase
 * of the jump beyond the wiki's own figure, atmosphere entry and landing queues, loading time of
 * big cargo, pirates. The fixed overheads below stand for all of it, on average.
 */

/** Fixed time at each place you stop: request landing, land, use the terminal, load or unload, take off, align for the jump. Assumption, not measured. */
export const DEFAULT_STOP_SECONDS = 8 * 60;

/** Time for a hop inside one orbit (two terminals of the same planet or station, no quantum jump). Assumption. */
export const LOCAL_HOP_SECONDS = 2 * 60;

/** Spool-up when the wiki gives none for the ship. */
export const DEFAULT_SPOOL_SECONDS = 10;

/** Speed of light: no quantum drive goes faster, so a larger figure is a hole or an error in the source. */
const MAX_QUANTUM_SPEED_MS = 299_792_458;
const MIN_QUANTUM_SPEED_MS = 1_000_000;
const MAX_SPOOL_SECONDS = 120;

export interface TravelModel {
  /** Quantum speed in m/s, null when unknown (then no time can be computed). */
  quantumSpeedMs: number | null;
  spoolSeconds: number;
  stopSeconds: number;
  localHopSeconds: number;
}

export function validQuantumSpeed(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_QUANTUM_SPEED_MS &&
    value <= MAX_QUANTUM_SPEED_MS
    ? value
    : null;
}

export function validSpool(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SPOOL_SECONDS
    ? value
    : null;
}

/**
 * Seconds to go from one place to another, or null when the speed is unknown.
 * 0 Gm (same orbit) is a short local hop; otherwise spool-up + distance / quantum speed.
 */
export function legSeconds(gm: number, model: TravelModel): number | null {
  if (gm <= 0) return model.localHopSeconds;
  if (model.quantumSpeedMs === null) return null;
  return model.spoolSeconds + (gm * 1e9) / model.quantumSpeedMs;
}

/**
 * Time of one cycle: a stop at each place of `stops`, plus the given legs.
 * `legs` are the distances (Gm) travelled in the cycle, return trips included.
 */
export function cycleSeconds(
  stops: number,
  legsGm: readonly number[],
  model: TravelModel,
): number | null {
  let total = stops * model.stopSeconds;
  for (const gm of legsGm) {
    const s = legSeconds(gm, model);
    if (s === null) return null;
    total += s;
  }
  return total;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${s} s`;
}
