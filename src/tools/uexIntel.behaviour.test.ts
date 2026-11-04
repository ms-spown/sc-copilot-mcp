/* eslint-disable @typescript-eslint/no-explicit-any */
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { forModelTool, planTrips } from "../providers/uex/tripPlanner.js";
import { medicalCase } from "../dashboard/testing/tripOptionFixtures.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { CATALOG } from "./catalog.js";
import { allTools, createRegistry } from "./registry.js";

/**
 * Feature: trade intelligence from UEX (price history, stock status, profit-per-hour planner).
 * The outside world is faked with a small synthetic market; nothing here is real game data.
 *
 * The world: four Stanton terminals and two Pyro ones.
 *   T1 ARC-L1 station (orbit 326, armistice)   T2 Area 18 city (orbit 4, armistice)
 *   T3 Lorville city (orbit 116, armistice)    T4 mining outpost (orbit 4, NOT armistice)
 *   T5, T6 Pyro stations (orbits 400, 401, NOT armistice)
 * Orbit distances (Gm, sent as strings like UEX does): 326-4: 30, 4-116: 23, 326-116: 60, 400-401: 20.
 */

const NOW = Date.now();
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);

const terminal = (id: number, nick: string, extra: Record<string, unknown>) => ({
  id,
  name: `${nick} full name`,
  nickname: nick,
  id_planet: 1,
  star_system_name: "Stanton",
  planet_name: "ArcCorp",
  id_star_system: 68,
  id_space_station: 0,
  id_city: 0,
  id_outpost: 0,
  ...extra,
});
const TERMINALS = [
  terminal(1, "ARC-L1", { id_orbit: 326, id_space_station: 1 }),
  terminal(2, "Area 18", { id_orbit: 4, id_city: 1 }),
  terminal(3, "Lorville", { id_orbit: 116, id_city: 2, planet_name: "Hurston", id_planet: 2 }),
  terminal(4, "Mining 056", { id_orbit: 4, id_outpost: 1 }),
  terminal(5, "Ruin Station", {
    id_orbit: 400,
    id_space_station: 9,
    id_star_system: 64,
    star_system_name: "Pyro",
    planet_name: "Pyro I",
    id_planet: 9,
  }),
  terminal(6, "Checkmate", {
    id_orbit: 401,
    id_space_station: 10,
    id_star_system: 64,
    star_system_name: "Pyro",
    planet_name: "Pyro I",
    id_planet: 9,
  }),
];
const arm = (id: number, is_armistice: number, jurisdiction_name: string | null = null) => ({
  id,
  is_armistice,
  jurisdiction_name,
});

const priceRow = (
  commodity: number,
  terminalId: number,
  o: Record<string, unknown>,
  ageMs = DAY,
) => ({
  id_commodity: commodity,
  id_terminal: terminalId,
  commodity_name: [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "Gold",
    "Laranite",
    "Cheap",
    "Silver",
    "Copper",
  ][commodity],
  terminal_name: TERMINALS.find((t) => t.id === terminalId)?.nickname,
  price_buy: 0,
  price_sell: 0,
  scu_buy: 0,
  scu_sell_stock: 0,
  scu_sell: 0,
  status_buy: 0,
  status_sell: 0,
  date_modified: secs(ageMs),
  ...o,
});
const buy = (c: number, t: number, price: number, scu = 500) =>
  priceRow(c, t, { price_buy: price, scu_buy: scu, status_buy: 4 });
const sell = (c: number, t: number, price: number, status = 3) =>
  priceRow(c, t, { price_sell: price, status_sell: status });

const PRICES_ALL = [
  buy(10, 1, 100),
  sell(10, 2, 160),
  buy(11, 2, 50, 200),
  sell(11, 1, 90, 2),
  buy(13, 2, 30, 100),
  sell(13, 4, 50),
  buy(14, 4, 10, 100),
  sell(14, 2, 25),
  sell(10, 4, 400, 7), // Gold: no demand at T4, must never be a destination
  priceRow(12, 1, { price_buy: 10, scu_buy: 500, status_buy: 4 }, 100 * DAY), // stale
  sell(12, 2, 200),
  // Pyro: a very profitable round trip
  buy(10, 5, 40),
  sell(10, 6, 300),
  buy(11, 6, 20),
  sell(11, 5, 200),
];

