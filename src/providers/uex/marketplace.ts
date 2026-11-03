import { fold } from "../scmdb/fuzzy.js";
import { parseUexDate, rowUpdatedAt } from "./freshness.js";
import { ageDays, median, toNumber, toPrice, type Row } from "./rows.js";

/**
 * The player marketplace as UEX records it. Two traps handled here, once:
 *  - every price is a STRING ("6000000"), and
 *  - a price can be per UNIT or per SET/PACK/STACK/CRATE (the same item at 4,000 per unit and
 *    6,000,000 per set). Bundle prices are never compared with unit prices, and never divided
 *    (UEX does not say how many units a set holds).
 */

export const HISTORY_CAP = 1000;

/** "unit" is a price per item; any other unit is a bundle of an unstated number of items. */
export const isBundle = (unit: unknown) => typeof unit === "string" && unit !== "unit";

const unitText = (unit: unknown) =>
  typeof unit === "string" && unit ? unit : "unit (not stated by UEX)";

/**
 * What an `operation` means. UEX names the side of the advert: a "sell" advert is a player
 * offering the item (the price you would pay), a "buy" advert is a player wanting it (what you
 * would be paid).
 */
export const OPERATION_NOTE =
  "operation 'sell' = adverts where a player offers the item (the price you pay); 'buy' = adverts where a player wants it (the price you are paid).";

export interface AverageView {
  operation: unknown;
  quality_tier: number | null;
  unit: string;
  bundle: boolean;
  currency: unknown;
  price_avg: number | null;
  price_avg_last_week: number | null;
  price_avg_last_month: number | null;
  listings_count: number | null;
  /** UEX keeps the last average of an item with no listing left: that average is history, not an offer. */
  no_listing_now: boolean;
  updated_at: string | null;
  data_age_days: number | null;
}

/** marketplace_prices_averages rows: strings become numbers, units stay apart. */
export function averageViews(rows: Row[], now: number): AverageView[] {
  return rows
    .map((r) => {
      const listings = toNumber(r.listings_count);
      return {
        operation: r.operation,
        quality_tier: toNumber(r.quality_tier),
        unit: unitText(r.unit),
        bundle: isBundle(r.unit),
        currency: r.currency,
        price_avg: toPrice(r.price_avg),
        price_avg_last_week: toPrice(r.price_avg_week),
        price_avg_last_month: toPrice(r.price_avg_month),
        listings_count: listings,
        no_listing_now: listings === 0,
        updated_at: rowUpdatedAt(r),
        data_age_days: ageDays(r.date_modified, now),
      };
    })
    .sort(
      (a, b) =>
        Number(a.bundle) - Number(b.bundle) ||
        String(a.operation).localeCompare(String(b.operation)) ||
        (a.quality_tier ?? 0) - (b.quality_tier ?? 0),
    );
}

export interface TrendView {
  id_item: unknown;
  item: unknown;
  currency: unknown;
  /** Prices of adverts where players OFFER the item. The unit (per item or per bundle) is not stated by UEX in this endpoint. */
  offers: Side;
  /** Prices of adverts where players WANT the item. */
  wanted: Side;
  negotiations: { total: number | null; open: number | null; succeeded: number | null };
  total_listings: number | null;
}

interface Side {
  price_avg: number | null;
  price_avg_last_month: number | null;
  price_lowest: number | null;
  price_highest: number | null;
  listings: number | null;
}

const side = (r: Row, s: "sell" | "buy"): Side => ({
  price_avg: toPrice(r[`price_avg_${s}`]),
  price_avg_last_month: toPrice(r[`price_avg_month_${s}`]),
  price_lowest: toPrice(r[`price_min_${s}`]),
  price_highest: toPrice(r[`price_max_${s}`]),
  listings: toNumber(r[`listings_count_${s}`]),
});

/** marketplace_trends rows (the most traded items): numbers, no links. */
export function trendViews(rows: Row[]): TrendView[] {
  return rows.map((r) => ({
    id_item: r.id_item,
    item: r.item_name,
    currency: r.currency,
    offers: side(r, "sell"),
    wanted: side(r, "buy"),
    negotiations: {
      total: toNumber(r.negotiations_count),
      open: toNumber(r.negotiations_open),
      succeeded: toNumber(r.negotiations_success),
    },
    total_listings: toNumber(r.total_listings_count),
  }));
}

