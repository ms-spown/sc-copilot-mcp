import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { planTrips } from "../providers/uex/tripPlanner.js";

/**
 * Feature: the planner keeps what UEX's per-commodity answer says about each leg (price range, stock, inventory of the buyer,
 * same-price terminals, reports on the commodity), for round trips AND for one-way routes. A synthetic two-terminal market.
 *
 *   T1 "Alpha Station" (orbit 326)   T2 "Beta City" (orbit 4), on the moon Gamma of planet Delta
 * Gold (10) is bought at T1 for 100 (500 SCU) and sold at T2 for 160; Laranite (11) goes the other way (50 -> 90).
 */

const NOW = Date.now();
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);
const env = (data: unknown) => ({ status: "ok", http_code: 200, data, message: "" });

const TERMINALS = [
  {
    id: 1,
    name: "Alpha Station full",
    nickname: "Alpha Station",
    id_planet: 1,
    id_orbit: 326,
    id_star_system: 68,
    star_system_name: "Stanton",
    planet_name: "Delta",
    moon_name: null,
    id_space_station: 1,
    id_city: 0,
    id_outpost: 0,
  },
  {
    id: 2,
    name: "Beta City full",
    nickname: "Beta City",
    id_planet: 1,
    id_orbit: 4,
    id_star_system: 68,
    star_system_name: "Stanton",
    planet_name: "Delta",
    moon_name: "Gamma",
    id_space_station: 0,
    id_city: 1,
    id_outpost: 0,
  },
];

const row = (c: number, t: number, o: Record<string, unknown>) => ({
  id_commodity: c,
  id_terminal: t,
  commodity_name: c === 10 ? "Gold" : "Laranite",
  terminal_name: t === 1 ? "Alpha Station" : "Beta City",
  price_buy: 0,
  price_sell: 0,
  scu_buy: 0,
  scu_sell_stock: 0,
  scu_sell: 0,
  status_buy: 0,
  status_sell: 0,
  date_modified: secs(DAY),
  ...o,
});

const PRICES_ALL = [
  row(10, 1, { price_buy: 100, scu_buy: 500, status_buy: 4 }),
  row(10, 2, { price_sell: 160, status_sell: 6 }),
  row(11, 2, { price_buy: 50, scu_buy: 200, status_buy: 4 }),
  row(11, 1, { price_sell: 90, status_sell: 3 }),
];

/** What `/commodities_prices?id_commodity=` returns: the same prices with their range and report counts. */
const BY_COMMODITY: Record<number, unknown[]> = {
  10: [
    row(10, 1, {
      price_buy: 100,
      price_buy_min: 100,
      price_buy_max: 100,
      price_buy_users_rows: 0,
      scu_buy: 500,
    }),
    row(10, 2, {
      price_sell: 160,
      price_sell_min: 120,
      price_sell_max: 160,
      price_sell_users_rows: 0,
      status_sell: 6,
    }),
  ],
  11: [
    row(11, 2, {
      price_buy: 50,
      price_buy_min: 40,
      price_buy_max: 60,
      price_buy_users_rows: 2,
      scu_buy: 200,
    }),
    row(11, 1, {
      price_sell: 90,
      price_sell_min: 70,
      price_sell_max: 95,
      price_sell_users_rows: 1,
      status_sell: 3,
    }),
  ],
};

