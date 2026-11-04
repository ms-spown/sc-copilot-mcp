import { describe, expect, it } from "vitest";
import {
  aggregate,
  aggregateWithoutMoney,
  MIN_RATE_ACTIVE_MS,
  summarizeSession,
  withoutMoney,
} from "./stats.js";
import { session, stamp } from "./fixtures.testing.js";
import type { Session, Trip } from "./types.js";

/** Feature: figures per session and across sessions; unknown stays unknown, rates need enough time. */

const HOUR = 3_600_000;
let k = 0;
const trip = (over: Partial<Trip> = {}): Trip => ({
  key: `t${(++k).toString(16).padStart(8, "0")}`,
  kind: "hauling",
  source: "contract_ledger",
  started_at: null,
  ended_at: stamp(5),
  label: "Run",
  commodity: "Gold",
  buy_terminal: "A",
  sell_terminal: "B",
  scu: null,
  cost_auec: null,
  revenue_auec: null,
  fees_auec: null,
  gross_margin_auec: null,
  net_auec: 1000,
  net_kind: "balance_delta",
  planned_profit_auec: null,
  planned_scu: null,
  plan_buy_terminal: null,
  plan_sell_terminal: null,
  fees_method: null,
  plan_link: null,
  unexplained_auec: null,
  net_doubtful: null,
  ...over,
});

const played = (n: number, over: Partial<Session> = {}): Session =>
  session(n, { active_ms: HOUR, start_balance: 1000, last_balance: 5000, ...over });

describe("Feature: one session", () => {
  it("Given trips with results, Then the net is their sum, the rate uses active time and the best trip is named", () => {
    const s = summarizeSession(
      played(1, {
        trips: [
          trip({ net_auec: 3000, label: "Big" }),
          trip({ net_auec: 1000 }),
          trip({ net_auec: null }),
        ],
        active_ms: 2 * HOUR,
      }),
    );
    expect(s.trips).toBe(3);
    expect(s.trips_with_net).toBe(2);
    expect(s.money.net_auec).toBe(4000);
    expect(s.money.net_source).toBe("trips");
    expect(s.money.net_complete).toBe(false);
    expect(s.money.net_per_hour_auec).toBe(2000);
    expect(s.money.avg_trip_net_auec).toBe(2000);
    expect(s.money.best_trip).toMatchObject({ label: "Big", net_auec: 3000 });
    expect(s.trips_per_hour).toBe(1.5);
    expect(s.minutes_per_trip).toBe(40);
  });

  it("Given no trip result but two balances, Then the net is the balance change and says so", () => {
    const s = summarizeSession(played(1));
    expect(s.money.net_auec).toBe(4000);
    expect(s.money.net_source).toBe("balance");
    expect(s.money.balance_change_auec).toBe(4000);
  });

  it("Given nothing known, Then every figure is null and no rate is invented", () => {
    const s = summarizeSession(
      session(1, { start_balance: null, last_balance: null, active_ms: 0 }),
    );
    expect(s.money.net_auec).toBeNull();
    expect(s.money.net_per_hour_auec).toBeNull();
    expect(s.trips_per_hour).toBeNull();
    expect(s.money.best_trip).toBeNull();
    expect(s.money.plan).toBeNull();
  });

  it("Given less active time than the minimum, Then there is no hourly rate", () => {
    const s = summarizeSession(played(1, { active_ms: MIN_RATE_ACTIVE_MS - 1 }));
    expect(s.money.net_per_hour_auec).toBeNull();
  });

  it("Given a plan on two trips, Then the efficiency is measured over planned", () => {
    const s = summarizeSession(
      played(1, {
        trips: [
          trip({ net_auec: 9000, planned_profit_auec: 10_000 }),
          trip({ net_auec: 5000, planned_profit_auec: 10_000 }),
          trip({ net_auec: 5000 }),
        ],
      }),
    );
    expect(s.money.plan).toEqual({
      planned_auec: 20_000,
      measured_auec: 14_000,
      efficiency: 0.7,
      trips: 2,
      price_linked_trips: 0,
    });
  });

  it("Given other contracts, Then they are not counted as trips but their result counts in the net", () => {
    const s = summarizeSession(
      played(1, { trips: [trip({ kind: "contract", net_auec: 700 }), trip({ net_auec: 300 })] }),
    );
    expect(s.trips).toBe(1);
    expect(s.contracts).toBe(1);
    expect(s.money.net_auec).toBe(1000);
  });

  it("Given an ended session, Then its duration runs to the end; an open one to its last sighting (not to now)", () => {
    const open = summarizeSession(session(1, { last_activity_at: stamp(3600) }));
    expect(open.duration_ms).toBe((3600 - 1) * 1000);
    const ended = summarizeSession(
      session(1, { ended_at: stamp(7200), end_reason: "manual", last_activity_at: stamp(3600) }),
    );
    expect(ended.duration_ms).toBe((7200 - 1) * 1000);
    expect(ended.status).toBe("ended");
  });

  it("Given the money is removed, Then no aUEC figure is left", () => {
    const text = JSON.stringify(
      withoutMoney(summarizeSession(played(1, { trips: [trip({ net_auec: 123456 })] }))),
    );
    expect(text).not.toContain("123456");
    expect(text).not.toContain("auec");
  });
});

