/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): made-up answers of `sc_trade_suggest` action preflight, in
 * the exact shape the server builds (providers/uex/preflight.ts + dashboard/preflightText.ts: the words come from the real
 * `describePreflight`). Invented figures: not UEX data, not a real market. No Node-only import: the browser loads it.
 */
import type {
  PreflightLeg,
  PreflightResult,
  PreflightVerdict,
} from "../../providers/uex/preflight.js";
import { describePreflight } from "../preflightText.js";

export type PreflightVariant = "valid" | "watch" | "drifted" | "unknown" | "wait" | "estimate";

/** The plan these answers are about (the preview's and the page tests' plan). */
export const PREFLIGHT_PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  buy_price: 189,
  sell_price: 457,
} as const;

function leg(
  side: "buy" | "sell",
  nowPrice: number | null,
  verdict: PreflightVerdict,
  over: Partial<PreflightLeg> = {},
): PreflightLeg {
  const planPrice = side === "buy" ? PREFLIGHT_PLAN.buy_price : PREFLIGHT_PLAN.sell_price;
  return {
    side,
    terminal: side === "buy" ? PREFLIGHT_PLAN.buy_terminal : PREFLIGHT_PLAN.sell_terminal,
    verdict,
    problem: null,
    plan_price: planPrice,
    now_price: nowPrice,
    drift_pct:
      nowPrice === null ? null : Math.round(((nowPrice - planPrice) / planPrice) * 1000) / 10,
    margin_effect_pct: null,
    data_age_hours: 3,
    stale: false,
    reports: 4,
    estimate: false,
    stock_level: side === "buy" ? "High Inventory" : "Medium Inventory",
    stock_fill: side === "buy" ? "58-71%" : "44-57%",
    stock_scu: side === "buy" ? 1850 : 620,
    warnings: [],
    ...over,
  };
}

function base(
  verdict: PreflightVerdict,
  legs: PreflightLeg[],
  nowMargin: number | null,
  action: PreflightResult["action"],
  over: Partial<PreflightResult> = {},
): PreflightResult {
  const plan = PREFLIGHT_PLAN.sell_price - PREFLIGHT_PLAN.buy_price;
  return {
    v: 1,
    state: "preflight",
    verdict,
    plan: { ...PREFLIGHT_PLAN },
    legs,
    margin: {
      plan_per_scu: plan,
      now_per_scu: nowMargin,
      drift_pct: nowMargin === null ? null : Math.round(((nowMargin - plan) / plan) * 1000) / 10,
    },
    action,
    read_age_s: 4,
    requests: 1,
    cached: false,
    age_s: 0,
    thresholds: { watch_pct: 15, drifted_pct: 30, stale_days: 7 },
    ...over,
  };
}

/** The structured answer for a variant. */
export function preflightAnswer(variant: PreflightVariant): Record<string, unknown> {
  if (variant === "wait") return { v: 1, state: "throttled", retry_after_s: 6 };
  if (variant === "valid") {
    return describePreflight(
      base("valid", [leg("buy", 191, "valid"), leg("sell", 452, "valid")], 261, "go"),
    ) as unknown as Record<string, unknown>;
  }
  if (variant === "estimate") {
    return describePreflight(
      base(
        "valid",
        [
          leg("buy", 189, "valid", { estimate: true, reports: 0 }),
          leg("sell", 457, "valid", { estimate: true, reports: 0 }),
        ],
        268,
        "go",
      ),
    ) as unknown as Record<string, unknown>;
  }
  if (variant === "watch") {
    return describePreflight(
      base(
        "watch",
        [
          leg("buy", 205, "valid", { margin_effect_pct: 6 }),
          leg("sell", 425, "watch", {
            margin_effect_pct: 11.9,
            data_age_hours: 216,
            stale: true,
            warnings: ["sell_saturating"],
            stock_level: "Very High Inventory",
            stock_fill: "72-85%",
          }),
        ],
        220,
        "verify",
      ),
    ) as unknown as Record<string, unknown>;
  }
  if (variant === "drifted") {
    return describePreflight(
      base(
        "drifted",
        [
          leg("buy", 189, "valid"),
          leg("sell", 300, "drifted", {
            margin_effect_pct: 58.6,
            warnings: ["sell_no_demand"],
            stock_level: "Maximum Inventory (No Demand)",
            stock_fill: "86-100%",
            stock_scu: null,
          }),
        ],
        111,
        "search_again",
      ),
    ) as unknown as Record<string, unknown>;
  }
  return describePreflight({
    v: 1,
    state: "preflight",
    verdict: "unknown",
    reason: "upstream",
    plan: { ...PREFLIGHT_PLAN },
    legs: [],
    margin: null,
    action: "retry",
    read_age_s: null,
    requests: 1,
    detail: "HTTP 503",
    cached: false,
    age_s: 0,
    thresholds: { watch_pct: 15, drifted_pct: 30, stale_days: 7 },
  }) as unknown as Record<string, unknown>;
}
