import { rowTimestamp } from "./freshness.js";
import { BUILT_IN_LEGEND } from "./marketStatus.js";
import { amount, toNumber, type Row } from "./normalize.js";
import type { Leg } from "./planner.js";

/**
 * What the per-commodity answer of UEX (`/commodities_prices?id_commodity=`) says about a leg beyond its two prices.
 *
 * The planner reads that answer anyway, to count the player reports of the options it will show; this file keeps the rest of
 * what is in it (the file `commodities_prices_all` has none of these fields). Every figure here is read, never invented, and
 * every one is `null` when the answer was not read or did not carry it: a missing signal is not a reassuring one.
 *
 * What a field means, and does not:
 *  - `price_*_min` / `price_*_max`: the lowest and highest price UEX has recorded for that terminal. The window they cover is
 *    not documented (in the answers we cached the plain, weekly and monthly values were always identical), so the range is
 *    quoted as "UEX's range for this terminal", never as a period.
 *  - `price_*_users_rows`: how many player reports the price rests on (0 = a UEX estimate).
 *  - `status_sell`: UEX's inventory level at the selling terminal, 1 to 7 (legend in marketStatus.ts: 6 = 72-85 % full, "the
 *    price drops quickly"; 7 = no demand). The percentages come from the built-in copy of UEX's legend.
 */

export interface MarketRow {
  terminalId: number;
  buyPrice: number;
  sellPrice: number;
  buyLow: number;
  buyHigh: number;
  sellLow: number;
  sellHigh: number;
  /** Player reports behind the price; null: UEX did not say. */
  buyReports: number | null;
  sellReports: number | null;
  scuBuy: number;
  statusSell: number;
  updatedAt: number | null;
}

export interface PriceRange {
  low: number;
  high: number;
}

export interface LegMarket {
  /** UEX's recorded low and high of the price at the buy / sell terminal. null: not given. */
  buy_range: PriceRange | null;
  sell_range: PriceRange | null;
  /** SCU shown for sale at the buy terminal, before the hold and the budget cap. null: not given. */
  stock_scu: number | null;
  /** UEX's inventory level at the sell terminal (1 to 7) and its legend percentage. null: no report. */
  sell_inventory: { code: number; fill: string | null } | null;
  /** Terminals showing exactly this sell price, of the terminals with a recent sell price for this commodity. */
  sell_peers: { same_price: number; priced: number } | null;
  /** Terminals with at least one player report on this commodity, of the terminals with a price for it. */
  commodity_reports: { reported: number; terminals: number } | null;
}

export function parseMarketRows(rows: readonly Row[]): MarketRow[] {
  const out: MarketRow[] = [];
  for (const r of rows) {
    const terminalId = toNumber(r.id_terminal);
    if (terminalId === undefined) continue;
    out.push({
      terminalId,
      buyPrice: amount(r.price_buy),
      sellPrice: amount(r.price_sell),
      buyLow: amount(r.price_buy_min),
      buyHigh: amount(r.price_buy_max),
      sellLow: amount(r.price_sell_min),
      sellHigh: amount(r.price_sell_max),
      buyReports: toNumber(r.price_buy_users_rows) ?? null,
      sellReports: toNumber(r.price_sell_users_rows) ?? null,
      scuBuy: amount(r.scu_buy),
      statusSell: amount(r.status_sell),
      updatedAt: rowTimestamp(r),
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

const range = (low: number, high: number): PriceRange | null =>
  low > 0 && high >= low ? { low, high } : null;

export interface LegMarketOptions {
  now: number;
  maxAgeDays: number;
  includeStale: boolean;
}

/** The market facts of one leg, from the rows of its commodity. null when the answer for the commodity was not read. */
export function legMarket(
  leg: Leg,
  rows: readonly MarketRow[] | undefined,
  o: LegMarketOptions,
): LegMarket | null {
  if (!rows || rows.length === 0) return null;
  const buyRow = rows.find((r) => r.terminalId === leg.fromId);
  const sellRow = rows.find((r) => r.terminalId === leg.toId);
  const recent = (r: MarketRow): boolean =>
    o.includeStale || (r.updatedAt !== null && o.now - r.updatedAt <= o.maxAgeDays * DAY_MS);
  const sellers = rows.filter((r) => r.sellPrice > 0 && recent(r));
  const status = leg.sellStatus ?? sellRow?.statusSell ?? 0;
  const level = status > 0 ? BUILT_IN_LEGEND.sell.find((l) => l.code === status) : undefined;
  const stock = leg.stockScu ?? buyRow?.scuBuy ?? 0;
  const priced = rows.filter((r) => r.buyPrice > 0 || r.sellPrice > 0);
  return {
    buy_range: buyRow ? range(buyRow.buyLow, buyRow.buyHigh) : null,
    sell_range: sellRow ? range(sellRow.sellLow, sellRow.sellHigh) : null,
    stock_scu: stock > 0 ? stock : null,
    sell_inventory: status > 0 ? { code: status, fill: level?.percentage ?? null } : null,
    sell_peers:
      sellers.length > 0
        ? {
            same_price: sellers.filter((r) => r.sellPrice === leg.sellPrice).length,
            priced: sellers.length,
          }
        : null,
    commodity_reports:
      priced.length > 0
        ? {
            reported: priced.filter((r) => (r.buyReports ?? 0) > 0 || (r.sellReports ?? 0) > 0)
              .length,
            terminals: priced.length,
          }
        : null,
  };
}