let counter = 0;
function market(extra: Record<string, unknown> = {}, failing: string[] = []) {
  const get = vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (failing.includes(url)) throw new Error(`fake: ${url} is down`);
    const routes: Record<string, unknown> = {
      "/commodities_prices_all": env(PRICES_ALL),
      "/terminals": env(TERMINALS),
      "/space_stations": env([{ id: 1, is_armistice: 1, jurisdiction_name: null }]),
      "/cities": env([{ id: 1, is_armistice: 1, jurisdiction_name: null }]),
      "/outposts": env([]),
      "/orbits_distances": env([{ id_orbit_origin: 326, id_orbit_destination: 4, distance: "30" }]),
      "/commodities_prices": env(BY_COMMODITY[Number(config?.params?.id_commodity)] ?? []),
      "/fuel_prices_all": env([]),
      "/commodities": env([{ id: 10, name: "Gold", slug: "gold", code: "GOLD" }]),
      ...extra,
    };
    if (!(url in routes)) throw new Error(`fake: no route for ${url}`);
    return { data: routes[url] };
  });
  return {
    client: {
      defaults: { baseURL: `https://legmarket-${++counter}.test` },
      get,
    } as unknown as HttpClient,
    get,
  };
}
const scw = () =>
  ({ defaults: { baseURL: "https://scw.test" }, get: vi.fn() }) as unknown as HttpClient;

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: each leg carries the market facts UEX gave for its commodity", () => {
  it("Given a round trip, Then every leg has its ranges, stock, inventory and report coverage, and the bodies are named", async () => {
    const uex = market();
    const r = await planTrips(
      { uexClient: uex.client, scwClient: scw() },
      { cargoScu: 100, quantumSpeedMs: 238_314_300 },
    );
    const top = r.options.find((o) => o.mode === "round_trip")!;
    expect(top).toBeDefined();
    const gold = top.legs.find((l) => l.commodity === "Gold")!;
    expect(gold.market).toEqual({
      buy_range: { low: 100, high: 100 },
      sell_range: { low: 120, high: 160 },
      stock_scu: 500,
      sell_inventory: { code: 6, fill: "72-85%" },
      sell_peers: { same_price: 1, priced: 1 },
      commodity_reports: { reported: 0, terminals: 2 },
    });
    expect(gold.reports).toEqual({ origin: 0, destination: 0 });
    const lara = top.legs.find((l) => l.commodity === "Laranite")!;
    expect(lara.market?.commodity_reports).toEqual({ reported: 2, terminals: 2 });
    // the moon wins over the planet as the body of a terminal
    const places = [gold.from, gold.to];
    expect(places.map((p) => p.body).sort()).toEqual(["Delta", "Gamma"]);
    expect(top.trip.flights_gm).toEqual([30, 30]);
  });

  it("Given a commodity whose per-commodity answer could not be read, Then its legs have no market and are 'unverified'", async () => {
    const uex = market({}, ["/commodities_prices"]);
    const r = await planTrips(
      { uexClient: uex.client, scwClient: scw() },
      { cargoScu: 100, quantumSpeedMs: 238_314_300 },
    );
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options)
      for (const l of o.legs) {
        expect(l.market).toBeNull();
        expect(l.report_status).toBe("unverified");
        expect(l.reports).toEqual({ origin: null, destination: null });
      }
  });

  it("Given a one-way route, Then its commodity is read once for the market facts and its report counts still come from the route", async () => {
    const uex = market({
      "/commodities_routes": env([
        {
          id_commodity: 10,
          id_terminal_origin: 1,
          id_terminal_destination: 2,
          commodity_name: "Gold",
          origin_terminal_name: "Alpha Station",
          destination_terminal_name: "Beta City",
          price_origin: 100,
          price_destination: 160,
          scu_reachable: 300,
          scu_destination: 0,
          distance: 30,
          price_origin_users_rows: 4,
          price_destination_users_rows: 5,
        },
      ]),
    });
    const r = await planTrips(
      { uexClient: uex.client, scwClient: scw() },
      {
        cargoScu: 400,
        quantumSpeedMs: 238_314_300,
        maxLegs: 1,
        origin: { commodityName: "Gold" },
      },
    );
    const one = r.options[0];
    expect(one.mode).toBe("one_way");
    expect(one.legs[0].reports).toEqual({ origin: 4, destination: 5 });
    expect(one.legs[0].limited_by).toBe("stock");
    expect(one.legs[0].market?.sell_range).toEqual({ low: 120, high: 160 });
    const reads = uex.get.mock.calls.filter(
      (c) => c[0] === "/commodities_prices" && c[1]?.params?.id_commodity === 10,
    );
    expect(reads).toHaveLength(1);
  });
});
