/**
 * TEST SUPPORT: made-up planner options (`TripOption`, `LegView`) in the exact shape the planner returns. Invented terminals and
 * prices: not UEX data, not a real market. Used by the reliability rules and the server tests that feed them.
 */
import type { LegMarket } from "../../providers/uex/legMarket.js";
import type { LegView, TripOption } from "../../providers/uex/tripPlanner.js";

export const NO_MARKET: LegMarket = {
  buy_range: null,
  sell_range: null,
  stock_scu: null,
  sell_inventory: null,
  sell_peers: null,
  commodity_reports: null,
};

/** A leg that is fully reported, fresh, in cargo, with a healthy margin: nothing to say about it unless `over` / `market` change that. */
export function leg(over: Partial<LegView> = {}, market: Partial<LegMarket> | null = {}): LegView {
  const place = (terminal: string, body: string) => ({
    terminal,
    terminal_id: 1,
    system: "Stanton",
    planet: body,
    body,
    kind: "station" as const,
    armistice_zone: true,
    jurisdiction: null,
  });
  return {
    commodity: "Goods",
    from: place("Origin", "Planet A"),
    to: place("Target", "Planet B"),
    buy_price: 1000,
    sell_price: 1500,
    profit_per_scu: 500,
    scu: 200,
    limited_by: "cargo",
    cost: 200_000,
    profit_for_leg: 100_000,
    destination_demand_scu: null,
    price_updated: { buy: null, sell: null },
    price_age_days: { buy: 0.5, sell: 0.5 },
    stale: false,
    report_status: "reported",
    reports: { origin: 4, destination: 4 },
    is_estimate: false,
    estimated_sides: [],
    market: market === null ? null : { ...NO_MARKET, ...market },
    ...over,
  } as LegView;
}

export function option(
  legs: LegView[],
  over: Partial<TripOption> = {},
  trip: Partial<TripOption["trip"]> = {},
): TripOption {
  return {
    rank: 1,
    mode: legs.length === 1 ? "one_way" : "round_trip",
    report_status: "reported",
    estimate: false,
    summary: "x",
    legs,
    trip: {
      profit_per_cycle: 100_000,
      profit_per_scu: 500,
      scu_moved: 200,
      peak_investment: 200_000,
      cycle_seconds: 1800,
      cycle_time_estimate: "30 min",
      profit_per_hour: 200_000,
      flights_gm: [30, 30],
      distance_basis: ["orbits_distances", "orbits_distances"],
      stops: 2,
      returns_to_start: true,
      ...trip,
    },
    data_age: { oldest_price_age_days: 0.5, stale: false, undated_prices: false },
    safety: { heuristic: true, exposure: "lower", points: 0, factors: [], caveat: "" },
    ...over,
  } as TripOption;
}

/**
 * The made-up "Medical Supplies" case: a round trip of two goods whose four prices have no player report, the first bought at a
 * price that never moved in UEX's range, sold at the top of its range, the whole displayed stock taken; the second sold to a
 * terminal at 72-85 % of its inventory with a thin margin; both terminals in the same UEX orbit on different bodies.
 */
export function medicalCase(): TripOption {
  const first = leg(
    {
      commodity: "Medical Supplies",
      buy_price: 3376,
      sell_price: 5500,
      profit_per_scu: 2124,
      scu: 597,
      cost: 2_015_472,
      limited_by: "stock",
      reports: { origin: 0, destination: 0 },
      report_status: "estimate",
      price_age_days: { buy: 2.9, sell: 0.9 },
    },
    {
      buy_range: { low: 3376, high: 3376 },
      sell_range: { low: 4800, high: 5500 },
      sell_peers: { same_price: 6, priced: 8 },
      commodity_reports: { reported: 0, terminals: 41 },
    },
  );
  first.from = { ...first.from, terminal: "Outpost One", body: "Moon One" };
  first.to = { ...first.to, terminal: "Station Two", body: "Planet Two" };
  const second = leg(
    {
      commodity: "Organics",
      buy_price: 800,
      sell_price: 860,
      profit_per_scu: 60,
      scu: 2000,
      cost: 1_600_000,
      reports: { origin: 0, destination: 0 },
      report_status: "estimate",
      price_age_days: { buy: 0.9, sell: 0.9 },
    },
    { sell_inventory: { code: 6, fill: "72-85%" } },
  );
  second.from = first.to;
  second.to = first.from;
  return option(
    [first, second],
    { report_status: "estimate", estimate: true },
    {
      flights_gm: [0, 0],
      cycle_seconds: 20 * 60,
      profit_per_hour: 560_000,
      profit_per_cycle: 1_388_000,
    },
  );
}
