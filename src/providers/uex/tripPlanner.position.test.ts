import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { planTrips, TripPlanError } from "./tripPlanner.js";

/**
 * `planTrips` from a position ("Partir de ma position"), on an invented market: three places, a few goods. No UEX, no network.
 *
 *   Alphaville (city, orbit 10) and Alpha Dock (station, same orbit)  : where the player is
 *   Beta Port (station, orbit 20)                                     : 10 Gm from Alpha
 *   Gamma Base (outpost, orbit 30)                                    : 15 Gm from Beta, 40 Gm from Alpha
 * Goods 1 (A1): bought at Alphaville 100, sold at Beta Port 150: the opening trade (50 per SCU).
 * Goods 2 (B2): bought at Beta Port 200, sold at Gamma Base 500: the profitable route (300 per SCU), loaded at Beta Port.
 * Goods 3 (C3): bought at Alphaville 50, sold at Gamma Base 80: a route that loads where the player already is (30 per SCU).
 */

const NOW = Date.now();
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);

const terminal = (id: number, nick: string, extra: Record<string, unknown>) => ({
  id,
  name: `${nick} shop`,
  nickname: nick,
  id_planet: 1,
  star_system_name: "Teststar",
  planet_name: "Testplanet",
  id_star_system: 68,
  id_space_station: 0,
  id_city: 0,
  id_outpost: 0,
  ...extra,
});
const TERMINALS = [
  terminal(1, "Alphaville", {
    id_orbit: 10,
    id_city: 1,
    city_name: "Alphaville",
    orbit_name: "Alpha",
  }),
  terminal(2, "Alpha Dock", {
    id_orbit: 10,
    id_space_station: 1,
    space_station_name: "Alpha Dock",
    orbit_name: "Alpha",
  }),
  terminal(3, "Beta Port", {
    id_orbit: 20,
    id_space_station: 2,
    space_station_name: "Beta Port",
    orbit_name: "Beta",
  }),
  terminal(4, "Gamma Base", {
    id_orbit: 30,
    id_outpost: 1,
    outpost_name: "Gamma Base",
    orbit_name: "Gamma",
  }),
];
const arm = (id: number) => ({ id, is_armistice: 1, jurisdiction_name: "UEE" });

const row = (commodity: number, terminalId: number, o: Record<string, unknown>) => ({
  id_commodity: commodity,
  id_terminal: terminalId,
  commodity_name: ["", "A1", "B2", "C3", "D4", "E5"][commodity],
  terminal_name: TERMINALS.find((t) => t.id === terminalId)?.nickname,
  price_buy: 0,
  price_sell: 0,
  scu_buy: 0,
  scu_sell: 0,
  status_buy: 0,
  status_sell: 0,
  date_modified: secs(DAY),
  ...o,
});
const buy = (c: number, t: number, price: number) =>
  row(c, t, { price_buy: price, scu_buy: 1000, status_buy: 4 });
const sell = (c: number, t: number, price: number) =>
  row(c, t, { price_sell: price, status_sell: 3 });

const PRICES = [
  buy(1, 1, 100),
  sell(1, 3, 150),
  buy(2, 3, 200),
  sell(2, 4, 500),
  buy(3, 1, 50),
  sell(3, 4, 80),
  // Alpha Dock shares Alphaville's orbit but is another place: a hop away, not "here".
  buy(4, 1, 20),
  sell(4, 2, 60),
  buy(5, 2, 100),
  sell(5, 4, 350),
];
/** Player reports per terminal (0 = a UEX estimate). Goods 1 is reported at both ends; the others are not. */
const REPORTS: Record<number, Record<number, { b: number; s: number }>> = {
  1: { 1: { b: 4, s: 0 }, 3: { b: 0, s: 3 } },
  2: { 3: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
  3: { 1: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
};
const ORBITS = [
  [10, 20, "10"],
  [20, 30, "15"],
  [10, 30, "40"],
].map(([a, b, d]) => ({ id_orbit_origin: a, id_orbit_destination: b, distance: d }));

const env = (data: unknown) => ({ status: "ok", http_code: 200, data, message: "" });
let counter = 0;
function world(reports: typeof REPORTS = REPORTS) {
  const routes: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {
    "/commodities_prices_all": env(PRICES),
    "/terminals": env(TERMINALS),
    "/space_stations": env([arm(1), arm(2)]),
    "/cities": env([arm(1)]),
    "/outposts": env([arm(1)]),
    "/orbits_distances": env(ORBITS),
    "/commodities_prices": (p: Record<string, unknown>) =>
      env(
        Object.entries(reports[Number(p.id_commodity)] ?? {}).map(([t, r]) => ({
          id_terminal: Number(t),
          price_buy_users_rows: r.b,
          price_sell_users_rows: r.s,
        })),
      ),
    "/fuel_prices_all": env([{ date_modified: secs(DAY) }]),
  };
  const get = vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`fake: no route for ${url}`);
    return { data: typeof route === "function" ? await route(config?.params ?? {}) : route };
  });
  const client = {
    defaults: { baseURL: `https://position-${++counter}.test` },
    get,
  } as unknown as HttpClient;
  return { client, get };
}

