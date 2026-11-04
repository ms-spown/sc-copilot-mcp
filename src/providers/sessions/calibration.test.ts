import { describe, expect, it } from "vitest";
import {
  CALIBRATION_LAST_RUNS,
  CALIBRATION_MAX_AGE_DAYS,
  buildCalibration,
  calibrationForPoll,
  confidenceOf,
  expectedNet,
  patchLine,
  pickGroup,
  usedSessions,
} from "./calibration.js";
import { NOW, session } from "./fixtures.testing.js";
import type { Session, Trip } from "./types.js";

/**
 * Feature: how the player's own saved trade runs compare with the plan that was applied before them. Invented figures.
 */

const DAY = 86_400_000;
let k = 0;
/** A completed trade run `ageDays` old with a planned profit, a realised gross margin and (optionally) a net and fees. */
const run = (
  over: Partial<Trip> & { ageDays?: number } = {},
  planned = 100_000,
  gross: number | null = 80_000,
): Trip => {
  const { ageDays = 1, ...rest } = over;
  // Two runs never start at the same instant (the sessions' own duplicate rule would merge them).
  const jitter = ++k * 1000;
  return {
    key: `ab${k.toString(16).padStart(8, "0")}`,
    kind: "trade",
    source: "trade_journal",
    started_at: new Date(NOW - ageDays * DAY - 600_000 - jitter).toISOString(),
    ended_at: new Date(NOW - ageDays * DAY - jitter).toISOString(),
    label: null,
    commodity: "Laranite",
    buy_terminal: null,
    sell_terminal: null,
    scu: 100,
    cost_auec: 200_000,
    revenue_auec: 200_000 + (gross ?? 0),
    fees_auec: 4_000,
    gross_margin_auec: gross,
    net_auec: gross === null ? null : gross - 4_000,
    net_kind: "balance_delta",
    planned_profit_auec: planned,
    planned_scu: 100,
    plan_buy_terminal: "Port Tressler",
    plan_sell_terminal: "Area18 TDD",
    fees_method: "mesure",
    plan_link: "name",
    unexplained_auec: null,
    net_doubtful: null,
    ...rest,
  };
};

const sessionWith = (n: number, trips: Trip[], over: Partial<Session> = {}): Session =>
  session(n, { trips, game_version: "4.10.197.2878 (build 12881860)", ...over });

const calibrate = (sessions: Session[], gameVersion: string | null = "4.10.197.2878") =>
  buildCalibration(sessions, { nowMs: NOW, gameVersion });
const commodity = (r: ReturnType<typeof calibrate>, name = "Laranite") =>
  r.groups.find((g) => g.kind === "commodity" && g.commodity === name);
const route = (r: ReturnType<typeof calibrate>) => r.groups.find((g) => g.kind === "route");

describe("Feature: fees deduced from the balance are not a fee rate (found by the end-to-end replay)", () => {
  it("Given runs whose fees were deduced (the stream was cut around the sales), Then they give no fee rate, measured ones do", () => {
    const deduced = { fees_method: "estime" as const, fees_auec: 30_000 };
    const r = calibrate([sessionWith(1, [run(deduced), run(deduced)])]);
    const g = commodity(r)!;
    expect(g.n).toBe(2);
    expect(g.fee_n).toBe(0);
    expect(g.fee_rate).toBeNull();
    // the gross ratio, which needs no fee, is unaffected
    expect(g.gross_ratio).toBe(0.8);
    // one measured run among deduced ones: only the measured one counts, and a single one gives no rate
    const mixed = calibrate([sessionWith(1, [run(deduced), run()])]);
    expect(commodity(mixed)!.fee_n).toBe(1);
    expect(commodity(mixed)!.fee_rate).toBeNull();
    const two = calibrate([sessionWith(1, [run(deduced), run(), run()])]);
    expect(commodity(two)!.fee_n).toBe(2);
    expect(commodity(two)!.fee_rate).toBe(0.014);
  });

  it("Given a run whose fees were measured before a restart and that grew since, Then its fees are not in the fee rate", () => {
    // fees of the first part divided by the revenue of the grown run would understate the rate
    const grown = { figures_from_before: true, revenue_auec: 900_000 };
    const r = calibrate([sessionWith(1, [run(grown), run(), run()])]);
    expect(commodity(r)!.fee_n).toBe(2);
    expect(commodity(r)!.fee_rate).toBe(0.014);
  });
});

