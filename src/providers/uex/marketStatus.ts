import { amount, isRow, label, toNumber, type Row } from "./normalize.js";

/**
 * Stock levels at terminals (UEX `commodities_status` legend + the `status_*` / `scu_*` fields of
 * `commodities_prices`) turned into warnings.
 *
 * The legend is NOT symmetric, and that is the whole trap:
 *  - BUY side (you buy from the terminal): code 1 = out of stock (nothing to buy), 7 = full (plenty).
 *  - SELL side (you sell to the terminal): code 1 = out of stock = the terminal wants it; 7 = maximum
 *    inventory = NO DEMAND (it will not pay for more).
 * A code 0 means "no report for that side".
 */

export interface Level {
  code: number;
  name: string;
  abbr: string;
  percentage: string;
}

export interface Legend {
  buy: Level[];
  sell: Level[];
  source: "uex" | "built_in";
}

const lv = (code: number, name: string, abbr: string, percentage: string): Level => ({
  code,
  name,
  abbr,
  percentage,
});

/** The legend UEX served on 2026-11-04, used when `commodities_status` cannot be read. */
export const BUILT_IN_LEGEND: Legend = {
  source: "built_in",
  buy: [
    lv(1, "Out of Stock (Empty)", "OS", "0-14%"),
    lv(2, "Very Low Inventory", "VL", "15-28%"),
    lv(3, "Low Inventory", "LO", "29-43%"),
    lv(4, "Medium Inventory", "ME", "44-57%"),
    lv(5, "High Inventory", "HI", "58-71%"),
    lv(6, "Very High Inventory", "VH", "72-85%"),
    lv(7, "Maximum Inventory (Full)", "MA", "86-100%"),
  ],
  sell: [
    lv(1, "Out of Stock (Empty)", "OS", "0-14%"),
    lv(2, "Very Low Inventory", "VL", "15-28%"),
    lv(3, "Low Inventory", "LO", "29-43%"),
    lv(4, "Medium Inventory", "ME", "44-57%"),
    lv(5, "High Inventory", "HI", "58-71%"),
    lv(6, "Very High Inventory", "VH", "72-85%"),
    lv(7, "Maximum Inventory (No Demand)", "ND", "86-100%"),
  ],
};

function levels(raw: unknown): Level[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRow).flatMap((r) => {
    const code = toNumber(r.code);
    const name = label(r.name, 60);
    const abbr = label(r.name_abbr, 8);
    const percentage = label(r.percentage, 12);
    return code !== undefined && name && abbr ? [lv(code, name, abbr, percentage ?? "")] : [];
  });
}

/** The legend from `commodities_status`, or the built-in one when UEX's is missing a side or a code. */
export function parseLegend(data: unknown): Legend {
  const d = isRow(data) ? data : {};
  const buy = levels(d.buy);
  const sell = levels(d.sell);
  if (buy.length === 7 && sell.length === 7) return { buy, sell, source: "uex" };
  return BUILT_IN_LEGEND;
}

export type Severity = "info" | "warning" | "critical";

export interface Warning {
  side: "buy" | "sell";
  severity: Severity;
  code: string;
  message: string;
}

export interface SideStatus {
  code: number | null;
  level: string | null;
  fill: string | null;
}

export interface TerminalStatus {
  buy: SideStatus & { price: number | null; scu_available: number | null };
  sell: SideStatus & {
    price: number | null;
    scu_in_stock: number | null;
    demand_scu: number | null;
  };
  warnings: Warning[];
}

const find = (levelsOfSide: Level[], code: number): Level | undefined =>
  levelsOfSide.find((l) => l.code === code);

const sideStatus = (levelsOfSide: Level[], code: number): SideStatus => {
  const l = code > 0 ? find(levelsOfSide, code) : undefined;
  return {
    code: code > 0 ? code : null,
    level: l ? l.name : code > 0 ? `unknown code ${code}` : null,
    fill: l ? l.percentage : null,
  };
};

/**
 * Warnings for one commodity at one terminal.
 *  - buying (price_buy > 0): empty or nearly empty stock is the risk (you may not fill the hold);
 *    a full stock is good news, not a warning;
 *  - selling (price_sell > 0): "No Demand" (7) and "Very High" (6) are the risk (the price drops as
 *    you sell, or the terminal takes nothing); empty (1-2) means strong demand.
 */
export function assessRow(row: Row, legend: Legend): TerminalStatus {
  const priceBuy = amount(row.price_buy);
  const priceSell = amount(row.price_sell);
  const statusBuy = amount(row.status_buy);
  const statusSell = amount(row.status_sell);
  const scuBuy = amount(row.scu_buy);
  const scuStock = amount(row.scu_sell_stock);
  const demand = amount(row.scu_sell);
  const warnings: Warning[] = [];

  if (priceBuy > 0) {
    if (statusBuy === 1 || scuBuy <= 0) {
      warnings.push({
        side: "buy",
        severity: "critical",
        code: "buy_out_of_stock",
        message:
          "Nothing to buy here right now (out of stock): do not plan a purchase on this terminal.",
      });
    } else if (statusBuy === 2 || statusBuy === 3) {
      warnings.push({
        side: "buy",
        severity: "warning",
        code: "buy_shortage",
        message: `Low stock (${scuBuy} SCU reported): the hold may not fill, and the price tends to rise as stock drops.`,
      });
    }
  }
  if (priceSell > 0) {
    if (statusSell === 7) {
      warnings.push({
        side: "sell",
        severity: "critical",
        code: "sell_no_demand",
        message:
          "No demand (maximum inventory): this terminal will not pay for more of it. Pick another buyer.",
      });
    } else if (statusSell === 6) {
      warnings.push({
        side: "sell",
        severity: "warning",
        code: "sell_saturating",
        message:
          "Very high inventory: close to saturation, expect the sell price to drop quickly as you sell.",
      });
    } else if (statusSell >= 1 && statusSell <= 2) {
      warnings.push({
        side: "sell",
        severity: "info",
        code: "sell_strong_demand",
        message: "Low inventory: the terminal wants this commodity (good for selling).",
      });
    }
  }
  return {
    buy: {
      ...sideStatus(legend.buy, statusBuy),
      price: priceBuy > 0 ? priceBuy : null,
      scu_available: priceBuy > 0 ? scuBuy : null,
    },
    sell: {
      ...sideStatus(legend.sell, statusSell),
      price: priceSell > 0 ? priceSell : null,
      scu_in_stock: priceSell > 0 ? scuStock : null,
      demand_scu: priceSell > 0 && demand > 0 ? demand : null,
    },
    warnings,
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** The worst severity among warnings (critical first), for sorting rows. */
export const worstSeverity = (warnings: readonly Warning[]): number =>
  warnings.length === 0 ? 3 : Math.min(...warnings.map((w) => SEVERITY_ORDER[w.severity]));
