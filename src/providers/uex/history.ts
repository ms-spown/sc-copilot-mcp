import { ageDays, amount, isRow, round, type Row } from "./normalize.js";
import { parseUexDate } from "./freshness.js";

/**
 * Price history of one commodity at one terminal (UEX `commodities_prices_history`).
 *
 * UEX returns about 10 report snapshots (it looks capped; the 10 points of the sample spanned 24 days
 * with gaps of 1 to 8 days). That is a thin base for statistics, so every figure here carries the
 * number of points it rests on, and the verdict says "not enough points" below `MIN_POINTS`.
 *
 * A history row has `date_added` (the snapshot time) and NO `date_modified`: this is the one place
 * where `date_added` is the date of the data.
 */

export const MIN_POINTS = 4;
/** A latest point older than this means the "current" price may no longer be current. */
export const STALE_AFTER_DAYS = 7;

export type Side = "sell" | "buy";

export interface Point {
  at: string;
  age_days: number | null;
  price: number;
}

export type Verdict = "high" | "low" | "normal" | "not_enough_points";

export interface SideSummary {
  /** `sell`: what the terminal pays you. `buy`: what you pay the terminal. */
  side: Side;
  points_used: number;
  points: Point[];
  low: number;
  high: number;
  mean: number;
  std_dev: number;
  /** std_dev / mean: 0.1 = the price typically moves by 10 % around its mean. */
  volatility: number;
  /** The newest point, taken as the current price. */
  current: number;
  current_at: string;
  current_age_days: number | null;
  stale: boolean;
  /** (current - low) / (high - low), 0 = at the lowest of these points, 1 = at the highest; null when the price never moved. */
  position_in_range: number | null;
  current_vs_mean_percent: number;
  verdict: Verdict;
  verdict_text: string;
}

const priceField: Record<Side, string> = { sell: "price_sell", buy: "price_buy" };

/** Lowest and highest quarter of the range are "low" and "high". Below 2 % of the mean the price is flat. */
const EDGE = 0.25;
const FLAT_RELATIVE_RANGE = 0.02;

function verdictFor(
  side: Side,
  s: Omit<SideSummary, "verdict" | "verdict_text">,
): [Verdict, string] {
  const n = s.points_used;
  if (n < MIN_POINTS) {
    return [
      "not_enough_points",
      `Only ${n} point(s): too few to say whether this price is high or low for this terminal (at least ${MIN_POINTS} needed).`,
    ];
  }
  const flat = s.mean > 0 && (s.high - s.low) / s.mean < FLAT_RELATIVE_RANGE;
  const pos = s.position_in_range;
  let verdict: Verdict = "normal";
  if (!flat && pos !== null) verdict = pos >= 1 - EDGE ? "high" : pos <= EDGE ? "low" : "normal";
  const who = side === "sell" ? "what this terminal pays" : "what this terminal charges";
  const base = `Based on ${n} points over a short window`;
  const flavour =
    verdict === "high"
      ? side === "sell"
        ? "good moment to sell here, compared with its recent range"
        : "expensive here, compared with its recent range"
      : verdict === "low"
        ? side === "sell"
          ? "poor price to sell here, compared with its recent range"
          : "cheap here, compared with its recent range"
        : flat
          ? "the price barely moves here"
          : "inside its usual recent range";
  return [verdict, `${base}: ${who} is ${verdict} for this terminal (${flavour}).`];
}

/** Summarise one side of a terminal's history. Returns null when the side has no priced point. */
export function summarizeSide(rows: readonly Row[], side: Side, now: number): SideSummary | null {
  const field = priceField[side];
  const pts = rows
    .map((r) => ({ price: amount(r[field]), at: parseUexDate(r.date_added) }))
    .filter((p): p is { price: number; at: number } => p.price > 0 && p.at !== null)
    .sort((a, b) => a.at - b.at);
  if (pts.length === 0) return null;
  const prices = pts.map((p) => p.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length;
  const std = Math.sqrt(variance);
  const newest = pts[pts.length - 1];
  const age = ageDays(newest.at, now);
  const base = {
    side,
    points_used: pts.length,
    points: pts.map((p) => ({
      at: new Date(p.at).toISOString(),
      age_days: ageDays(p.at, now),
      price: p.price,
    })),
    low,
    high,
    mean: round(mean, 1),
    std_dev: round(std, 1),
    volatility: round(mean > 0 ? std / mean : 0, 3),
    current: newest.price,
    current_at: new Date(newest.at).toISOString(),
    current_age_days: age,
    stale: age !== null && age > STALE_AFTER_DAYS,
    position_in_range: high > low ? round((newest.price - low) / (high - low), 2) : null,
    current_vs_mean_percent: round(mean > 0 ? ((newest.price - mean) / mean) * 100 : 0, 1),
  };
  const [verdict, verdict_text] = verdictFor(side, base);
  return { ...base, verdict, verdict_text };
}

export interface HistorySummary {
  rows_from_uex: number;
  /** Days between the oldest and the newest snapshot. */
  span_days: number | null;
  short_history_notice: string;
  /** Sides with at least one priced point; a terminal may only buy or only sell a commodity. */
  sides: SideSummary[];
  /** Oldest and newest snapshot (epoch ms), for the provenance. */
  oldest: number | null;
  newest: number | null;
}

export function summarizeHistory(rows: readonly unknown[], now: number): HistorySummary {
  const list = rows.filter(isRow);
  const times = list.map((r) => parseUexDate(r.date_added)).filter((t): t is number => t !== null);
  const oldest = times.length ? Math.min(...times) : null;
  const newest = times.length ? Math.max(...times) : null;
  const spanDays =
    oldest !== null && newest !== null ? round((newest - oldest) / 86_400_000, 1) : null;
  const sides = (["sell", "buy"] as const)
    .map((s) => summarizeSide(list, s, now))
    .filter((s): s is SideSummary => s !== null);
  return {
    rows_from_uex: list.length,
    span_days: spanDays,
    short_history_notice:
      `SHORT HISTORY: UEX keeps only ${list.length} snapshot(s)` +
      (spanDays !== null ? ` covering ${spanDays} day(s)` : "") +
      ". Each snapshot is one player report, spaced irregularly. Treat every statistic below as an indication, not a trend.",
    sides,
    oldest,
    newest,
  };
}
