import { describe, expect, it } from "vitest";
import type { Distance } from "./distances.js";
import { openingPlans } from "./opening.js";
import {
  buildLegs,
  byValue,
  oneWayPlan,
  parsePriceRows,
  roundTrips,
  twoLegChains,
  type Plan,
} from "./planner.js";
import type { TravelModel } from "./travel.js";

/**
 * "Partir de ma position": the opening trade from where the player is to where a route starts. Invented terminals, goods and
 * prices (no UEX data, no network); amounts are whole figures.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MODEL: TravelModel = {
  quantumSpeedMs: 100_000_000, // 100 Gm per 1000 s
  spoolSeconds: 10,
  stopSeconds: 60,
  localHopSeconds: 120,
};

/** A price row as UEX gives it (see planner.parsePriceRows). */
const row = (
  commodity: number,
  terminal: number,
  p: { buy?: number; sell?: number; stock?: number; demand?: number },
) => ({
  id_commodity: commodity,
  id_terminal: terminal,
  commodity_name: `Goods ${commodity}`,
  terminal_name: `Terminal ${terminal}`,
  price_buy: p.buy ?? 0,
  price_sell: p.sell ?? 0,
  scu_buy: p.stock ?? 0,
  scu_sell: p.demand ?? 0,
  status_buy: 5,
  status_sell: 4,
  date_modified: Math.floor((NOW - 3_600_000) / 1000),
});

const legsOf = (rows: ReturnType<typeof row>[], cargo = 100, budget?: number) =>
  buildLegs(parsePriceRows(rows), {
    cargoScu: cargo,
    ...(budget !== undefined ? { budget } : {}),
    now: NOW,
    maxAgeDays: 7,
    includeStale: false,
  });

/** Gm between terminals: T1 (the player) is 10 from T2, 30 from T4; T2 is 20 from T3; T4 is 5 from T3. */
const GM: Record<string, number> = {
  "1|2": 10,
  "1|3": 25,
  "1|4": 30,
  "2|3": 20,
  "3|4": 5,
  "2|4": 28,
};
const distance = (a: number, b: number): Distance => {
  if (a === b) return { kind: "known", gm: 0, basis: "same_orbit" };
  const gm = GM[`${Math.min(a, b)}|${Math.max(a, b)}`];
  return gm === undefined
    ? { kind: "unknown", why: "no distance" }
    : { kind: "known", gm, basis: "orbits_distances" };
};
const known = (gm: number): Extract<Distance, { kind: "known" }> => ({
  kind: "known",
  gm,
  basis: "orbits_distances",
});

// Goods 1: bought at T1 (100), sold at T2 (150): the opening trade, 50 per SCU.
// Goods 2: bought at T2 (200), sold at T3 (500): the route, 300 per SCU, one way (the return is empty).
const ROWS = [
  row(1, 1, { buy: 100, stock: 1000 }),
  row(1, 2, { sell: 150, demand: 1000 }),
  row(2, 2, { buy: 200, stock: 1000 }),
  row(2, 3, { sell: 500, demand: 1000 }),
];

const player = (...ids: number[]) => ({ terminalIds: new Set(ids), label: "Here" });
const oneWays = (legs: ReturnType<typeof legsOf>): Plan[] =>
  [...legs.best.values()].map((l) =>
    oneWayPlan(
      l,
      known(
        distance(l.fromId, l.toId).kind === "known"
          ? (distance(l.fromId, l.toId) as { gm: number }).gm
          : 0,
      ),
      MODEL,
    ),
  );