describe("Feature: honest small samples", () => {
  it("Given a single run, Then the group exists with n = 1 but no figure at all", () => {
    const r = calibrate([sessionWith(1, [run()])]);
    const g = commodity(r)!;
    expect(g.n).toBe(1);
    expect(g.confidence).toBe("none");
    expect(g.gross_ratio).toBeNull();
    expect(g.net_ratio).toBeNull();
    expect(g.fee_rate).toBeNull();
    expect(g.gross_min).toBeNull();
    expect(calibrationForPoll(r).groups).toEqual([]);
  });

  it("Given two runs, Then the figures exist, the confidence is low and says why", () => {
    const r = calibrate([sessionWith(1, [run({}, 100_000, 80_000), run({}, 100_000, 60_000)])]);
    const g = commodity(r)!;
    expect(g.n).toBe(2);
    expect(g.gross_ratio).toBe(0.7);
    expect(g.confidence).toBe("low");
    expect(g.reasons).toContain("few_runs");
  });

  it("Given runs of one commodity only, Then another commodity has no figure borrowed from it", () => {
    const r = calibrate([sessionWith(1, [run(), run(), run({ commodity: "Agricium" })])]);
    expect(commodity(r, "Laranite")!.n).toBe(2);
    expect(commodity(r, "Agricium")!.n).toBe(1);
    expect(commodity(r, "Agricium")!.gross_ratio).toBeNull();
    expect(pickGroup(r.groups, "Agricium")).toBeNull();
    expect(pickGroup(r.groups, "Gold")).toBeNull();
    // a prefix of a name is not the name
    expect(pickGroup(r.groups, "Lara")).toBeNull();
    expect(pickGroup(r.groups, "Laranite")!.scope).toBe("commodity");
  });

  it("Given a trip with no planned profit, no gross margin, a duplicate or another kind, Then it is not a sample", () => {
    const dup = run();
    const r = calibrate([
      sessionWith(1, [
        run({ planned_profit_auec: null }),
        run({}, 0),
        run({}, 100_000, null),
        run({ kind: "hauling", source: "contract_ledger" }),
        run({ commodity: null }),
        dup,
        { ...dup, key: "cd00000000000001", ended_at: new Date(NOW - 1000).toISOString() },
      ]),
    ]);
    // the two copies of one run (same start, same goods) count as one
    expect(commodity(r)!.n).toBe(1);
    expect(r.runs_with_plan).toBe(1);
  });
});

describe("Feature: the typical ratio, its spread and its confidence", () => {
  it("Given runs of different sizes, Then the typical ratio is pooled like the efficiency figure, with median, min and max", () => {
    const r = calibrate([
      sessionWith(1, [
        run({ scu: 10, planned_scu: 10 }, 10_000, 9_000),
        run({ scu: 100, planned_scu: 100 }, 100_000, 50_000),
      ]),
    ]);
    const g = commodity(r)!;
    // (9 000 + 50 000) / (10 000 + 100 000)
    expect(g.gross_ratio).toBe(0.536);
    expect(g.gross_median).toBe(0.7);
    expect(g.gross_min).toBe(0.5);
    expect(g.gross_max).toBe(0.9);
  });

  it("Given confidence rules, Then they are the documented ones", () => {
    expect(confidenceOf(1, null, 1).confidence).toBe("none");
    expect(confidenceOf(2, 0.1, 1).confidence).toBe("low");
    expect(confidenceOf(3, 0.1, 1).confidence).toBe("low");
    expect(confidenceOf(4, 0.1, 1).confidence).toBe("medium");
    expect(confidenceOf(7, 0.6, 1).confidence).toBe("medium");
    expect(confidenceOf(7, 0.61, 1)).toEqual({ confidence: "low", reasons: ["high_variance"] });
    expect(confidenceOf(8, 0.3, 1).confidence).toBe("high");
    expect(confidenceOf(8, 0.31, 1).confidence).toBe("medium");
    expect(confidenceOf(8, 0.1, 22)).toEqual({ confidence: "low", reasons: ["not_recent"] });
    expect(confidenceOf(8, 0.1, 21).confidence).toBe("high");
    // a plan tied to its runs by prices, not by the goods' name, is never the top label
    expect(confidenceOf(8, 0.1, 1, true)).toEqual({
      confidence: "medium",
      reasons: ["goods_unverified"],
    });
    expect(confidenceOf(5, 0.1, 1, true).confidence).toBe("medium");
  });

  it("Given eight steady runs tied to their plan by prices, Then the group is medium and says how many were linked that way", () => {
    const runs = Array.from({ length: 8 }, (_, i) =>
      run({ ageDays: 1 + i, plan_link: "prices" }, 100_000, 80_000),
    );
    const g = commodity(calibrate([sessionWith(1, runs)]))!;
    expect(g.n).toBe(8);
    expect(g.linked_by_prices).toBe(8);
    expect(g.confidence).toBe("medium");
    expect(g.reasons).toEqual(["goods_unverified"]);
  });

  it("Given a wild spread, Then the group is flagged high variance and low", () => {
    const r = calibrate([
      sessionWith(1, [
        run({}, 100_000, 20_000),
        run({}, 100_000, 110_000),
        run({}, 100_000, 90_000),
        run({}, 100_000, 100_000),
      ]),
    ]);
    const g = commodity(r)!;
    expect(g.n).toBe(4);
    expect(g.high_variance).toBe(true);
    expect(g.confidence).toBe("low");
    expect(g.reasons).toEqual(["high_variance"]);
  });

  it("Given steady runs, Then four are medium and eight are high; a ninth is left out as beyond the last runs", () => {
    const steady = (n: number) =>
      Array.from({ length: n }, (_, i) => run({ ageDays: 1 + i }, 100_000, 78_000 + i * 1000));
    const four = commodity(calibrate([sessionWith(1, steady(4))]))!;
    expect(four.confidence).toBe("medium");
    const nine = commodity(calibrate([sessionWith(1, steady(9))]))!;
    expect(nine.n).toBe(CALIBRATION_LAST_RUNS);
    expect(nine.confidence).toBe("high");
    expect(nine.excluded.beyond_last).toBe(1);
  });

  it("Given the newest run is old, Then the confidence is capped at low whatever n", () => {
    const old = Array.from({ length: 6 }, (_, i) => run({ ageDays: 30 + i }, 100_000, 80_000));
    const g = commodity(calibrate([sessionWith(1, old)]))!;
    expect(g.n).toBe(6);
    expect(g.last_run_age_days).toBe(30);
    expect(g.confidence).toBe("low");
    expect(g.reasons).toEqual(["not_recent"]);
  });
});