describe("Feature: across sessions", () => {
  const history = [
    played(1, { start_balance: 0, last_balance: 10_000 }),
    played(2, { start_balance: 0, last_balance: 20_000 }),
    played(3, { start_balance: 0, last_balance: 30_000 }),
    played(4, { start_balance: 0, last_balance: 40_000 }),
    played(5, { start_balance: 0, last_balance: 5000 }),
    played(6, { start_balance: 0, last_balance: 6000 }),
    session(7, { start_balance: null, last_balance: null, active_ms: 0 }), // empty
  ];

  it("Given several sessions, Then totals, average per hour, best and worst are worked out and empty sessions are ignored", () => {
    const a = aggregate(history);
    expect(a.sessions).toBe(6);
    expect(a.empty_sessions_ignored).toBe(1);
    expect(a.money.net_auec).toBe(10_000 + 20_000 + 30_000 + 40_000 + 5000 + 6000);
    expect(a.money.avg_net_per_hour_auec).toBe(Math.round(111_000 / 6));
    expect(a.money.best_session).toMatchObject({ number: 4, net_per_hour_auec: 40_000 });
    expect(a.money.worst_session).toMatchObject({ number: 5, net_per_hour_auec: 5000 });
  });

  it("Given enough sessions, Then the trend compares the latest ones with the ones before", () => {
    const a = aggregate(history);
    expect(a.money.trend).toMatchObject({ direction: "down", sessions_each: 3 });
    expect(aggregate(history.slice(0, 3)).money.trend).toBeNull(); // not enough to say
  });

  it("Given trips with goods and places, Then the best routes and goods are listed with how many trips back them", () => {
    const s = played(8, {
      trips: [
        trip({ commodity: "Gold", buy_terminal: "A", sell_terminal: "B", net_auec: 9000 }),
        trip({ commodity: "Gold", buy_terminal: "A", sell_terminal: "B", net_auec: 7000 }),
        trip({ commodity: "Iron", buy_terminal: "C", sell_terminal: "D", net_auec: 2000 }),
        trip({ commodity: "Iron", buy_terminal: "C", sell_terminal: "D", net_auec: null }),
      ],
    });
    const a = aggregate([s]);
    expect(a.money.best_routes[0]).toMatchObject({
      commodity: "Gold",
      trips: 2,
      avg_net_auec: 8000,
      total_net_auec: 16_000,
    });
    expect(a.money.best_routes[1]).toMatchObject({ commodity: "Iron", trips: 1 }); // no result: not counted
    expect(a.money.best_commodities.map((c) => c.commodity)).toEqual(["Gold", "Iron"]);
  });

  it("Given 'last' sessions, Then only those are used", () => {
    expect(aggregate(history, { last: 2 }).sessions).toBe(2);
  });

  it("Given no session at all, Then nothing is invented", () => {
    const a = aggregate([]);
    expect(a.sessions).toBe(0);
    expect(a.money.net_auec).toBeNull();
    expect(a.money.best_session).toBeNull();
    expect(a.trips_per_hour).toBeNull();
  });

  it("Given the money removed, Then the counts stay", () => {
    const a = aggregateWithoutMoney(aggregate(history));
    expect(a.money).toBe("withheld");
    expect(a.sessions).toBe(6);
  });
});

