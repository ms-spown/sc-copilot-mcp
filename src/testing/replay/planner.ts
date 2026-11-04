import type { TripOption, TripPlanResult } from "../../providers/uex/tripPlanner.js";

/**
 * TEST SUPPORT (end-to-end replay): the trade planner the action bar calls, replaced by a fake that answers ONE round
 * trip. The route it names is the "plan" the replay applies through `sc_trade_suggest` (search then apply), exactly as
 * the player's click does. No UEX, no network.
 */

export interface RouteSpec {
  commodity: string;
  from: string;
  to: string;
  /** Planned price per SCU at each end. */
  buyPrice: number;
  sellPrice: number;
  scu: number;
}

/** A planner answer whose first option is `spec`. The planned profit is `round((sell - buy) * scu)`. */
export function planResultFor(spec: RouteSpec): TripPlanResult {
  const leg = {
    commodity: spec.commodity,
    from: {
      terminal: spec.from,
      system: "Stanton",
      planet: "Hurston",
      kind: "city",
      armistice_zone: true,
      jurisdiction: "UEE",
    },
    to: {
      terminal: spec.to,
      system: "Stanton",
      planet: "ArcCorp",
      kind: "city",
      armistice_zone: true,
      jurisdiction: "UEE",
    },
    buy_price: spec.buyPrice,
    sell_price: spec.sellPrice,
    profit_per_scu: spec.sellPrice - spec.buyPrice,
    scu: spec.scu,
    limited_by: "cargo" as const,
    cost: spec.buyPrice * spec.scu,
    profit_for_leg: (spec.sellPrice - spec.buyPrice) * spec.scu,
    destination_demand_scu: null,
    price_updated: { buy: null, sell: null },
    price_age_days: { buy: 1, sell: 1 },
    stale: false,
    report_status: "reported" as const,
    reports: { origin: 3, destination: 3 },
    is_estimate: false,
    estimated_sides: [] as ("origin" | "destination")[],
  };
  const option = {
    rank: 1,
    mode: "one_way",
    report_status: "reported",
    estimate: false,
    summary: "replay route",
    legs: [leg],
    trip: {
      profit_per_cycle: Math.round(leg.profit_for_leg),
      profit_per_scu: leg.profit_per_scu,
      scu_moved: spec.scu,
      peak_investment: leg.cost,
      cycle_seconds: 1800,
      cycle_time_estimate: "30 min",
      profit_per_hour: Math.round(leg.profit_for_leg * 2),
      flights_gm: [10],
      distance_basis: ["orbit"],
      stops: 2,
      returns_to_start: true,
    },
    data_age: { oldest_price_age_days: 1, stale: false, undated_prices: false },
    safety: {
      heuristic: true,
      exposure: "lower",
      points: 0,
      factors: [],
      caveat: "rule of thumb",
    },
  } as unknown as TripOption;
  return {
    objective: "profit",
    ship: null,
    cargo_scu_used: spec.scu,
    budget: null,
    time_model: {
      quantum_speed_ms: 200_000_000,
      spool_seconds: 10,
      stop_minutes: 8,
      local_hop_minutes: 3,
      estimate: true,
    },
    options: [option],
    chains: [],
    lists_note: "",
    report_counts: { reported: 1, estimate: 0, unverified: 0 },
    min_reports_note: "",
    candidates_scored: 1,
    excluded: {},
    assumptions: [],
    notes: [],
    fuel: {
      included: false,
      reason: "",
      fuel_prices_rows: null,
      rows_updated_within_7_days: null,
      median_age_days: null,
    },
  } as unknown as TripPlanResult;
}