describe("Feature: stale runs, other patches and other quantities are not mixed in", () => {
  it("Given runs older than the limit, Then they are excluded and counted", () => {
    const r = calibrate([
      sessionWith(1, [
        run({ ageDays: CALIBRATION_MAX_AGE_DAYS + 5 }),
        run({ ageDays: CALIBRATION_MAX_AGE_DAYS + 9 }),
        run({ ageDays: 3 }),
        run({ ageDays: 4 }),
      ]),
    ]);
    const g = commodity(r)!;
    expect(g.n).toBe(2);
    expect(g.excluded.old).toBe(2);
  });

  it("Given a run from another patch line, Then it is excluded; the same line with another build is not", () => {
    const r = calibrate(
      [
        sessionWith(1, [run({ ageDays: 20 }), run({ ageDays: 21 })], {
          game_version: "4.9.1.100 (build 1)",
        }),
        sessionWith(2, [run({ ageDays: 5 }), run({ ageDays: 6 })], {
          game_version: "4.10.0.1 (build 2)",
        }),
      ],
      "4.10.197.2878",
    );
    const g = commodity(r)!;
    expect(g.n).toBe(2);
    expect(g.excluded.other_patch).toBe(2);
    expect(r.patch_line).toBe("4.10");
  });

  it("Given an unknown version on a run or no current version, Then the run is kept and the group says so", () => {
    const trips = [run({ ageDays: 2 }), run({ ageDays: 3 })];
    const unknown = commodity(
      calibrate([sessionWith(1, trips, { game_version: null })], "4.10.197.2878"),
    )!;
    expect(unknown.n).toBe(2);
    expect(unknown.unknown_version).toBe(2);
    const noCurrent = calibrate(
      [sessionWith(1, trips, { game_version: "3.1.0.1 (build 1)" })],
      null,
    );
    expect(noCurrent.patch_line).toBeNull();
    expect(commodity(noCurrent)!.n).toBe(2);
    expect(patchLine("not a version")).toBeNull();
    expect(patchLine("4.10.2")).toBe("4.10");
  });

  it("Given a half-loaded hold, Then the plan is scaled to the quantity moved, and a wild quantity is left out", () => {
    const r = calibrate([
      sessionWith(1, [
        // planned 100 000 for 100 SCU, moved 50 SCU, earned 50 000: exactly as planned per SCU
        run({ scu: 50, planned_scu: 100 }, 100_000, 50_000),
        run({ scu: 50, planned_scu: 100 }, 100_000, 50_000),
        // moved 10 times less: not comparable
        run({ scu: 10, planned_scu: 100 }, 100_000, 10_000),
        // quantity of the plan unknown (an older trip): used as it is, and said
        run({ planned_scu: null }, 100_000, 100_000),
      ]),
    ]);
    const g = commodity(r)!;
    expect(g.n).toBe(3);
    expect(g.excluded.quantity).toBe(1);
    expect(g.quantity_adjusted).toBe(2);
    expect(g.quantity_unknown).toBe(1);
    expect(g.gross_ratio).toBe(1);
  });
});