describe("Feature: one basis for the result, and nothing counted twice", () => {
  const at = (min: number) => stamp(min * 60);
  const contract = (net: number | null, from: number, to: number) =>
    trip({ kind: "hauling", net_auec: net, started_at: at(from), ended_at: at(to) });
  const run = (gross: number, net: number | null, from: number, to: number) =>
    trip({
      kind: "trade",
      source: "trade_journal",
      net_auec: net,
      gross_margin_auec: gross,
      started_at: at(from),
      ended_at: at(to),
    });

  it("Given a 20 000 contract and a +500 000 cargo run apart in time, Then the result is their sum on one basis, the rate follows it, and the parts are given apart", () => {
    const s = summarizeSession(
      played(1, {
        trips: [contract(20_000, 0, 10), run(500_000, null, 30, 50)],
        start_balance: 0,
        last_balance: 520_000,
        active_ms: 2 * HOUR,
      }),
    );
    expect(s.money.net_auec).toBe(520_000);
    expect(s.money.net_per_hour_auec).toBe(260_000);
    expect(s.money.measured_net_auec).toBe(20_000);
    expect(s.money.gross_margin_auec).toBe(500_000);
    expect(s.money.gross_only_trips).toBe(1);
    expect(s.money.best_trip).toMatchObject({ net_auec: 500_000, gross: true });
  });

  it("Given a contract that overlapped a cargo run, Then its balance change (which holds the run's sales) is left out, once", () => {
    const s = summarizeSession(
      played(1, {
        trips: [contract(520_000, 0, 60), run(500_000, 500_000, 20, 40)],
        active_ms: HOUR,
      }),
    );
    expect(s.money.net_auec).toBe(500_000);
    expect(s.money.overlap_excluded).toBe(1);
    expect(s.money.measured_net_auec).toBe(500_000);
    expect(s.money.net_complete).toBe(false);
  });

  it("Given the cargo run is stored AFTER the contract, Then the contract is still excluded when read", () => {
    const trips = [contract(520_000, 0, 60)];
    expect(summarizeSession(played(1, { trips })).money.net_auec).toBe(520_000);
    trips.push(run(500_000, null, 20, 40));
    expect(summarizeSession(played(1, { trips })).money.net_auec).toBe(500_000);
  });

  it("Given trips that do not overlap in time, Then nothing is excluded; across sessions the same basis is used", () => {
    const a = aggregate([
      played(1, { trips: [contract(1000, 0, 10), run(9000, null, 20, 30)] }),
      played(2, { trips: [contract(500, 0, 60), run(700, 700, 10, 20)] }),
    ]);
    // Session 1: 1000 + 9000; session 2: the contract overlaps the run, so only the run: 700.
    expect(a.money.net_auec).toBe(10_000 + 700);
  });
});

describe("Feature: a run stored twice by an older build counts once in every sum", () => {
  const run = (key: string, endSec: number) =>
    trip({
      key,
      kind: "trade",
      source: "trade_journal",
      started_at: stamp(1),
      ended_at: stamp(endSec),
      commodity: "Waste",
      cost_auec: 40_000,
      revenue_auec: 90_000,
      fees_auec: 500,
      gross_margin_auec: 50_000,
      net_auec: null,
    });

  it("Given two trade trips with the same start and goods, Then turnover, cost, fees and gross margin count the later one only", () => {
    const m = summarizeSession(
      played(1, { trips: [run("aaaaaa000001", 60), run("aaaaaa000002", 1300)] }),
    ).money;
    expect(m.turnover_auec).toBe(90_000);
    expect(m.cost_auec).toBe(40_000);
    expect(m.fees_auec).toBe(500);
    expect(m.gross_margin_auec).toBe(50_000);
    expect(m.net_auec).toBe(50_000);
  });

  it("Given a run stored twice and nothing else, Then the copy is neither a left-out contract nor a partial total", () => {
    const m = summarizeSession(
      played(1, { trips: [run("aaaaaa000001", 60), run("aaaaaa000002", 1300)] }),
    ).money;
    expect(m.overlap_excluded).toBe(0);
    expect(m.net_complete).toBe(true);
  });

  it("Given the same file across sessions, Then the aggregate turnover counts it once", () => {
    const a = aggregate([
      played(1, { trips: [run("aaaaaa000001", 60), run("aaaaaa000002", 1300)] }),
    ]);
    expect(a.money.turnover_auec).toBe(90_000);
  });
});