const run = (req: Parameters<typeof planTrips>[1], reports: typeof REPORTS = REPORTS) => {
  const { client } = world(reports);
  return planTrips(
    { uexClient: client, scwClient: client },
    {
      cargoScu: 100,
      quantumSpeedMs: 100_000_000,
      ...req,
    },
  );
};

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: plans from the player's place, with an opening trade on the way", () => {
  it("Given a place typed as a city, Then the best option loads at Beta Port and opens with the A1 trade from Alphaville", async () => {
    const r = await run({ position: { text: "Alphaville" } });
    expect(r.position).toMatchObject({ label: "Alphaville", terminals: 1, basis: "exact" });
    const best = r.options[0]!;
    expect(best.opening).toBeDefined();
    expect(best.opening!.position).toBe("Alphaville");
    expect(best.opening!.at_position).toBe(false);
    expect(best.opening!.start_terminal).toBe("Beta Port");
    expect(best.opening!.step1).toMatchObject({ commodity: "A1", scu: 100, profit_for_leg: 5000 });
    expect(best.opening!.step1!.from.terminal).toBe("Alphaville");
    expect(best.opening!.step1!.to.terminal).toBe("Beta Port");
    // The route is the main legs, unchanged in meaning: B2 from Beta Port to Gamma Base.
    expect(best.legs[0]).toMatchObject({ commodity: "B2", scu: 100, profit_for_leg: 30000 });
    expect(best.legs[0]!.from.terminal).toBe("Beta Port");
    expect(best.opening!.first_cycle.profit).toBe(35000);
    expect(best.opening!.without_step1.profit).toBe(30000);
    expect(best.summary).toContain("Step 1 from Alphaville");
    expect(best.summary).toContain("[ESTIMATE]");
  });

  it("Given the player's own place has a route of its own, Then it is offered with no flight and no step 1", async () => {
    const r = await run({ position: { text: "Alphaville" } });
    const here = r.options.find((o) => o.opening?.at_position);
    expect(here).toBeDefined();
    expect(["A1", "C3"]).toContain(here!.legs[0]!.commodity);
    expect(here!.opening!.step1).toBeNull();
    expect(here!.opening!.reposition_gm).toBeNull();
    expect(here!.opening!.first_cycle.profit).toBe(here!.opening!.without_step1.profit);
  });

  it("Given a route that loads at another place of the same orbit (Alpha Dock), Then it is a short hop, not 'here', and can carry a step 1 from Alphaville", async () => {
    const r = await run({ position: { text: "Alphaville" } });
    const dock = r.options.find((o) => o.opening?.start_terminal === "Alpha Dock");
    expect(dock).toBeDefined();
    expect(dock!.opening!.at_position).toBe(false);
    expect(dock!.opening!.step1).toMatchObject({ commodity: "D4", profit_for_leg: 4000 });
    expect(dock!.opening!.step1!.from.terminal).toBe("Alphaville");
    expect(dock!.opening!.step1!.to.terminal).toBe("Alpha Dock");
    // Same orbit: no quantum flight, a local hop.
    expect(dock!.opening!.reposition_gm).toBe(0);
    expect(dock!.opening!.first_cycle.profit).toBe(dock!.legs[0]!.profit_for_leg + 4000);
    // The orbit's own name is the whole orbit: from there Alpha Dock IS here.
    const orbit = await run({ position: { text: "Alpha" } });
    expect(orbit.position?.terminals).toBe(2);
    expect(
      orbit.options.find((o) => o.opening?.start_terminal === "Alpha Dock")?.opening?.at_position,
    ).toBe(true);
  });

  it("Given a route with player reports and a step 1 that has none, Then the option is an estimate, not green", async () => {
    const reports: typeof REPORTS = {
      1: { 1: { b: 0, s: 0 }, 3: { b: 0, s: 0 } },
      2: { 3: { b: 2, s: 0 }, 4: { b: 0, s: 2 } },
      3: { 1: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
      4: { 1: { b: 0, s: 0 }, 2: { b: 0, s: 0 } },
      5: { 2: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
    };
    const r = await run({ position: { text: "Alphaville" } }, reports);
    const o = r.options.find((x) => x.legs[0]!.commodity === "B2" && x.opening?.step1)!;
    expect(o.legs.every((l) => l.report_status === "reported")).toBe(true);
    expect(o.opening!.step1!.report_status).toBe("estimate");
    expect(o.report_status).toBe("estimate");
    expect(o.estimate).toBe(true);
    expect(o.summary).toContain("[ESTIMATE]");
  });

  it("Given a step 1 dropped by min_reports, Then the option's figures and its place in the list follow the plain flight", async () => {
    const reports: typeof REPORTS = {
      1: { 1: { b: 0, s: 0 }, 3: { b: 0, s: 0 } },
      2: { 3: { b: 2, s: 0 }, 4: { b: 0, s: 2 } },
      3: { 1: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
      4: { 1: { b: 0, s: 0 }, 2: { b: 0, s: 0 } },
      5: { 2: { b: 0, s: 0 }, 4: { b: 0, s: 0 } },
    };
    const r = await run({ position: { text: "Alphaville" }, minReports: 1 }, reports);
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      expect(o.opening!.step1).toBeNull();
      expect(o.opening!.first_cycle).toEqual(o.opening!.without_step1);
    }
    expect(r.excluded["opening_steps_dropped_by_min_reports"]).toBeGreaterThan(0);
    // The displayed order follows the displayed first-cycle figure.
    const shown = r.options.map((o) => o.opening!.first_cycle.profit_per_hour ?? -1);
    expect(shown).toEqual([...shown].sort((a, b) => b - a));
  });

  it("Given every route is a candidate, Then the best option does not depend on how many are asked for", async () => {
    const all = await run({ position: { text: "Alphaville" } });
    const one = await run({ position: { text: "Alphaville" }, limit: 1 });
    expect(one.options).toHaveLength(1);
    expect(one.options[0]!.summary).toBe(all.options[0]!.summary);
    // The candidates are not cut to a steady-state top list first (every route and start is scored, then ranked).
    expect(all.candidates_scored).toBeGreaterThan(0);
  });

  it("Given the opening trade's goods, Then its player reports were checked (it is not 'unverified' for want of a look)", async () => {
    const r = await run({ position: { text: "Alphaville" } });
    expect(r.options[0]!.opening!.step1!.report_status).toBe("reported");
    // The route's own goods have no player report: the option says estimate, step 1 keeps its own status.
    expect(r.options[0]!.report_status).toBe("estimate");
  });

  it("Given min_reports, Then only options whose route has player reports stay, and the dropped ones are counted", async () => {
    const r = await run({ position: { text: "Alphaville" }, minReports: 1 });
    // Only A1 (reported at both ends) qualifies: the B2 and C3 routes are dropped and counted.
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => o.legs.every((l) => l.commodity === "A1"))).toBe(true);
    expect(r.excluded["options_with_fewer_reports_than_min_reports"]).toBeGreaterThan(0);
  });

  it("Given a budget, Then step 1 is sized by it and limited_by says so", async () => {
    // 2 000 aUEC buys 20 SCU of A1 at 100.
    const r = await run({ position: { text: "Alphaville" }, budget: 2000 });
    const best = r.options.find((o) => o.opening?.step1?.commodity === "A1");
    expect(best!.opening!.step1).toMatchObject({ scu: 20, limited_by: "budget" });
    expect(best!.opening!.step1!.cost).toBeLessThanOrEqual(2000);
  });

  it("Given a position, Then the open chains are not computed, and the answer says so", async () => {
    const r = await run({ position: { text: "Alphaville" } });
    expect(r.chains).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/open chains/i);
    expect(r.assumptions.join(" ")).toMatch(/FROM A POSITION/);
    // The ship's speed is known, so there are times.
    expect(r.options[0]!.opening!.first_cycle.profit_per_hour).not.toBeNull();
  });

  it("Given no speed is known, Then there is no hourly figure and the order falls back to the profit", async () => {
    const { client } = world();
    const r = await planTrips(
      { uexClient: client, scwClient: client },
      { cargoScu: 100, position: { text: "Alphaville" } },
    );
    // An option that needs a quantum flight has no time, so no hourly figure; a local hop still has one.
    const far = r.options.find((o) => (o.opening?.reposition_gm ?? 0) > 0)!;
    expect(far.opening!.first_cycle.profit_per_hour).toBeNull();
    expect(far.opening!.first_cycle.profit).toBeGreaterThan(0);
  });
});

describe("Feature: a position that cannot be placed is refused, never guessed", () => {
  it("Given an unknown place, Then the planner says so", async () => {
    await expect(run({ position: { text: "Nowhereville" } })).rejects.toThrow(
      /^Position: UEX knows no place/,
    );
  });

  it("Given a log token that names only a star system, Then it is not a position", async () => {
    await expect(run({ position: { token: "Teststar1" } })).rejects.toThrow(/^Position:/);
  });

  it("Given a log token with a city segment, Then it resolves to that city's orbit", async () => {
    const r = await run({ position: { token: "Teststar1_Alphaville" } });
    expect(r.position?.label).toBe("Alphaville");
  });

  it("Given a position and an origin, Then it is refused (origin says where a route loads)", async () => {
    await expect(
      run({ position: { text: "Alphaville" }, origin: { terminalName: "Beta Port" } }),
    ).rejects.toBeInstanceOf(TripPlanError);
  });

  it("Given no position, Then nothing changes: no opening on any option", async () => {
    const r = await run({});
    expect(r.position).toBeUndefined();
    expect(r.options.every((o) => o.opening === undefined)).toBe(true);
  });
});
