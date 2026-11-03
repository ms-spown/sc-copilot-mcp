/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): the `specs` field of a poll answer in each state.
 *
 * The figures are SYNTHETIC, hand-made for a plausible small freighter, round numbers that match no real record. They
 * only exercise the View; they are not data about any ship.
 */
import type { ShipSpecs } from "../specs.js";

const base = { source: "star-citizen.wiki" as const };

export type SpecsSampleName = "ready" | "unknown" | "ambiguous" | "pending" | "error";

/** The sheets in each state. `nowMs` is the scenario's clock: the ready sheet was read three minutes before it. */
export function specsSamples(nowMs: number): Record<SpecsSampleName, ShipSpecs> {
  return {
    ready: {
      status: "ready",
      name: "Cutter",
      speed_scm_ms: 210,
      speed_max_ms: 1100,
      cargo_scu: 4,
      shield_hp: 4000,
      hull_hp: 12000,
      fetched_at: new Date(nowMs - 3 * 60_000).toISOString(),
      version: "4.10.2-LIVE.1",
      updated_at: "2026-11-02T10:00:00.000Z",
      ...base,
    },
    unknown: { status: "unknown", ...base },
    ambiguous: {
      status: "ambiguous",
      candidates: ["Cutter Alpha", "Cutter Beta", "Cutter Gamma"],
      ...base,
    },
    pending: { status: "pending", ...base },
    error: { status: "error", ...base },
  };
}