/** Most negotiated first: the order players actually trade in. */
export const byNegotiations = (rows: Row[]): Row[] =>
  [...rows].sort(
    (a, b) => (toNumber(b.negotiations_count) ?? 0) - (toNumber(a.negotiations_count) ?? 0),
  );

export type ItemMatch =
  { kind: "one"; row: Row } | { kind: "several"; rows: Row[] } | { kind: "none" };

/** Pick an item out of trend rows by name: an exact folded name wins, else a single match. */
export function pickTrendItem(rows: Row[], name: string): ItemMatch {
  const q = fold(name);
  const exact = rows.filter((r) => fold(r.item_name) === q);
  if (exact.length === 1) return { kind: "one", row: exact[0] };
  const pool = exact.length ? exact : rows;
  if (pool.length === 1) return { kind: "one", row: pool[0] };
  return pool.length ? { kind: "several", rows: pool } : { kind: "none" };
}

export interface HistoryGroup {
  operation: unknown;
  unit: string;
  bundle: boolean;
  quality_tier: number | null;
  adverts: number;
  price_lowest: number;
  price_median: number;
  price_highest: number;
  newest: string | null;
  oldest: string | null;
}

export interface HistorySummary {
  rows_received: number;
  /** UEX returns at most 1000 rows, newest first: with that many, older adverts are missing and the statistics cover only the newest ones. */
  truncated: boolean;
  groups: HistoryGroup[];
  newest_ms: number | null;
  oldest_ms: number | null;
}

/** marketplace_prices_history rows, summarised per (operation, unit, quality tier). Prices are strings in the data. */
export function summariseHistory(rows: Row[], received: number = rows.length): HistorySummary {
  const groups = new Map<string, { sample: Row; prices: number[]; times: number[] }>();
  const allTimes: number[] = [];
  for (const r of rows) {
    const price = toPrice(r.price);
    if (price === null) continue;
    const t = parseUexDate(r.date_added);
    const key = `${String(r.operation)}|${String(r.unit)}|${String(r.quality_tier)}`;
    const g = groups.get(key) ?? { sample: r, prices: [], times: [] };
    g.prices.push(price);
    if (t !== null) {
      g.times.push(t);
      allTimes.push(t);
    }
    groups.set(key, g);
  }
  const views: HistoryGroup[] = [...groups.values()].map(({ sample, prices, times }) => ({
    operation: sample.operation,
    unit: unitText(sample.unit),
    bundle: isBundle(sample.unit),
    quality_tier: toNumber(sample.quality_tier),
    adverts: prices.length,
    price_lowest: Math.min(...prices),
    price_median: median(prices) as number,
    price_highest: Math.max(...prices),
    newest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
  }));
  views.sort(
    (a, b) =>
      Number(a.bundle) - Number(b.bundle) ||
      String(a.operation).localeCompare(String(b.operation)) ||
      (a.quality_tier ?? 0) - (b.quality_tier ?? 0),
  );
  return {
    rows_received: received,
    truncated: received >= HISTORY_CAP,
    groups: views,
    newest_ms: allTimes.length ? Math.max(...allTimes) : null,
    oldest_ms: allTimes.length ? Math.min(...allTimes) : null,
  };
}

/** Where a price stands against the item's month average for one side and quality, per unit only. */
export function priceCheck(
  averages: AverageView[],
  price: number,
  operation: string,
  qualityTier: number,
):
  | {
      against: "price_avg_last_month";
      average: number;
      difference_percent: number;
      reading: string;
    }
  | { unavailable: string } {
  const row = averages.find(
    (a) =>
      !a.bundle &&
      a.operation === operation &&
      (a.quality_tier ?? 0) === qualityTier &&
      (a.price_avg_last_month ?? a.price_avg) !== null,
  );
  if (!row) {
    return {
      unavailable: `UEX has no per-unit average for ${operation} adverts at quality tier ${qualityTier}, so the price cannot be placed.`,
    };
  }
  const average = (row.price_avg_last_month ?? row.price_avg) as number;
  const diff = Math.round(((price - average) / average) * 1000) / 10;
  return {
    against: "price_avg_last_month",
    average,
    difference_percent: diff,
    reading:
      Math.abs(diff) < 5
        ? "close to the recent average"
        : diff < 0
          ? `${Math.abs(diff)}% below the recent average`
          : `${diff}% above the recent average`,
  };
}
