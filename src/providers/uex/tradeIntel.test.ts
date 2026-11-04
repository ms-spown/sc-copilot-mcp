import { AxiosError } from "axios";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import { createUexClient } from "./client.js";
import { fetchTerminalDistance, fetchOrbitMatrix, orbitDistance } from "./distances.js";
import { summarizeHistory, summarizeSide } from "./history.js";
import { assessRow, BUILT_IN_LEGEND, parseLegend } from "./marketStatus.js";
import { ageDays, toNumber, unwrapData } from "./normalize.js";
import { safetyOf, type TerminalPlace } from "./places.js";
import { buildLegs, parsePriceRows, roundTrips, routeLeg, twoLegChains } from "./planner.js";
import {
  cycleSeconds,
  formatDuration,
  legSeconds,
  validQuantumSpeed,
  type TravelModel,
} from "./travel.js";

/** The real UEX client (interceptors included) answering a fixed body without the network. */
function uexAnswering(status: number, body: unknown) {
  const client = createUexClient("https://api.uexcorp.uk/2.0", "TOKEN");
  client.defaults.adapter = async (config) => {
    const response = { data: body, status, statusText: "", headers: {}, config };
    if (status >= 400) {
      throw new AxiosError(
        "Request failed",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        response as never,
      );
    }
    return response;
  };
  return client;
}

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);

describe("UEX answers that need normalising", () => {
  it("reads numbers from numbers and numeric strings only", () => {
    expect(toNumber("23")).toBe(23);
    expect(toNumber(" 4.5 ")).toBe(4.5);
    expect(toNumber(7)).toBe(7);
    for (const bad of ["", "abc", NaN, Infinity, null, undefined, {}, false]) {
      expect(toNumber(bad)).toBeUndefined();
    }
  });

  it("turns `data: false`, null, an empty list and an empty object into an explicit no_data", () => {
    for (const data of [false, null, [], {}]) {
      expect(unwrapData({ status: "ok", data }).kind).toBe("no_data");
    }
    expect(unwrapData({ status: "ok" }).kind).toBe("no_data");
    expect(unwrapData("<html>").kind).toBe("no_data");
    expect(unwrapData({ data: [{ a: 1 }, 3] })).toEqual({ kind: "rows", rows: [{ a: 1 }] });
    expect(unwrapData({ data: { a: 1 } })).toEqual({ kind: "object", row: { a: 1 } });
  });

  it("gives an explicit no_data for a terminal pair UEX does not know (HTTP 200, data:false), through the real client", async () => {
    const client = uexAnswering(200, { status: "ok", http_code: 200, data: false, message: "" });
    const r = await fetchTerminalDistance(client, 8, 12);
    expect(r.kind).toBe("no_data");
  });

  it("reads a terminal distance sent as a string, and refuses one that is not a number", async () => {
    const good = uexAnswering(200, {
      status: "ok",
      data: { distance: "23", terminal_name_origin: "A" },
    });
    expect(await fetchTerminalDistance(good, 18, 12)).toEqual({
      kind: "found",
      gm: 23,
      source: "terminals_distances",
    });
    const bad = uexAnswering(200, { status: "ok", data: { distance: "far" } });
    expect((await fetchTerminalDistance(bad, 18, 13)).kind).toBe("no_data");
  });

  it("builds the orbit matrix from string distances, both directions, and skips unusable rows", async () => {
    const client = uexAnswering(200, {
      status: "ok",
      data: [
        { id_orbit_origin: 59, id_orbit_destination: 4, distance: "42", date_modified: secs(DAY) },
        { id_orbit_origin: 4, id_orbit_destination: 116, distance: "23" },
        { id_orbit_origin: 4, id_orbit_destination: 9, distance: "x" },
      ],
    });
    const m = await fetchOrbitMatrix(client, 68, 68);
    expect(m.rows).toBe(2);
    expect(m.gm.get("4>59")).toBe(42);
    expect(m.gm.get("59>4")).toBe(42);
    expect(m.gm.has("4>9")).toBe(false);
    const matrices = new Map([[68, m]]);
    expect(orbitDistance({ system: 68, orbit: 59 }, { system: 68, orbit: 4 }, matrices)).toEqual({
      kind: "known",
      gm: 42,
      basis: "orbits_distances",
    });
    expect(orbitDistance({ system: 68, orbit: 4 }, { system: 68, orbit: 4 }, matrices)).toEqual({
      kind: "known",
      gm: 0,
      basis: "same_orbit",
    });
    expect(orbitDistance({ system: 68, orbit: 4 }, { system: 64, orbit: 5 }, matrices).kind).toBe(
      "unknown",
    );
    expect(orbitDistance({ system: 68, orbit: 0 }, { system: 68, orbit: 4 }, matrices).kind).toBe(
      "unknown",
    );
    expect(orbitDistance({ system: 68, orbit: 4 }, { system: 68, orbit: 77 }, matrices).kind).toBe(
      "unknown",
    );
  });
});