/** Who reported what (commodities_prices?id_commodity=...): 0 reports = a UEX estimate. */
const REPORTS: Record<number, Record<number, { b: number; s: number }>> = {
  10: { 1: { b: 5, s: 0 }, 2: { b: 0, s: 0 }, 5: { b: 3, s: 0 }, 6: { b: 0, s: 2 } },
  11: { 2: { b: 3, s: 0 }, 1: { b: 0, s: 4 }, 6: { b: 1, s: 0 }, 5: { b: 0, s: 1 } },
  13: { 2: { b: 2, s: 0 }, 4: { b: 0, s: 2 } },
  14: { 4: { b: 1, s: 0 }, 2: { b: 0, s: 1 } },
};

const ORBITS_STANTON = [
  [326, 4, "30"],
  [4, 116, "23"],
  [326, 116, "60"],
].map(([a, b, d]) => ({ id_orbit_origin: a, id_orbit_destination: b, distance: d }));
const ORBITS_PYRO = [{ id_orbit_origin: 400, id_orbit_destination: 401, distance: "20" }];

let counter = 0;
function fake(routes: Record<string, unknown | ((params: Record<string, unknown>) => unknown)>) {
  const get = vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`fake: no route for ${url}`);
    return { data: typeof route === "function" ? await route(config?.params ?? {}) : route };
  });
  return {
    client: {
      defaults: { baseURL: `https://intel-${++counter}.test` },
      get,
    } as unknown as HttpClient,
    get,
  };
}
const env = (data: unknown) => ({ status: "ok", http_code: 200, data, message: "" });

function market(extra: Record<string, unknown> = {}) {
  return fake({
    "/commodities_prices_all": env(PRICES_ALL),
    "/terminals": env(TERMINALS),
    "/space_stations": env([arm(1, 1), arm(9, 0, "Rough & Ready"), arm(10, 0)]),
    "/cities": env([arm(1, 1), arm(2, 1)]),
    "/outposts": env([arm(1, 0)]),
    "/orbits_distances": (p: Record<string, unknown>) =>
      env(p.id_star_system_origin === 64 ? ORBITS_PYRO : ORBITS_STANTON),
    "/commodities_prices": (p: Record<string, unknown>) => {
      const per = REPORTS[Number(p.id_commodity)] ?? {};
      return env(
        Object.entries(per).map(([t, r]) => ({
          id_terminal: Number(t),
          id_commodity: Number(p.id_commodity),
          price_buy_users_rows: r.b,
          price_sell_users_rows: r.s,
        })),
      );
    },
    "/fuel_prices_all": env([
      { date_modified: secs(2 * DAY) },
      { date_modified: secs(40 * DAY) },
      { date_modified: secs(50 * DAY) },
    ]),
    "/commodities": env([
      { id: 10, name: "Gold", slug: "gold", code: "GOLD" },
      { id: 11, name: "Laranite", slug: "laranite", code: "LARA" },
    ]),
    "/vehicles": env([{ name: "Cutlass Black", name_full: "Drake Cutlass Black", scu: 46 }]),
    ...extra,
  });
}
const wiki = () =>
  fake({
    "/vehicles/Cutlass%20Black": {
      data: { quantum: { quantum_speed: 238314300, quantum_spool_time: 6.9 }, cargo_capacity: 46 },
    },
  });

