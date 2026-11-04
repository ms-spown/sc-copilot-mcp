import { describe, expect, it } from "vitest";
import type { TradePlan } from "../../dashboard/tradeRun.js";
import { buildTradeJournal, parseCommerceText } from "../gamelog/trade.js";
import type { BalancePoint } from "../telemetry/service.js";
import { latest, observe } from "./reducer.js";
import { summarizeSession } from "./stats.js";
import { CompositeTripSource, TradeRunTripSource } from "./trips.js";
import { emptyState } from "./types.js";

/**
 * Feature: completed trade runs of the dashboard's commerce model are trips (one pairing, no second proration), with
 * its cost, turnover, gross margin, fees and net. Lines are invented in the shapes the parser knows.
 */

const WASTE = "aaaaaaaa-1111-4222-8333-444444444444";
const DAY = Date.UTC(2026, 10, 3, 18, 0, 0);
const at = (sec: number) => `<${new Date(DAY + sec * 1000).toISOString()}>`;
const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const ids = "playerId[9876543210] shopId[5551234]";
const buy = (sec: number, price: number, centi: number, guid: string) =>
  `${at(sec)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${ids} shopName[SCShop_Test_Admin_g] kioskId[7774321] price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${guid}] autoLoading[1] quantity[${centi}.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] ${OWNER}`;
const sell = (sec: number, amount: number, scu: number, guid: string) =>
  `${at(sec)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${ids} shopName[SCShop_Test_Admin_g] kioskId[7774321] amount[${amount}.000000] resourceGUID[${guid}] autoLoading[1] quantity[${scu}] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] ${OWNER}`;

const transactions = (lines: string[]) =>
  buildTradeJournal(parseCommerceText(lines.join("\n")), new Date(DAY + 300_000).toISOString())
    .transactions;

// 10 SCU bought for 20 000 at 10 s, sold for 26 500 at 60 s: gross margin 6 500; the wallet shows exactly that.
const HISTORY: BalancePoint[] = [
  { at: DAY, uec: 100_000, until: DAY + 9000 },
  { at: DAY + 10_500, uec: 80_000, until: DAY + 59_000 },
  { at: DAY + 60_500, uec: 106_500, until: DAY + 200_000 },
];
const LINES = [buy(10, 20_000, 1000, WASTE), sell(60, 26_500, 10, WASTE)];
const NOW = DAY + 100_000;

describe("Feature: a completed trade run is a trip with the commerce model's figures", () => {
  it("Given a run bought and fully sold, Then it is a trade trip with cost, turnover, gross margin and a measured net", async () => {
    const plan: TradePlan = { commodity: "Waste", expected_profit_auec: 8000 };
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => plan,
    );
    const { trips } = await src.collect(NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      kind: "trade",
      source: "trade_journal",
      cost_auec: 20_000,
      revenue_auec: 26_500,
      gross_margin_auec: 6500,
      net_auec: 6500,
      net_kind: "balance_delta",
    });
    const text = JSON.stringify(trips);
    expect(text).not.toContain("aaaaaaaa"); // no resource id
    expect(text).not.toContain("9876543210"); // no account id
    expect(trips[0].key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("Given no plan, Then the goods are not named (the log has no name) and nothing is planned", async () => {
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => undefined,
    );
    const { trips } = await src.collect(NOW);
    expect(trips[0].commodity).toBeNull();
    expect(trips[0].planned_profit_auec).toBeNull();
  });

  it("Given the balance was not seen, Then the net is unknown (never zero) and the gross margin stays", async () => {
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => [],
      () => undefined,
    );
    const { trips } = await src.collect(NOW);
    expect(trips).toHaveLength(1);
    expect(trips[0].net_auec).toBeNull();
    expect(trips[0].gross_margin_auec).toBe(6500);
  });

  it("Given an open run (bought, not sold), Then it is not a trip yet", async () => {
    const src = new TradeRunTripSource(
      () => transactions([buy(10, 20_000, 1000, WASTE)]),
      async () => HISTORY,
      () => undefined,
    );
    expect((await src.collect(NOW)).trips).toEqual([]);
  });

  it("Given the sale just happened (the balance has not settled), Then the trip waits", async () => {
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => undefined,
    );
    expect((await src.collect(DAY + 61_000)).trips).toEqual([]);
  });

  it("Given no journal (log off or not read yet), Then there is nothing and nothing fails", async () => {
    const src = new TradeRunTripSource(
      () => undefined,
      async () => {
        throw new Error("no history");
      },
      () => undefined,
    );
    expect(await src.collect(NOW)).toEqual({ trips: [], context: null });
  });

  it("Given a source that throws inside a composite, Then the others still answer", async () => {
    const ok = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => undefined,
    );
    const bad = {
      collect: async () => {
        throw new Error("boom");
      },
    };
    expect((await new CompositeTripSource([bad, ok]).collect(NOW)).trips).toHaveLength(1);
  });
});