describe("travel time model", () => {
  const model: TravelModel = {
    quantumSpeedMs: 238_314_300,
    spoolSeconds: 6.9,
    stopSeconds: 480,
    localHopSeconds: 120,
  };

  it("agrees with the wiki's own calibration: Crusader to ArcCorp, 42 Gm, about 176 s", () => {
    const s = legSeconds(42, { ...model, spoolSeconds: 0 }) as number;
    expect(Math.round(s)).toBe(176);
  });

  it("uses a local hop for the same orbit and has no time for a flight without a speed", () => {
    expect(legSeconds(0, model)).toBe(120);
    expect(legSeconds(10, { ...model, quantumSpeedMs: null })).toBeNull();
    expect(cycleSeconds(2, [0, 0], { ...model, quantumSpeedMs: null })).toBe(2 * 480 + 240);
    expect(cycleSeconds(2, [10, 10], { ...model, quantumSpeedMs: null })).toBeNull();
  });

  it("refuses a speed that is not a quantum drive (SCM m/s, or faster than light)", () => {
    expect(validQuantumSpeed(217)).toBeNull();
    expect(validQuantumSpeed(4e9)).toBeNull();
    expect(validQuantumSpeed(238_314_300)).toBe(238_314_300);
    expect(formatDuration(3725)).toBe("1 h 02 min");
  });
});

describe("price history statistics", () => {
  const day = (n: number) => secs(n * DAY);
  const rows = (prices: number[]) =>
    prices.map((p, i) => ({ date_added: day(prices.length - i), price_sell: p, price_buy: 0 }));

  it("computes low, high, mean, volatility, position and a verdict on the number of points", () => {
    const s = summarizeSide(rows([5000, 5200, 4900, 5100, 5500]), "sell", NOW);
    expect(s?.points_used).toBe(5);
    expect(s?.low).toBe(4900);
    expect(s?.high).toBe(5500);
    expect(s?.mean).toBe(5140);
    expect(s?.current).toBe(5500);
    expect(s?.position_in_range).toBe(1);
    expect(s?.verdict).toBe("high");
    expect(s?.verdict_text).toContain("5 points");
    expect(s?.volatility).toBeGreaterThan(0.02);
  });

  it("says low when the latest price is at the bottom, normal in the middle, and nothing under 4 points", () => {
    expect(summarizeSide(rows([5000, 5200, 5400, 5600, 5000]), "sell", NOW)?.verdict).toBe("low");
    expect(summarizeSide(rows([5000, 5600, 5000, 5600, 5300]), "sell", NOW)?.verdict).toBe(
      "normal",
    );
    const few = summarizeSide(rows([5000, 5600, 5300]), "sell", NOW);
    expect(few?.verdict).toBe("not_enough_points");
    expect(few?.verdict_text).toContain("3 point");
  });

  it("does not call a price high when it is simply the usual top of the range (median)", () => {
    // The real Medical Supplies series at CBD Lorville: one dip, otherwise 5400 to 5500.
    const s = summarizeSide(
      rows([5500, 4900, 5500, 5500, 5400, 5500, 5500, 5400, 5400, 5500]),
      "sell",
      NOW,
    );
    expect(s?.position_in_range).toBe(1);
    expect(s?.median).toBe(5500);
    expect(s?.verdict).toBe("normal");
  });

  it("calls a price that barely moves normal, without a position-based high or low", () => {
    const s = summarizeSide(rows([1000, 1001, 1000, 1002, 1001]), "sell", NOW);
    expect(s?.verdict).toBe("normal");
    expect(s?.verdict_text).toContain("barely moves");
  });

  it("flags a latest point older than a week as stale, and ignores zero prices and the other side", () => {
    const old = [10, 9, 8, 7, 6].map((d, i) => ({
      date_added: day(d + 20),
      price_sell: 100 + i,
      price_buy: 0,
    }));
    const s = summarizeSide(old, "sell", NOW);
    expect(s?.stale).toBe(true);
    expect(summarizeSide(old, "buy", NOW)).toBeNull();
    const summary = summarizeHistory(old, NOW);
    expect(summary.sides.map((x) => x.side)).toEqual(["sell"]);
    expect(summary.short_history_notice).toContain("SHORT HISTORY");
  });

  it("reads a latest price by date, whatever the order UEX sent", () => {
    const shuffled = [
      { date_added: day(1), price_sell: 5500 },
      { date_added: day(5), price_sell: 4900 },
      { date_added: day(3), price_sell: 5200 },
      { date_added: day(4), price_sell: 5000 },
    ];
    expect(summarizeSide(shuffled, "sell", NOW)?.current).toBe(5500);
  });
});