describe("Feature: net, fees and routes", () => {
  it("Given nets with their fees, Then the net ratio and the fee rate are given; a net with no fees is left out", () => {
    const r = calibrate([
      sessionWith(1, [
        run({}, 100_000, 80_000), // net 76 000
        run({}, 100_000, 80_000),
        // the balance moved for another reason: net known, fees not
        run({ fees_auec: null, fees_method: null, net_auec: 400_000 }, 100_000, 80_000),
      ]),
    ]);
    const g = commodity(r)!;
    expect(g.n).toBe(3);
    expect(g.net_n).toBe(2);
    expect(g.net_ratio).toBe(0.76);
    // 4 000 over a turnover of 280 000, twice
    expect(g.fee_n).toBe(2);
    expect(g.fee_rate).toBe(0.014);
    expect(g.fee_measured).toBe(2);
  });

  it("Given one net only, Then there is no net ratio (not below two runs)", () => {
    const r = calibrate([
      sessionWith(1, [
        run({}, 100_000, 80_000),
        run({ net_auec: null, fees_auec: null, fees_method: null }, 100_000, 80_000),
      ]),
    ]);
    const g = commodity(r)!;
    expect(g.net_ratio).toBeNull();
    expect(g.net_n).toBe(1);
    expect(g.fee_rate).toBeNull();
  });

  it("Given runs on a route and on another, Then the route group is finer and the commodity group pools them", () => {
    const other = { plan_buy_terminal: "Lorville CBD", plan_sell_terminal: "Area18 TDD" };
    const r = calibrate([
      sessionWith(1, [
        run({}, 100_000, 90_000),
        run({}, 100_000, 90_000),
        run(other, 100_000, 40_000),
        run({ plan_buy_terminal: null, plan_sell_terminal: null }, 100_000, 40_000),
      ]),
    ]);
    expect(commodity(r)!.n).toBe(4);
    const routes = r.groups.filter((g) => g.kind === "route");
    expect(routes.map((g) => g.n).sort()).toEqual([1, 2]);
    const hit = pickGroup(r.groups, "laranite", "port tressler", "AREA18 TDD")!;
    expect(hit.scope).toBe("route");
    expect(hit.group.gross_ratio).toBe(0.9);
    // the other route has one run: the commodity group answers instead, and says so through its scope
    const fallback = pickGroup(r.groups, "Laranite", "Lorville CBD", "Area18 TDD")!;
    expect(fallback.scope).toBe("commodity");
    expect(route(r)).toBeDefined();
  });

  it("Given the poll form, Then only groups with two runs or more are carried, without prose", () => {
    const r = calibrate([sessionWith(1, [run(), run(), run({ commodity: "Gold" })])]);
    const poll = calibrationForPoll(r);
    expect(poll.groups.every((g) => g.n >= 2)).toBe(true);
    expect(poll).not.toHaveProperty("note");
    expect(poll).not.toHaveProperty("rules");
  });

  it("Given runs in several sessions, Then they are all counted, and `last` narrows to the newest sessions", () => {
    const sessions = [
      sessionWith(1, [run({ ageDays: 10 }), run({ ageDays: 11 })]),
      sessionWith(2, [run({ ageDays: 2 }), run({ ageDays: 3 })]),
    ];
    expect(commodity(calibrate([...sessions]))!.n).toBe(4);
    expect(commodity(calibrate([...usedSessions(sessions, 1)]))!.n).toBe(2);
  });
});

describe("Feature: the calibrated expectation is an estimate with its sample size", () => {
  it("Given a net ratio from two runs or more, Then the expected net is the planned profit times it", () => {
    const g = commodity(
      calibrate([sessionWith(1, [run({}, 100_000, 80_000), run({}, 100_000, 80_000)])]),
    )!;
    expect(expectedNet(g, 200_000)).toEqual({
      auec: 152_000,
      basis: "net_ratio",
      ratio: 0.76,
      n: 2,
      confidence: "low",
      goods_unverified: false,
    });
  });

  it("Given no net ratio but a gross ratio and fees, Then the fee rate on the planned turnover is taken off", () => {
    const g = {
      ...commodity(
        calibrate([sessionWith(1, [run({}, 100_000, 80_000), run({}, 100_000, 80_000)])]),
      )!,
      net_ratio: null,
      net_n: 0,
    };
    const e = expectedNet(g, 100_000, 300_000)!;
    expect(e.basis).toBe("gross_ratio_minus_fees");
    // 100 000 x 0.8 minus 0.014 x 300 000
    expect(e.auec).toBe(75_800);
    expect(e.confidence).toBe("low");
    expect(expectedNet(g, 100_000)).toBeNull(); // needs the planned turnover
    expect(expectedNet(g, Number.NaN, 300_000)).toBeNull();
  });
});