describe("Feature: the run's result reaches the session once, on one basis", () => {
  it("Given a session with a trade run, Then the result is the run's net and the gross margin is shown apart", async () => {
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => ({ commodity: "Waste", expected_profit_auec: 8000 }),
    );
    const { trips } = await src.collect(NOW);
    const state = emptyState();
    const cfg = { gapMs: 3 * 3_600_000 };
    const base = {
      running: true,
      freshStart: false,
      connection: null,
      game: null,
      context: null,
    };
    observe(state, { ...base, now: DAY, balance: 100_000, trips: [] }, cfg);
    observe(state, { ...base, now: DAY + 100_000, balance: 106_500, trips }, cfg);
    const summary = summarizeSession(latest(state)!);
    expect(summary.trips).toBe(1);
    expect(summary.money.net_auec).toBe(6500);
    expect(summary.money.gross_margin_auec).toBe(6500);
    expect(summary.money.fees_auec).toBe(0);
  });
});

describe("Feature: a run that gets a late sale is one trip, not two", () => {
  it("Given 100 SCU bought and sold, then 10 SCU of old stock sold 20 minutes later, Then the session holds ONE trip with the run's own figures", async () => {
    const buyAll = buy(10, 100_000, 10_000, WASTE); // 100 SCU
    const sellAll = sell(60, 150_000, 100, WASTE);
    const late = sell(60 + 20 * 60, 20_000, 10, WASTE);
    const history: BalancePoint[] = [
      { at: DAY, uec: 500_000, until: DAY + 9000 },
      { at: DAY + 10_500, uec: 400_000, until: DAY + 59_000 },
      { at: DAY + 60_500, uec: 550_000, until: DAY + 1_259_000 },
      { at: DAY + 1_260_500, uec: 570_000, until: DAY + 3_000_000 },
    ];
    const state = emptyState();
    const cfg = { gapMs: 3 * 3_600_000 };
    const base = { running: true, freshStart: false, connection: null, game: null, context: null };
    observe(state, { ...base, now: DAY, balance: 500_000, trips: [] }, cfg);
    for (const [lines, now] of [
      [[buyAll, sellAll], DAY + 100_000],
      [[buyAll, sellAll, late], DAY + 1_300_000],
    ] as const) {
      const src = new TradeRunTripSource(
        () => transactions([...lines]),
        async () => history,
        () => undefined,
      );
      const { trips } = await src.collect(now);
      observe(state, { ...base, now, balance: 570_000, trips }, cfg);
    }
    const cur = latest(state)!;
    const runs = cur.trips.filter((t) => t.kind === "trade");
    expect(runs).toHaveLength(1);
    expect(runs[0].revenue_auec).toBeLessThanOrEqual(150_000);
    expect(runs[0].gross_margin_auec).toBe(50_000);
    expect(summarizeSession(cur).money.gross_margin_auec).toBe(50_000);
  });

  it("Given two trade trips with the same start and goods already stored (an older file), Then only the latest counts", () => {
    const state = emptyState();
    const cfg = { gapMs: 3 * 3_600_000 };
    const mk = (key: string, endSec: number, gm: number) => ({
      key,
      kind: "trade" as const,
      source: "trade_journal" as const,
      started_at: new Date(DAY + 10_000).toISOString(),
      ended_at: new Date(DAY + endSec * 1000).toISOString(),
      commodity: "Waste",
      gross_margin_auec: gm,
      net_auec: null,
    });
    const base = { running: true, freshStart: false, connection: null, game: null, context: null };
    observe(
      state,
      {
        ...base,
        now: DAY,
        balance: 1,
        trips: [mk("aaaaaa000001", 60, 50_000), mk("aaaaaa000002", 1300, 100_000)],
      },
      cfg,
    );
    const m = summarizeSession(latest(state)!).money;
    expect(m.net_auec).toBe(100_000);
    expect(m.overlap_excluded).toBe(1);
  });
});