describe("Feature: an opening trade pays on the flight to the start of the route", () => {
  it("Given a route that loads at T2 and a trade T1 to T2, Then the plan has a step 1 and the first cycle is the route plus its profit", () => {
    const legs = legsOf(ROWS);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    });
    expect(out.plans).toHaveLength(1);
    const p = out.plans[0]!;
    expect(p.atPosition).toBe(false);
    expect(p.startId).toBe(2);
    expect(p.step1).toMatchObject({
      fromId: 1,
      toId: 2,
      commodity: "Goods 1",
      scu: 100,
      profit: 5000,
    });
    expect(route.profit).toBe(30000);
    expect(p.firstCycle.profit).toBe(35000);
    expect(p.withoutStep1.profit).toBe(30000);
    // Same time with and without step 1 (one stop where the flight leaves, loading time not modelled).
    expect(p.firstCycle.seconds).toBe(p.withoutStep1.seconds);
    expect(p.firstCycle.profitPerHour!).toBeGreaterThan(p.withoutStep1.profitPerHour!);
    // 1 stop + the route's 2 stops = 3 stops; flights 10 Gm + 2 x 20 Gm = 50 Gm at 100 Gm per 1000 s, +10 s spool each.
    expect(p.asPlan.stops).toBe(3);
    expect(p.repositionGm).toBe(10);
    expect(p.firstCycle.seconds).toBe(3 * 60 + (10 + 100) + 2 * (10 + 200));
  });

  it("Given a route that loads at the player's own place, Then there is no flight and no step 1", () => {
    const legs = legsOf(ROWS);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1, 2),
      mains: [route],
      rank: byValue,
      pool: 5,
    });
    const p = out.plans[0]!;
    expect(p.atPosition).toBe(true);
    expect(p.step1).toBeNull();
    expect(p.repositionGm).toBeNull();
    expect(p.asPlan.stops).toBe(route.stops);
    expect(p.firstCycle.profit).toBe(route.profit);
  });

  it("Given nothing pays from the player's place to the start, Then the flight is empty and the plain figures stand", () => {
    const legs = legsOf([ROWS[2]!, ROWS[3]!]);
    const route = oneWays(legs)[0]!;
    const p = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    }).plans[0]!;
    expect(p.step1).toBeNull();
    expect(p.firstCycle).toEqual(p.withoutStep1);
    expect(p.repositionGm).toBe(10);
  });
});

describe("Feature: a round trip can be started from either end", () => {
  // Goods 3 goes T2 to T3 and goods 4 goes back T3 to T2: a round trip. The opening trade reaches T3 only.
  const rows = [
    row(3, 2, { buy: 100, stock: 1000 }),
    row(3, 3, { sell: 300, demand: 1000 }),
    row(4, 3, { buy: 120, stock: 1000 }),
    row(4, 2, { sell: 200, demand: 1000 }),
    row(5, 1, { buy: 50, stock: 1000 }),
    row(5, 3, { sell: 90, demand: 1000 }),
  ];

  it("Given both ends are valid starts, Then each is scored, and only the end the opening trade reaches gets a step 1", () => {
    const legs = legsOf(rows);
    const rt = roundTrips(legs, distance, MODEL, 5).plans;
    expect(rt).toHaveLength(1);
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: rt,
      keepAllStarts: true,
      rank: byValue,
      pool: 5,
    });
    const at2 = out.plans.find((p) => p.startId === 2)!;
    const at3 = out.plans.find((p) => p.startId === 3)!;
    expect(at2.step1).toBeNull();
    expect(at3.step1).toMatchObject({ toId: 3, commodity: "Goods 5", profit: 4000 });
    // The rotated route is the same two legs, driven from the other end.
    expect(at3.legs[0]!.fromId).toBe(3);
    expect(at3.legs[1]!.fromId).toBe(2);
    expect(at3.main.profit).toBe(at2.main.profit);
  });

  it("Given the same round trip reachable from both ends, Then by default only the better start is listed (it is one route, not two)", () => {
    const legs = legsOf(rows);
    const rt = roundTrips(legs, distance, MODEL, 5).plans;
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: rt,
      rank: byValue,
      pool: 5,
    });
    expect(out.considered).toBe(2);
    expect(out.plans).toHaveLength(1);
    // A one-way trade over the same pair is another route and stays.
    const oneWay = oneWayPlan(rt[0]!.legs[0]!, known(10), MODEL);
    const both = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [...rt, oneWay],
      rank: byValue,
      pool: 5,
    });
    expect(both.plans.length).toBe(2);
  });

  it("Given the ranking sees the FIRST cycle, Then a rich opening trade can put the farther start first, and the plain figures say it is the step that did it", () => {
    // The same round trip, but the opening trade to T3 is worth 100 000: far more than the extra flight costs.
    const rich = [
      ...rows.slice(0, 4),
      row(5, 1, { buy: 50, stock: 1000 }),
      row(5, 3, { sell: 1050, demand: 1000 }),
    ];
    const legs = legsOf(rich);
    const rt = roundTrips(legs, distance, MODEL, 5).plans;
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: rt,
      keepAllStarts: true,
      rank: byValue,
      pool: 5,
    });
    const at2 = out.plans.find((p) => p.startId === 2)!;
    const at3 = out.plans.find((p) => p.startId === 3)!;
    expect(out.plans[0]!.startId).toBe(3);
    // Without step 1 the nearer start would have been first: the opening trade is what changed the order.
    expect(at3.withoutStep1.profitPerHour!).toBeLessThan(at2.withoutStep1.profitPerHour!);
    expect(at3.firstCycle.profitPerHour!).toBeGreaterThan(at2.firstCycle.profitPerHour!);
    expect(at3.step1!.profit).toBe(100000);
  });
});

