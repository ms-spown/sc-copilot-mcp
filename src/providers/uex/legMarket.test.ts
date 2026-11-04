import { describe, expect, it } from "vitest";
import { legMarket, parseMarketRows, type MarketRow } from "./legMarket.js";
import type { Leg } from "./planner.js";

/**
 * Feature: the market facts of a leg, read from UEX's per-commodity answer (synthetic rows, no real market).
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);
const OPTS = { now: NOW, maxAgeDays: 7, includeStale: false };

const raw = (terminal: number, o: Record<string, unknown>) => ({
  id_terminal: terminal,
  price_buy: 0,
  price_sell: 0,
  price_buy_min: 0,
  price_buy_max: 0,
  price_sell_min: 0,
  price_sell_max: 0,
  price_buy_users_rows: 0,
  price_sell_users_rows: 0,
  scu_buy: 0,
  status_sell: 0,
  date_modified: secs(DAY),
  ...o,
});

const LEG: Leg = {
  commodityId: 1,
  commodity: "Goods",
  fromId: 10,
  toId: 20,
  from: "A",
  to: "B",
  buyPrice: 3376,
  sellPrice: 5500,
  profitPerScu: 2124,
  scu: 597,
  cost: 2_015_472,
  profit: 1_268_028,
  demandScu: 0,
  buyUpdatedAt: NOW - DAY,
  sellUpdatedAt: NOW - DAY,
  limitedBy: "stock",
};

describe("Feature: reading the rows of a commodity", () => {
  it("Given UEX rows, Then the ranges, report counts, stock, inventory level and date are kept", () => {
    const rows = parseMarketRows([
      raw(10, {
        price_buy: 3376,
        price_buy_min: 3376,
        price_buy_max: 3376,
        price_buy_users_rows: 0,
        scu_buy: 600,
      }),
      raw(20, {
        price_sell: 5500,
        price_sell_min: 4800,
        price_sell_max: 5500,
        price_sell_users_rows: "3",
        status_sell: 6,
      }),
      { price_buy: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      terminalId: 10,
      buyLow: 3376,
      buyHigh: 3376,
      buyReports: 0,
      scuBuy: 600,
    });
    expect(rows[1]).toMatchObject({
      terminalId: 20,
      sellLow: 4800,
      sellHigh: 5500,
      sellReports: 3,
      statusSell: 6,
    });
    expect(rows[1].updatedAt).toBe(Math.floor((NOW - DAY) / 1000) * 1000);
  });

  it("Given a report count UEX does not give, Then it is null, never 0", () => {
    const [row] = parseMarketRows([{ id_terminal: 5, price_sell: 10 }]);
    expect(row.buyReports).toBeNull();
    expect(row.sellReports).toBeNull();
  });
});

describe("Feature: the facts of one leg", () => {
  const rows = (extra: MarketRow[] = []): MarketRow[] =>
    parseMarketRows([
      raw(10, { price_buy: 3376, price_buy_min: 3376, price_buy_max: 3376, scu_buy: 640 }),
      raw(20, {
        price_sell: 5500,
        price_sell_min: 4800,
        price_sell_max: 5500,
        status_sell: 6,
      }),
      raw(21, { price_sell: 5500, price_sell_min: 5000, price_sell_max: 5500 }),
      raw(22, { price_sell: 5500 }),
      raw(23, { price_sell: 5100 }),
      raw(24, { price_sell: 5500, date_modified: secs(30 * DAY) }),
    ]).concat(extra);

  it("Given the rows of the commodity, Then the leg gets its two ranges, its stock and the buyer's inventory with UEX's legend", () => {
    const m = legMarket(LEG, rows(), OPTS)!;
    expect(m.buy_range).toEqual({ low: 3376, high: 3376 });
    expect(m.sell_range).toEqual({ low: 4800, high: 5500 });
    expect(m.stock_scu).toBe(640);
    expect(m.sell_inventory).toEqual({ code: 6, fill: "72-85%" });
  });

  it("Given other buyers, Then those showing exactly the price are counted among the recent ones only", () => {
    const m = legMarket(LEG, rows(), OPTS)!;
    // terminals 20, 21, 22 at 5500 and 23 at 5100 are recent; 24 is 30 days old and left out
    expect(m.sell_peers).toEqual({ same_price: 3, priced: 4 });
    const all = legMarket(LEG, rows(), { ...OPTS, includeStale: true })!;
    expect(all.sell_peers).toEqual({ same_price: 4, priced: 5 });
  });

  it("Given no terminal with a report, Then the count says so; given one, Then it counts it", () => {
    expect(legMarket(LEG, rows(), OPTS)!.commodity_reports).toEqual({ reported: 0, terminals: 6 });
    const withReport = rows([
      ...parseMarketRows([raw(30, { price_sell: 4000, price_sell_users_rows: 2 })]),
    ]);
    expect(legMarket(LEG, withReport, OPTS)!.commodity_reports).toEqual({
      reported: 1,
      terminals: 7,
    });
  });

  it("Given rows with no report count at all, Then they are not counted as 0, and with none counted there is no figure", () => {
    const noCount = parseMarketRows([
      { id_terminal: 10, price_buy: 3376 },
      { id_terminal: 20, price_sell: 5500 },
      { id_terminal: 21, price_sell: 5000 },
      raw(22, { price_sell: 5100, price_sell_users_rows: 1 }),
    ]);
    // three rows carry no count: only the one that does is part of the figure
    expect(legMarket(LEG, noCount, OPTS)!.commodity_reports).toEqual({ reported: 1, terminals: 1 });
    expect(legMarket(LEG, noCount.slice(0, 3), OPTS)!.commodity_reports).toBeNull();
  });

  it("Given the leg's own stock and status (from the price file), Then they win over the rows", () => {
    const m = legMarket({ ...LEG, stockScu: 597, sellStatus: 5 }, rows(), OPTS)!;
    expect(m.stock_scu).toBe(597);
    expect(m.sell_inventory).toEqual({ code: 5, fill: "58-71%" });
  });

  it("Given a missing answer for the commodity, Then there is no market and nothing is invented", () => {
    expect(legMarket(LEG, undefined, OPTS)).toBeNull();
    expect(legMarket(LEG, [], OPTS)).toBeNull();
  });

  it("Given rows without the leg's terminals, Then the ranges and the inventory are null", () => {
    const other = parseMarketRows([raw(99, { price_sell: 10 })]);
    const m = legMarket(LEG, other, OPTS)!;
    expect(m.buy_range).toBeNull();
    expect(m.sell_range).toBeNull();
    expect(m.sell_inventory).toBeNull();
    expect(m.stock_scu).toBeNull();
  });

  it("Given an upside-down or empty range, Then it is not a range", () => {
    const odd = parseMarketRows([
      raw(10, { price_buy: 5, price_buy_min: 9, price_buy_max: 3 }),
      raw(20, { price_sell: 5, price_sell_min: 0, price_sell_max: 0 }),
    ]);
    const m = legMarket(LEG, odd, OPTS)!;
    expect(m.buy_range).toBeNull();
    expect(m.sell_range).toBeNull();
  });
});