const deps = (uex: { client: HttpClient }) => ({
  uexClient: uex.client,
  scwClient: wiki().client,
});

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: uex_plan_trade ranks options by estimated profit per hour", () => {
  it("Given a ship, Then the best option is the round trip that pays most per hour, with its figures and assumptions", async () => {
    const r = await planTrips(deps(market()), { shipName: "Cutlass Black", avoidPyro: true });
    expect(r.ship).toMatchObject({ name: "Drake Cutlass Black", quantum_speed_ms: 238314300 });
    expect(r.cargo_scu_used).toBe(46);
    const top = r.options.find(
      (o) =>
        o.mode === "round_trip" &&
        o.legs[0].from.terminal === "ARC-L1" &&
        o.legs[0].to.terminal === "Area 18",
    )!;
    expect(top).toBeDefined();
    expect(top.trip.profit_per_cycle).toBe(4600);
    expect(top.trip.flights_gm).toEqual([30, 30]);
    const cycle = 2 * 480 + 2 * (6.9 + 30e9 / 238314300);
    expect(top.trip.cycle_seconds).toBe(Math.round(cycle));
    expect(top.trip.profit_per_hour).toBe(Math.round((4600 / cycle) * 3600));
    expect(top.trip.profit_per_scu).toBe(50);
    expect(top.trip.distance_basis).toEqual(["orbits_distances", "orbits_distances"]);
    expect(r.time_model.estimate).toBe(true);
    expect(r.assumptions.join(" ")).toContain("ESTIMATE");
    // The objective decides the order: sorted by profit per hour, descending, estimates included.
    const perHour = r.options.map((o) => o.trip.profit_per_hour as number);
    expect(perHour.length).toBeGreaterThan(1);
    expect([...perHour].sort((a, b) => b - a)).toEqual(perHour);
    expect(r.options.every((o) => o.trip.returns_to_start)).toBe(true);
  });

  it("Then a price nobody reported is flagged an estimate on the option, its summary and the counts, without reordering by it", async () => {
    const r = await planTrips(deps(market()), { shipName: "Cutlass Black", avoidPyro: true });
    // T1<->T2 has Gold at T2 with 0 reports (estimate) and is the most profitable; T2<->T4 is fully reported.
    const byPair = (a: string, b: string) =>
      r.options.find((o) => o.legs[0].from.terminal === a && o.legs[0].to.terminal === b);
    const estimate = byPair("ARC-L1", "Area 18");
    const reported = byPair("Area 18", "Mining 056");
    expect(estimate?.legs[0].report_status).toBe("estimate");
    expect(estimate?.legs[0].is_estimate).toBe(true);
    expect(estimate?.legs[0].estimated_sides).toEqual(["destination"]);
    expect(estimate).toMatchObject({ report_status: "estimate", estimate: true });
    expect(estimate?.summary.startsWith("[ESTIMATE] ")).toBe(true);
    expect(reported).toMatchObject({ report_status: "reported", estimate: false });
    expect(reported?.summary.startsWith("[")).toBe(false);
    // The objective decides: the better estimate stays above the reported option.
    expect(r.options.indexOf(estimate!)).toBeLessThan(r.options.indexOf(reported!));
    expect(r.report_counts.estimate).toBeGreaterThan(0);
    expect(r.report_counts.reported).toBeGreaterThan(0);
    expect(r.min_reports_note).toContain("min_reports");
    expect(r.notes.join(" ")).toContain("report_status");
  });

  it("Then two-leg chains are a separate list with no return priced, never mixed into options", async () => {
    const r = await planTrips(deps(market()), { shipName: "Cutlass Black", avoidPyro: true });
    expect(r.chains.length).toBeGreaterThan(0);
    expect(r.chains.every((c) => c.mode === "two_leg" && !c.trip.returns_to_start)).toBe(true);
    expect(r.options.some((o) => o.mode === "two_leg")).toBe(false);
    expect(r.lists_note).toContain("not comparable");
    const perHour = r.chains.map((c) => c.trip.profit_per_hour as number);
    expect([...perHour].sort((a, b) => b - a)).toEqual(perHour);
  });

  it("Then without min_reports an unverified option is kept and tagged, and the failed check is named in the notes", async () => {
    const failing = market({
      "/commodities_prices": () => {
        throw new Error("boom");
      },
    });
    const open = await planTrips(deps(failing), { shipName: "Cutlass Black", avoidPyro: true });
    expect(open.options.length).toBeGreaterThan(0);
    expect(open.options.every((o) => o.report_status === "unverified")).toBe(true);
    expect(open.options[0].summary.startsWith("[UNVERIFIED] ")).toBe(true);
    expect(open.notes.join(" ")).toMatch(/player-report check failed for \d+ commodit/);
    expect(open.notes.join(" ")).toContain("boom");
  });

  it("Then with min_reports an option whose reports could not be checked is dropped and counted", async () => {
    const failing = market({
      "/commodities_prices": () => {
        throw new Error("boom");
      },
    });
    const strict = await planTrips(deps(failing), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      minReports: 5,
    });
    expect(strict.options).toEqual([]);
    expect(strict.chains).toEqual([]);
    expect(strict.excluded.options_unverified_dropped_by_min_reports).toBeGreaterThan(0);
    expect(strict.notes.join(" ")).toContain("player-report check failed");
  });

  it("Then min_reports keeps only options whose every end has that many player reports", async () => {
    const r = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      minReports: 1,
    });
    // Only T2<->T4 (Silver and Copper) has a report at every end.
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => o.report_status === "reported")).toBe(true);
    for (const o of r.options) {
      for (const l of o.legs) {
        expect(l.reports.origin).toBeGreaterThanOrEqual(1);
        expect(l.reports.destination).toBeGreaterThanOrEqual(1);
      }
    }
    expect(r.excluded.options_with_fewer_reports_than_min_reports).toBeGreaterThan(0);
  });

  it("Then a circuit breaker stops the report check at the first timeout or 429 and says so", async () => {
    let calls = 0;
    const slow = market({
      "/commodities_prices": () => {
        calls++;
        throw new AxiosError("timeout", "ECONNABORTED");
      },
    });
    const r = await planTrips(deps(slow), { shipName: "Cutlass Black", avoidPyro: true });
    expect(calls).toBe(1);
    expect(r.notes.join(" ")).toContain("check stopped early");
    expect(r.options.every((o) => o.report_status === "unverified")).toBe(true);
  });

  it("Then a round trip from a requested terminal or planet starts its first purchase there", async () => {
    const fromT2 = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      origin: { terminalName: "Area 18" },
    });
    const rt = fromT2.options.filter((o) => o.mode === "round_trip");
    expect(rt.length).toBeGreaterThan(0);
    for (const o of rt) expect(o.legs[0].from.terminal).toBe("Area 18");
    // Area 18 first buys Laranite for ARC-L1 (not the Gold the reverse direction would start with).
    expect(rt.find((o) => o.legs[0].to.terminal === "ARC-L1")?.legs[0].commodity).toBe("Laranite");

    clearCache();
    const fromHurston = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      origin: { planetName: "Hurston" },
    });
    for (const o of [...fromHurston.options, ...fromHurston.chains]) {
      expect(o.legs[0].from.planet).toBe("Hurston");
    }
    clearCache();
    const fromArc = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      origin: { planetName: "ArcCorp" },
    });
    expect(fromArc.options.length).toBeGreaterThan(0);
    for (const o of [...fromArc.options, ...fromArc.chains]) {
      expect(o.legs[0].from.planet).toBe("ArcCorp");
    }
  });

  it("Then a failure of the UEX routes call degrades to the offline plans, with a note", async () => {
    const down = () =>
      market({
        "/commodities_routes": () => {
          throw new Error("routes down");
        },
      });
    const r = await planTrips(deps(down()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      origin: { terminalName: "Area 18" },
    });
    expect(r.notes.join(" ")).toContain("UEX routes could not be read");
    expect(r.options.some((o) => o.mode === "round_trip")).toBe(true);
    clearCache();
    await expect(
      planTrips(deps(down()), {
        shipName: "Cutlass Black",
        maxLegs: 1,
        origin: { commodityName: "Gold" },
      }),
    ).rejects.toThrow(/nothing else to show/);
  });

  it("Then the plan has a deadline: a source that never answers ends it with what is known", async () => {
    const hang = market({ "/commodities_prices": () => new Promise(() => undefined) });
    const r = await planTrips(
      { ...deps(hang), deadlineMs: 150 },
      { shipName: "Cutlass Black", avoidPyro: true },
    );
    expect(r.notes.join(" ")).toMatch(/stopped early|time allowed/);
    expect(r.options.every((o) => o.report_status === "unverified")).toBe(true);
  });

  it("Then rows without a date are counted apart from old ones, and a fractional hold is rounded down", async () => {
    const undated = { ...sell(10, 2, 160), date_modified: undefined };
    const uex = market({
      "/commodities_prices_all": env([
        ...PRICES_ALL.filter((p) => !(p.id_commodity === 10 && p.id_terminal === 2)),
        undated,
      ]),
    });
    const r = await planTrips(deps(uex), {
      cargoScu: 46.9,
      quantumSpeedMs: 238314300,
      avoidPyro: true,
    });
    expect(r.excluded.price_rows_without_date).toBe(1);
    expect(r.excluded.price_rows_older_than_max_age).toBe(1);
    expect(r.cargo_scu_used).toBe(46);
    await expect(planTrips(deps(market()), { cargoScu: 0.5 })).rejects.toThrow(/at least 1 SCU/);
  });

  it("Then stop_minutes is rounded, not floored", async () => {
    const r = await planTrips(deps(market()), {
      cargoScu: 46,
      quantumSpeedMs: 238314300,
      avoidPyro: true,
      stopMinutes: 9.6,
    });
    expect(r.time_model.stop_minutes).toBe(10);
  });

  it("Then every leg says how old its prices are, and old prices are left out and counted", async () => {
    const r = await planTrips(deps(market()), { shipName: "Cutlass Black", avoidPyro: true });
    const leg = r.options[0].legs[0];
    expect(leg.price_age_days.buy).toBeCloseTo(1, 0);
    expect(leg.stale).toBe(false);
    expect(r.options[0].data_age.stale).toBe(false);
    expect(r.excluded.price_rows_older_than_max_age).toBe(1);
    // Nothing offers Cheap (the 100-day-old buy row), and no leg sells at T4 for Gold (no demand).
    expect(JSON.stringify(r.options)).not.toContain("Cheap");
    const kept = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      avoidPyro: true,
      includeStale: true,
    });
    const cheap = kept.options.flatMap((o) => o.legs).find((l) => l.commodity === "Cheap");
    expect(cheap?.stale).toBe(true);
  });

  it("Then Pyro is in the ranking unless avoided, and its safety heuristic is higher", async () => {
    const withPyro = await planTrips(deps(market()), { shipName: "Cutlass Black" });
    expect(withPyro.options[0].legs[0].from.system).toBe("Pyro");
    expect(withPyro.options[0].safety).toMatchObject({ heuristic: true, exposure: "higher" });
    const without = await planTrips(deps(market()), { shipName: "Cutlass Black", avoidPyro: true });
    expect(without.options.every((o) => o.legs.every((l) => l.from.system === "Stanton"))).toBe(
      true,
    );
  });

  it("Then armistice_only keeps only stops UEX flags as armistice zones", async () => {
    const r = await planTrips(deps(market()), { shipName: "Cutlass Black", armisticeOnly: true });
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      for (const l of o.legs) {
        expect(l.from.armistice_zone).toBe(true);
        expect(l.to.armistice_zone).toBe(true);
      }
      expect(o.safety.exposure).toBe("lower");
    }
  });

  it("Then the safety objective puts the fewest risk factors first, and speed the shortest run", async () => {
    const safe = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      objective: "safety",
    });
    const points = safe.options
      .filter((o) => o.legs.every((l) => l.report_status === "reported"))
      .map((o) => o.safety.points);
    expect(points.length).toBeGreaterThan(1);
    expect([...points].sort((a, b) => a - b)).toEqual(points);
    const fast = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      objective: "speed",
      avoidPyro: true,
    });
    const times = fast.options.map((o) => o.trip.cycle_seconds as number);
    // Reported options come first; inside that group the shortest run leads.
    const reported = fast.options.filter((o) =>
      o.legs.every((l) => l.report_status === "reported"),
    );
    const t = reported.map((o) => o.trip.cycle_seconds as number);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(times.length).toBeGreaterThan(0);
  });

  it("Then without a ship it needs a hold size, and without a speed it ranks by profit and says so", async () => {
    await expect(planTrips(deps(market()), {})).rejects.toThrow(/cargo_scu|hold/);
    const r = await planTrips(deps(market()), { cargoScu: 20, avoidPyro: true });
    const flying = r.options.find((o) => o.trip.flights_gm[0] > 0)!;
    expect(flying.trip.profit_per_hour).toBeNull();
    expect(flying.trip.cycle_seconds).toBeNull();
    // A hop inside one orbit needs no speed.
    expect(r.options.find((o) => o.trip.flights_gm[0] === 0)?.trip.cycle_seconds).toBe(
      2 * 480 + 2 * 120,
    );
    expect(r.notes.join(" ")).toContain("No quantum speed is known");
    const r2 = await planTrips(deps(market()), {
      cargoScu: 20,
      quantumSpeedMs: 238314300,
      avoidPyro: true,
    });
    expect(r2.options[0].trip.profit_per_hour).toBeGreaterThan(0);
  });

  it("Then the budget limits the quantity, and the fuel is left out with the measured freshness", async () => {
    const r = await planTrips(deps(market()), {
      shipName: "Cutlass Black",
      budget: 1000,
      avoidPyro: true,
    });
    const gold = r.options.flatMap((o) => o.legs).find((l) => l.commodity === "Gold");
    expect(gold).toMatchObject({ scu: 10, limited_by: "budget" });
    expect(r.fuel.included).toBe(false);
    expect(r.fuel.reason).toContain("Of 3 fuel price rows, 1 were reported within 7 days");
  });

  it("Then a one-way route from UEX uses its distance, then the orbit matrix, and drops a pair UEX cannot place (data:false)", async () => {
    const route = (o: Record<string, unknown>) => ({
      id_commodity: 10,
      id_terminal_origin: 1,
      id_terminal_destination: 2,
      id_star_system_origin: 68,
      id_star_system_destination: 68,
      id_orbit_origin: 326,
      id_orbit_destination: 4,
      price_origin: 100,
      price_destination: 160,
      price_origin_users_rows: 5,
      price_destination_users_rows: 2,
      scu_reachable: 400,
      distance: 0,
      commodity_name: "Gold",
      origin_terminal_name: "ARC-L1",
      destination_terminal_name: "Area 18",
      ...o,
    });
    const uex = market({
      "/commodities_routes": env([
        route({ distance: "40" }), // a string, used as is
        route({
          id_terminal_destination: 3,
          id_orbit_destination: 116,
          destination_terminal_name: "Lorville",
        }), // orbit matrix: 60
        route({
          id_terminal_origin: 1,
          id_terminal_destination: 5,
          destination_terminal_name: "Ruin Station",
        }), // other system
      ]),
      "/terminals_distances": { status: "ok", http_code: 200, data: false, message: "" },
    });
    const r = await planTrips(deps(uex), {
      shipName: "Cutlass Black",
      maxLegs: 1,
      origin: { commodityName: "Gold" },
      includeStale: true,
    });
    expect(r.options.map((o) => o.mode)).toEqual(["one_way", "one_way"]);
    const gms = r.options.map((o) => o.trip.flights_gm[0]).sort((a, b) => a - b);
    expect(gms).toEqual([40, 60]);
    const bases = r.options.flatMap((o) => o.trip.distance_basis);
    expect(bases).toEqual(expect.arrayContaining(["route", "orbits_distances"]));
    expect(r.excluded.plans_without_known_distance).toBe(1);
    // Reports come from the route itself.
    expect(r.options[0].legs[0].reports).toEqual({ origin: 5, destination: 2 });
    expect(r.options[0].legs[0].report_status).toBe("reported");
  });

  it("Then max_legs 1 without an origin is refused with the reason", async () => {
    await expect(
      planTrips(deps(market()), { shipName: "Cutlass Black", maxLegs: 1 }),
    ).rejects.toThrow(/needs an origin/);
  });
});