describe("market status", () => {
  it("falls back to the built-in legend when UEX's is incomplete", () => {
    expect(parseLegend({ buy: [], sell: [] })).toBe(BUILT_IN_LEGEND);
    expect(parseLegend(null).source).toBe("built_in");
  });

  it("reads the legend the right way round: sell 7 is no demand, buy 7 is a full stock", () => {
    const sellNoDemand = assessRow(
      { price_sell: 100, status_sell: 7, scu_sell_stock: 900 },
      BUILT_IN_LEGEND,
    );
    expect(sellNoDemand.sell.level).toContain("No Demand");
    expect(sellNoDemand.warnings.map((w) => w.code)).toEqual(["sell_no_demand"]);
    const buyFull = assessRow({ price_buy: 100, status_buy: 7, scu_buy: 900 }, BUILT_IN_LEGEND);
    expect(buyFull.buy.level).toContain("Full");
    expect(buyFull.warnings).toEqual([]);
  });

  it("warns about shortage when buying, saturation when selling, and strong demand as information", () => {
    const empty = assessRow({ price_buy: 100, status_buy: 1, scu_buy: 0 }, BUILT_IN_LEGEND);
    expect(empty.warnings[0]).toMatchObject({
      side: "buy",
      severity: "critical",
      code: "buy_out_of_stock",
    });
    const low = assessRow({ price_buy: 100, status_buy: 2, scu_buy: 40 }, BUILT_IN_LEGEND);
    expect(low.warnings[0]?.code).toBe("buy_shortage");
    const sat = assessRow({ price_sell: 100, status_sell: 6 }, BUILT_IN_LEGEND);
    expect(sat.warnings[0]?.code).toBe("sell_saturating");
    const wants = assessRow({ price_sell: 100, status_sell: 1 }, BUILT_IN_LEGEND);
    expect(wants.warnings[0]).toMatchObject({ code: "sell_strong_demand", severity: "info" });
    // A side the terminal does not trade carries no warning, whatever its status code says.
    expect(assessRow({ price_sell: 0, status_sell: 7 }, BUILT_IN_LEGEND).warnings).toEqual([]);
  });
});

