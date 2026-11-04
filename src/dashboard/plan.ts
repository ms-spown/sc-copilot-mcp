import { stripInvisible } from "../core/untrusted.js";
import { PLAN_PRICE_POINTS_MAX, PLAN_TEXT_MAX } from "./constants.js";

/**
 * The optional route plan Claude passes when it opens the dashboard (after uex_get_trade_routes). It is text that
 * came from the model, and through it possibly from a website: every string is cleaned and capped here, unknown
 * fields are dropped without a word, and the View shows it with textContent only.
 */
export interface Plan {
  commodity?: string;
  buy_terminal?: string;
  sell_terminal?: string;
  note?: string;
  scu?: number;
  /** The planned PROFIT (margin before fees): sales minus purchases at the planned prices. Not a turnover. */
  expected_profit_auec?: number;
  /** Planned price per SCU, in aUEC, at the buying and at the selling terminal. */
  buy_unit_price?: number;
  sell_unit_price?: number;
  /** Estimated trip time of the route, in minutes (an estimate by whoever suggested the route). */
  est_trip_minutes?: number;
  /** A short remark on how safe the route is (text from the model: shown as plain text). */
  safety_note?: string;
  /**
   * Recent prices per SCU for the "cours" curve, oldest first, at most PLAN_PRICE_POINTS_MAX. Claude fills them from
   * the UEX price tools; the dashboard server never calls UEX. `price_points_for` says which price they are (the
   * selling price when absent), `price_points_label` the period in words ("7 derniers jours").
   */
  price_points?: number[];
  price_points_for?: "buy" | "sell";
  price_points_label?: string;
}

/**
 * A suggested route has the very shape of a plan: applying a suggestion as the active plan is passing it through
 * `parsePlan` again (nothing else to convert). The suggestions themselves are produced by an action bar that does
 * not exist yet (see tradeActions.ts); this type is the seam.
 */
export type RouteSuggestion = Plan;

const TEXT_FIELDS = [
  "commodity",
  "buy_terminal",
  "sell_terminal",
  "note",
  "safety_note",
  "price_points_label",
] as const;

export function cleanPlanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // The one rule of the server for invisible and direction-changing characters (core/untrusted.ts), then spaces.
  const cleaned = stripInvisible(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return [...cleaned].slice(0, PLAN_TEXT_MAX).join("");
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A plan from anything: only known fields survive, nothing throws. Undefined when nothing usable is left. */
export function parsePlan(input: unknown): Plan | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const plan: Plan = {};
  for (const key of TEXT_FIELDS) {
    const text = cleanPlanText(raw[key]);
    if (text) plan[key] = text;
  }
  const scu = boundedNumber(raw["scu"], 0, 1_000_000);
  if (scu !== undefined) plan.scu = scu;
  const profit = boundedNumber(raw["expected_profit_auec"], -1_000_000_000_000, 1_000_000_000_000);
  if (profit !== undefined) plan.expected_profit_auec = profit;
  const buy = boundedNumber(raw["buy_unit_price"], 0, 1_000_000_000);
  if (buy !== undefined && buy > 0) plan.buy_unit_price = buy;
  const sell = boundedNumber(raw["sell_unit_price"], 0, 1_000_000_000);
  if (sell !== undefined && sell > 0) plan.sell_unit_price = sell;
  const trip = boundedNumber(raw["est_trip_minutes"], 0, 100_000);
  if (trip !== undefined && trip > 0) plan.est_trip_minutes = trip;
  const points = cleanPricePoints(raw["price_points"]);
  if (points) {
    plan.price_points = points;
    if (raw["price_points_for"] === "buy" || raw["price_points_for"] === "sell") {
      plan.price_points_for = raw["price_points_for"];
    }
  }
  if (!points) delete plan.price_points_label;
  return Object.keys(plan).length > 0 ? plan : undefined;
}

/** At most PLAN_PRICE_POINTS_MAX finite non-negative numbers, the newest kept; fewer than two make no curve. */
export function cleanPricePoints(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: number[] = [];
  for (const v of value) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000) {
      points.push(Math.round(v * 100) / 100);
    }
  }
  const kept = points.slice(-PLAN_PRICE_POINTS_MAX);
  return kept.length >= 2 ? kept : undefined;
}
