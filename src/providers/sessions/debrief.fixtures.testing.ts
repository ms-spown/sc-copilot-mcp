import { session, stamp } from "./fixtures.testing.js";
import type { CalibrationReport, CalibrationGroup } from "./calibration.js";
import type { Session, Trip } from "./types.js";

/**
 * TEST SUPPORT for the debrief tests: made-up sessions only. Every money field holds a UNIQUE digit pattern so that a test can
 * look for it in the output and prove an amount did not leak. No real balance, no real game data.
 */

/** Money digits that appear nowhere else in a report (see `leaks`). */
export const MONEY = {
  startBalance: 4_730_192,
  lastBalance: 5_181_447,
  cost: 612_350,
  revenue: 687_905,
  gross: 75_555,
  fees: 8_217,
  net: 67_338,
  planned: 91_466,
  unexplained: 3_719,
  contractNet: 28_864,
} as const;

export function leaks(
  text: string,
  which: (keyof typeof MONEY)[] = Object.keys(MONEY) as (keyof typeof MONEY)[],
) {
  return which.filter((k) => {
    const d = String(MONEY[k]);
    const grouped = d.replace(/\B(?=(\d{3})+(?!\d))/g, "[\\s\\u00a0\\u202f.,]?");
    return new RegExp(`(^|\\D)${grouped}(\\D|$)`).test(text);
  });
}

let counter = 0;
export function trip(over: Partial<Trip> = {}): Trip {
  counter += 1;
  return {
    key: counter.toString(16).padStart(8, "0"),
    kind: "trade",
    source: "trade_journal",
    started_at: stamp(-600),
    ended_at: stamp(0),
    label: null,
    commodity: null,
    buy_terminal: null,
    sell_terminal: null,
    scu: null,
    cost_auec: null,
    revenue_auec: null,
    fees_auec: null,
    gross_margin_auec: null,
    net_auec: null,
    net_kind: null,
    planned_profit_auec: null,
    planned_scu: null,
    plan_buy_terminal: null,
    plan_sell_terminal: null,
    plan_link: null,
    unexplained_auec: null,
    net_doubtful: null,
    fees_method: null,
    ...over,
  };
}

const HOUR = 3_600_000;

/** A complete synthetic session: a measured cargo run, a computed one, a hauling contract, an unknown-result run. */
export function richSession(n = 3, over: Partial<Session> = {}): Session {
  const base = Date.UTC(2026, 10, 4, 18, 0, 0);
  const at = (min: number) => new Date(base + min * 60_000).toISOString();
  return session(n, {
    id: `s_rich_${n}`,
    started_at: at(0),
    ended_at: at(200),
    end_reason: "manual",
    last_activity_at: at(200),
    start_balance: MONEY.startBalance,
    last_balance: MONEY.lastBalance,
    start_balance_quality: "game_start",
    game_version: "4.10.197.2878 (build 12881860)",
    game_channel: "live",
    active_ms: 3 * HOUR,
    interruptions: [
      { from: at(60), to: at(75), kind: "game_closed" },
      { from: at(120), to: at(130), kind: "unclean" },
    ],
    note: "Soirée Laranite",
    trips: [
      trip({
        key: "00000001",
        ended_at: at(40),
        started_at: at(20),
        label: "Cargo Laranite",
        commodity: "Laranite",
        buy_terminal: "Port Tressler",
        sell_terminal: "Area18 TDD",
        scu: 96,
        cost_auec: MONEY.cost,
        revenue_auec: MONEY.revenue,
        gross_margin_auec: MONEY.gross,
        fees_auec: MONEY.fees,
        fees_method: "mesure",
        net_auec: MONEY.net,
        net_kind: "balance_delta",
        planned_profit_auec: MONEY.planned,
        planned_scu: 96,
        plan_buy_terminal: "Port Tressler",
        plan_sell_terminal: "Area18 TDD",
        plan_link: "prices",
        unexplained_auec: MONEY.unexplained,
        net_doubtful: false,
      }),
      trip({
        key: "00000002",
        ended_at: at(100),
        started_at: at(80),
        label: "Cargo Gold",
        commodity: "Gold",
        scu: 32,
        cost_auec: 100_000,
        revenue_auec: 130_000,
        gross_margin_auec: 30_000,
        fees_auec: 2_000,
        fees_method: "estime",
        net_auec: 28_000,
        net_kind: "transactions",
      }),
      trip({
        key: "00000003",
        kind: "hauling",
        source: "contract_ledger",
        ended_at: at(150),
        started_at: at(140),
        label: "Livraison urgente",
        net_auec: MONEY.contractNet,
        net_kind: "balance_delta",
      }),
      trip({
        key: "00000004",
        ended_at: at(190),
        started_at: at(170),
        label: "Cargo Agricium",
        commodity: "Agricium",
        scu: 24,
        cost_auec: 50_000,
        revenue_auec: 58_000,
        gross_margin_auec: 8_000,
      }),
    ],
    ...over,
  });
}

export function group(over: Partial<CalibrationGroup> = {}): CalibrationGroup {
  return {
    kind: "route",
    commodity: "Laranite",
    buy_terminal: "Port Tressler",
    sell_terminal: "Area18 TDD",
    n: 5,
    confidence: "medium",
    reasons: [],
    gross_ratio: 0.82,
    gross_median: 0.8,
    gross_min: 0.6,
    gross_max: 1.1,
    high_variance: false,
    net_ratio: 0.7,
    net_n: 4,
    net_excluded: 1,
    net_confidence: "medium",
    fee_rate: 0.031,
    fee_n: 5,
    fee_measured: 3,
    last_run_at: stamp(0),
    last_run_age_days: 1,
    quantity_adjusted: 0,
    quantity_unknown: 0,
    unknown_version: 0,
    linked_by_prices: 5,
    goods_unverified: true,
    confidence_capped: false,
    excluded: { old: 0, other_patch: 0, quantity: 0, small_plan: 0, beyond_last: 0 },
    ...over,
  };
}

export function report(groups: CalibrationGroup[]): CalibrationReport {
  return {
    v: 1,
    as_of: stamp(0),
    patch_line: "4.10",
    rules: {
      max_age_days: 60,
      last_runs: 8,
      stale_days: 21,
      min_runs: 2,
      spread_high: 0.6,
      spread_tight: 0.3,
    },
    runs_with_plan: groups.reduce((a, g) => a + g.n, 0),
    groups,
    note: "test",
  };
}