describe("planner", () => {
  const model: TravelModel = {
    quantumSpeedMs: 238_314_300,
    spoolSeconds: 6.9,
    stopSeconds: 480,
    localHopSeconds: 120,
  };
  const price = (o: Record<string, unknown>) => ({
    date_modified: secs(DAY),
    commodity_name: "X",
    terminal_name: "T",
    price_buy: 0,
    price_sell: 0,
    scu_buy: 0,
    status_buy: 0,
    status_sell: 0,
    ...o,
  });
  const base = { cargoScu: 46, now: NOW, maxAgeDays: 7, includeStale: false };

  it("keeps only buyable and sellable rows, drops stale and undated ones, and counts them", () => {
    const rows = parsePriceRows([
      price({ id_commodity: 1, id_terminal: 1, price_buy: 100, scu_buy: 500, status_buy: 4 }),
      price({ id_commodity: 1, id_terminal: 2, price_sell: 160, status_sell: 3 }),
      price({ id_commodity: 1, id_terminal: 3, price_sell: 400, status_sell: 7 }), // no demand
      price({
        id_commodity: 1,
        id_terminal: 4,
        price_sell: 300,
        status_sell: 3,
        date_modified: secs(100 * DAY),
      }),
      price({
        id_commodity: 1,
        id_terminal: 5,
        price_sell: 300,
        status_sell: 3,
        date_modified: undefined,
      }),
      price({ id_commodity: 1, id_terminal: 6, price_buy: 10, scu_buy: 100, status_buy: 1 }), // out of stock
    ]);
    const set = buildLegs(rows, base);
    expect([...set.best.keys()]).toEqual(["1>2"]);
    expect(set.excluded_stale_rows).toBe(1);
    expect(set.undated_rows).toBe(1);
    const leg = set.best.get("1>2");
    expect(leg).toMatchObject({ scu: 46, profit: 46 * 60, limitedBy: "cargo" });
    const kept = buildLegs(rows, { ...base, includeStale: true });
    expect(kept.best.get("1>4")?.profit).toBe(46 * 200);
  });

  it("limits the quantity by the budget and by the stock, and says which", () => {
    const rows = parsePriceRows([
      price({ id_commodity: 1, id_terminal: 1, price_buy: 100, scu_buy: 30, status_buy: 4 }),
      price({ id_commodity: 1, id_terminal: 2, price_sell: 160, status_sell: 3 }),
    ]);
    expect(buildLegs(rows, base).best.get("1>2")).toMatchObject({ scu: 30, limitedBy: "stock" });
    expect(buildLegs(rows, { ...base, budget: 1500 }).best.get("1>2")).toMatchObject({
      scu: 15,
      limitedBy: "budget",
    });
    expect(buildLegs(rows, { ...base, budget: 50 }).best.size).toBe(0);
  });

  it("ranks a round trip by profit per hour with the way back counted", () => {
    const rows = parsePriceRows([
      price({ id_commodity: 1, id_terminal: 1, price_buy: 100, scu_buy: 500, status_buy: 4 }),
      price({ id_commodity: 1, id_terminal: 2, price_sell: 160, status_sell: 3 }),
      price({ id_commodity: 2, id_terminal: 2, price_buy: 50, scu_buy: 200, status_buy: 5 }),
      price({ id_commodity: 2, id_terminal: 1, price_sell: 90, status_sell: 2 }),
    ]);
    const legs = buildLegs(rows, base);
    const far = () => ({ kind: "known", gm: 30, basis: "orbits_distances" }) as const;
    const { plans } = roundTrips(legs, far, model, 5);
    expect(plans).toHaveLength(1);
    const p = plans[0];
    expect(p.profit).toBe(46 * 60 + 46 * 40);
    expect(p.stops).toBe(2);
    expect(p.stopIds).toEqual([1, 2]);
    const cycle = 2 * 480 + 2 * (6.9 + 30e9 / 238_314_300);
    expect(p.cycleSeconds).toBeCloseTo(cycle, 1);
    expect(p.profitPerHour).toBeCloseTo((p.profit / cycle) * 3600, 0);
  });

  it("counts a pair without a known distance instead of guessing", () => {
    const rows = parsePriceRows([
      price({ id_commodity: 1, id_terminal: 1, price_buy: 100, scu_buy: 500, status_buy: 4 }),
      price({ id_commodity: 1, id_terminal: 2, price_sell: 160, status_sell: 3 }),
      price({ id_commodity: 2, id_terminal: 2, price_buy: 50, scu_buy: 200, status_buy: 5 }),
      price({ id_commodity: 2, id_terminal: 1, price_sell: 90, status_sell: 2 }),
    ]);
    const res = roundTrips(buildLegs(rows, base), () => ({ kind: "unknown", why: "x" }), model, 5);
    expect(res.plans).toEqual([]);
    expect(res.skipped.unknownDistance).toBe(1);
  });

  it("chains A>B>C without going back to A or repeating B", () => {
    const rows = parsePriceRows([
      price({ id_commodity: 1, id_terminal: 1, price_buy: 100, scu_buy: 500, status_buy: 4 }),
      price({ id_commodity: 1, id_terminal: 2, price_sell: 160, status_sell: 3 }),
      price({ id_commodity: 2, id_terminal: 2, price_buy: 50, scu_buy: 200, status_buy: 5 }),
      price({ id_commodity: 2, id_terminal: 3, price_sell: 90, status_sell: 2 }),
      price({ id_commodity: 2, id_terminal: 1, price_sell: 70, status_sell: 2 }),
    ]);
    const d = () => ({ kind: "known", gm: 10, basis: "orbits_distances" }) as const;
    const { plans } = twoLegChains(buildLegs(rows, base), d, model, 5);
    expect(plans).toHaveLength(1);
    expect(plans[0].stopIds).toEqual([1, 2, 3]);
    expect(plans[0].returnsToStart).toBe(false);
    expect(plans[0].stops).toBe(3);
  });

  it("sizes a UEX route for the cargo that fits and refuses one without a margin", () => {
    const row = {
      id_commodity: 47,
      id_terminal_origin: 8,
      id_terminal_destination: 12,
      price_origin: 7000,
      price_destination: 8500,
      scu_reachable: 153,
      commodity_name: "Laranite",
      origin_terminal_name: "A",
      destination_terminal_name: "B",
    };
    expect(routeLeg({ row, cargoScu: 100, budget: 350_000 })).toMatchObject({
      scu: 50,
      limitedBy: "budget",
    });
    expect(routeLeg({ row, cargoScu: 100 })).toMatchObject({ scu: 100, profit: 150_000 });
    expect(routeLeg({ row: { ...row, price_destination: 6000 }, cargoScu: 100 })).toBeNull();
  });
});