describe("Feature: the three tools through the registry", () => {
  function registry(uex: { client: HttpClient }) {
    const e = fake({}).client;
    return createRegistry(
      allTools({
        uexClient: uex.client,
        scwClient: wiki().client,
        sctClient: e,
        scmdb: new Scmdb({ raw: e, api: e, repo: "o/r", cacheDir: () => "unused" }),
        gameLog: new GameLog({}),
        fleet: new FleetStore("unused-fleet.json"),
      }),
      {},
      { now: () => NOW, gameVersionFor: async () => "4.10.2" },
    );
  }
  const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

  it("declares the three tools in the trade profile only, so core stays under 15", () => {
    for (const name of ["uex_get_price_history", "uex_get_market_status", "uex_plan_trade"]) {
      expect(CATALOG[name].profiles).toEqual(["trade"]);
    }
  });

  it("uex_plan_trade answers within the output budget and carries the real data age in its provenance", async () => {
    const out = await registry(market()).call("uex_plan_trade", {
      ship_name: "Cutlass Black",
      avoid_pyro: true,
      limit: 20,
    });
    expect(out.isError).toBeUndefined();
    const b = body(out);
    expect(b.provenance.data_age).toMatch(/d$|h$/);
    expect(b.provenance.data_age_note).toContain("date_modified");
    expect(out.content[0].text.length).toBeLessThan(60_000);
    expect(b.data.options[0].safety.heuristic).toBe(true);
    expect(b.data.fuel.included).toBe(false);
  });

  it("uex_plan_trade leaves the dashboard-only fields (market on legs, body on places) out of the model's answer", async () => {
    const out = await registry(market()).call("uex_plan_trade", {
      ship_name: "Cutlass Black",
      avoid_pyro: true,
      limit: 20,
    });
    const b = body(out);
    const legs = [...b.data.options, ...b.data.chains].flatMap((o: any) => o.legs);
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) {
      expect(Object.keys(l)).not.toContain("market");
      expect(Object.keys(l.from)).not.toContain("body");
      expect(Object.keys(l.to)).not.toContain("body");
    }
    expect(out.content[0].text).not.toContain('"market"');
    expect(out.content[0].text).not.toContain('"body"');
  });

  it("uex_plan_trade keeps the number of options it returned before the dashboard fields existed, at the default limit", () => {
    // 8 options and 8 chains of 2 legs with long names: the answer is cut to a character budget by dropping whole options, so
    // any field added to the model's answer would silently return fewer of them.
    const big = (withDashboardFields: boolean) => {
      const options = Array.from({ length: 8 }, (_, i) => {
        const o = medicalCase();
        o.legs.forEach((l) => {
          l.commodity = `Medical Supplies ${i}`;
          l.from.terminal = `Admin - Port Tressler (Stanton) ${i}`;
          l.to.terminal = `TDD - Trade and Development Division - Area18 ${i}`;
          if (!withDashboardFields) {
            delete (l as any).market;
            delete (l.from as any).body;
            delete (l.to as any).body;
          }
        });
        return o;
      });
      return {
        options,
        chains: options.map((o) => ({ ...o })),
        rest: { objective: "profit_per_hour" },
      } as any;
    };
    const before = big(false);
    const now = forModelTool(big(true));
    expect(JSON.stringify({ options: now.options, chains: now.chains })).toBe(
      JSON.stringify({ options: before.options, chains: before.chains }),
    );
  });

  it("uex_plan_trade turns a bad argument into an error result, not a crash", async () => {
    const out = await registry(market()).call("uex_plan_trade", { avoid_pyro: true });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/hold size/);
  });

  describe("uex_get_price_history", () => {
    const history = (prices: number[]) =>
      prices.map((p, i) => ({
        price_sell: p,
        price_buy: 0,
        date_added: secs((prices.length - i) * DAY),
      }));
    const uexWith = (rows: unknown) => market({ "/commodities_prices_history": env(rows) });

    it("gives the points, the statistics, the verdict and a SHORT history notice", async () => {
      const out = await registry(uexWith(history([5000, 5200, 4900, 5100, 5500]))).call(
        "uex_get_price_history",
        { commodity_name: "Gold", terminal_name: "Area 18" },
      );
      const d = body(out).data;
      expect(d.short_history).toBe(true);
      expect(d.short_history_notice).toContain("SHORT HISTORY");
      const sell = d.sides[0];
      expect(sell).toMatchObject({
        side: "sell",
        points_used: 5,
        low: 4900,
        high: 5500,
        verdict: "high",
      });
      expect(sell.points).toHaveLength(5);
      expect(body(out).provenance.data_age).toBeTruthy();
    });

    it("answers no_data explicitly when UEX answers `data: false`", async () => {
      const out = await registry(uexWith(false)).call("uex_get_price_history", {
        commodity_name: "Gold",
        terminal_name: "Area 18",
      });
      expect(out.isError).toBeUndefined();
      expect(body(out).data).toMatchObject({ status: "no_data", commodity: "Gold" });
    });

    it("refuses an ambiguous or unknown name with the candidates", async () => {
      const out = await registry(uexWith([])).call("uex_get_price_history", {
        commodity_name: "Unobtainium",
        terminal_name: "Area 18",
      });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain("No UEX commodity matches");
    });
  });

  describe("uex_get_market_status", () => {
    const rows = [
      {
        ...buy(10, 1, 100, 0),
        status_buy: 1,
        scu_buy: 0,
        price_buy_users_rows: 0,
        star_system_name: "Stanton",
        commodity_name: "Gold",
        terminal_name: "ARC-L1",
      },
      {
        ...sell(10, 2, 160, 7),
        price_sell_users_rows: 3,
        star_system_name: "Stanton",
        commodity_name: "Gold",
        terminal_name: "Area 18",
      },
      {
        ...sell(10, 3, 170, 1),
        price_sell_users_rows: 2,
        star_system_name: "Stanton",
        commodity_name: "Gold",
        terminal_name: "Lorville",
      },
      {
        ...buy(10, 5, 40),
        price_buy_users_rows: 4,
        star_system_name: "Pyro",
        commodity_name: "Gold",
        terminal_name: "Ruin Station",
        date_modified: secs(30 * DAY),
      },
    ];
    const uex = () =>
      market({
        "/commodities_prices": env(rows),
        "/commodities_status": env({ buy: [], sell: [] }),
      });

    it("warns critical first, labels the sides the right way round and flags stale and estimates", async () => {
      const out = await registry(uex()).call("uex_get_market_status", { commodity_name: "Gold" });
      const d = body(out).data;
      expect(d.critical_rows).toBe(2);
      expect(d.legend_source).toBe("built_in");
      expect(d.rows[0].warnings[0].severity).toBe("critical");
      const area = d.rows.find((r: { terminal: string }) => r.terminal === "Area 18");
      expect(area.sell.level).toContain("No Demand");
      expect(area.warnings[0].code).toBe("sell_no_demand");
      const arc = d.rows.find((r: { terminal: string }) => r.terminal === "ARC-L1");
      expect(arc.buy.is_estimate).toBe(true);
      expect(arc.warnings[0].code).toBe("buy_out_of_stock");
      const pyro = d.rows.find((r: { terminal: string }) => r.terminal === "Ruin Station");
      expect(pyro.stale).toBe(true);
      expect(pyro.buy.is_estimate).toBe(false);
    });

    it("keeps only the warnings when asked, and one system when asked", async () => {
      const w = body(
        await registry(uex()).call("uex_get_market_status", {
          commodity_name: "Gold",
          only_warnings: true,
        }),
      ).data;
      expect(w.rows).toHaveLength(2);
      const s = body(
        await registry(uex()).call("uex_get_market_status", {
          commodity_name: "Gold",
          star_system_name: "Pyro",
        }),
      ).data;
      expect(s.rows).toHaveLength(1);
    });

    it("needs a commodity or a terminal", async () => {
      const out = await registry(uex()).call("uex_get_market_status", {});
      expect(out.isError).toBe(true);
    });

    it("answers no_data explicitly when UEX has nothing", async () => {
      const out = await registry(
        market({ "/commodities_prices": env(false), "/commodities_status": env(null) }),
      ).call("uex_get_market_status", { commodity_name: "Gold" });
      expect(body(out).data.status).toBe("no_data");
    });
  });
});