describe("Feature: what is left out, and what is said", () => {
  it("Given an open chain A to B to C, Then it is not a candidate (no return is priced)", () => {
    const rows = [
      row(1, 2, { buy: 100, stock: 1000 }),
      row(1, 3, { sell: 200, demand: 1000 }),
      row(2, 3, { buy: 100, stock: 1000 }),
      row(2, 4, { sell: 250, demand: 1000 }),
    ];
    const legs = legsOf(rows);
    const chains = twoLegChains(legs, distance, MODEL, 5).plans;
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => !c.returnsToStart)).toBe(true);
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: chains,
      rank: byValue,
      pool: 5,
    });
    expect(out.plans).toEqual([]);
  });

  it("Given no distance from the player's place to a start, Then that start is skipped and counted", () => {
    const rows = [row(7, 9, { buy: 10, stock: 1000 }), row(7, 3, { sell: 90, demand: 1000 })];
    const legs = legsOf(rows);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 9)!;
    const out = openingPlans({
      legs,
      distance: (a, b) => (a === 9 || b === 9 ? { kind: "unknown", why: "none" } : distance(a, b)),
      model: MODEL,
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    });
    expect(out.plans).toEqual([]);
    expect(out.skippedUnknownDistance).toBe(1);
  });

  it("Given the same route offered twice, Then it is scored once", () => {
    const legs = legsOf(ROWS);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const out = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [route, route],
      rank: byValue,
      pool: 5,
    });
    expect(out.plans).toHaveLength(1);
  });

  it("Given no terminal around the player, Then nothing is planned", () => {
    const legs = legsOf(ROWS);
    expect(
      openingPlans({
        legs,
        distance,
        model: MODEL,
        position: { terminalIds: new Set(), label: "Nowhere" },
        mains: oneWays(legs),
        rank: byValue,
        pool: 5,
      }).plans,
    ).toEqual([]);
  });

  it("Given the speed of the ship is unknown, Then no time and no hourly figure, and the order falls back to the profit", () => {
    const legs = legsOf(ROWS);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const p = openingPlans({
      legs,
      distance,
      model: { ...MODEL, quantumSpeedMs: null },
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    }).plans[0]!;
    expect(p.firstCycle.seconds).toBeNull();
    expect(p.firstCycle.profitPerHour).toBeNull();
    expect(p.firstCycle.profit).toBe(35000);
  });
});

describe("Feature: the hold and the budget are respected on the opening leg", () => {
  it("Given a budget that buys 20 SCU of the opening goods, Then step 1 is 20 SCU limited by the budget", () => {
    // 2 000 aUEC buys 20 SCU at 100.
    const legs = legsOf(ROWS, 100, 2000);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const p = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    }).plans[0]!;
    expect(p.step1).toMatchObject({ scu: 20, limitedBy: "budget" });
    expect(p.step1!.cost).toBeLessThanOrEqual(2000);
  });

  it("Given a small hold, Then step 1 never carries more than the hold", () => {
    const legs = legsOf(ROWS, 12);
    const route = oneWays(legs).find((p) => p.legs[0]!.fromId === 2)!;
    const p = openingPlans({
      legs,
      distance,
      model: MODEL,
      position: player(1),
      mains: [route],
      rank: byValue,
      pool: 5,
    }).plans[0]!;
    expect(p.step1).toMatchObject({ scu: 12, limitedBy: "cargo", profit: 600 });
  });
});