describe("safety heuristic", () => {
  const place = (o: Partial<TerminalPlace> & { terminalId: number }): TerminalPlace => ({
    planetId: 1,
    system: 68,
    orbit: o.terminalId,
    systemName: "Stanton",
    planetName: "ArcCorp",
    kind: "station",
    armistice: true,
    jurisdiction: null,
    ...o,
  });

  it("is lower exposure when every stop is an armistice zone, and says it is a heuristic", () => {
    const s = safetyOf([place({ terminalId: 1 }), place({ terminalId: 2, kind: "city" })], 2);
    expect(s).toMatchObject({ heuristic: true, exposure: "lower", points: 0 });
    expect(s.caveat).toContain("no route is safe");
  });

  it("adds points for no armistice zone, an outpost, Pyro, unknown places and many flights", () => {
    const outpost = safetyOf(
      [place({ terminalId: 1 }), place({ terminalId: 2, kind: "outpost", armistice: false })],
      2,
    );
    expect(outpost.points).toBe(2);
    expect(outpost.exposure).toBe("medium");
    const pyro = safetyOf(
      [
        place({ terminalId: 1, systemName: "Pyro", armistice: false }),
        place({ terminalId: 2, systemName: "Pyro", armistice: false }),
      ],
      2,
    );
    expect(pyro.exposure).toBe("higher");
    expect(safetyOf([undefined, place({ terminalId: 2, armistice: null })], 2).points).toBe(2);
    expect(safetyOf([place({ terminalId: 1 })], 5).points).toBe(3);
  });
});

describe("dates", () => {
  it("measures age in days from a UEX timestamp", () => {
    expect(ageDays(NOW - 2.5 * DAY, NOW)).toBe(2.5);
    expect(ageDays(null, NOW)).toBeNull();
  });
});
