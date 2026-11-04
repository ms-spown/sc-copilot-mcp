import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TradePlan } from "../../dashboard/tradeRun.js";
import { buildTradeJournal, parseCommerceText } from "../gamelog/trade.js";
import type { BalancePoint } from "../telemetry/service.js";
import { session, stamp } from "./fixtures.testing.js";
import { latest, observe } from "./reducer.js";
import { MIGRATIONS, parseState, SessionStore } from "./store.js";
import { TradeRunTripSource } from "./trips.js";
import { emptyState, SESSIONS_VERSION } from "./types.js";

/**
 * Feature: what a saved trade trip keeps for the route calibration (the plan's quantity and terminals, how the fees were
 * obtained), added in file version 2 without breaking a version 1 file. Invented lines and figures only.
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
const HISTORY: BalancePoint[] = [
  { at: DAY, uec: 100_000, until: DAY + 9000 },
  { at: DAY + 10_500, uec: 80_000, until: DAY + 59_000 },
  { at: DAY + 60_500, uec: 106_500, until: DAY + 200_000 },
];
const LINES = [buy(10, 20_000, 1000, WASTE), sell(60, 26_500, 10, WASTE)];
const NOW = DAY + 100_000;

describe("Feature: a trade trip keeps what the plan said", () => {
  it("Given a plan with a quantity, prices and two terminals that resembles the run, Then the trip keeps them and how its fees were obtained", async () => {
    const plan: TradePlan = {
      commodity: "Waste",
      expected_profit_auec: 8000,
      scu: 10,
      buy_unit_price: 2000,
      sell_unit_price: 2650,
      buy_terminal: "Port Tressler",
      sell_terminal: "Area18 TDD",
    };
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => plan,
    );
    const [trip] = (await src.collect(NOW)).trips;
    expect(trip).toMatchObject({
      planned_profit_auec: 8000,
      planned_scu: 10,
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
    });
    // never invented: measured, deduced, or unknown
    expect([null, "mesure", "estime"]).toContain(trip.fees_method);
  });

  it("Given the log names the goods by an id (as the real game does), Then the plan is tied to the run by its prices, and said so", async () => {
    // 10 SCU bought for 20 000 (2 000 a SCU), sold for 26 500 (2 650 a SCU)
    const plan: TradePlan = {
      commodity: "Agricium",
      expected_profit_auec: 7000,
      scu: 10,
      buy_unit_price: 1900,
      sell_unit_price: 2700,
      buy_terminal: "Lorville CBD",
      sell_terminal: "Area18 TDD",
    };
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => plan,
    );
    const [trip] = (await src.collect(NOW)).trips;
    expect(trip).toMatchObject({
      commodity: "Agricium",
      plan_link: "prices",
      planned_profit_auec: 7000,
      planned_scu: 10,
      plan_buy_terminal: "Lorville CBD",
    });
  });

  it("Given a plan whose prices are nothing like the run's, whose quantity is far off, or that has no prices, Then no plan is attached", async () => {
    const base: TradePlan = {
      commodity: "Laranite",
      expected_profit_auec: 7000,
      scu: 10,
      buy_unit_price: 1900,
      sell_unit_price: 2700,
    };
    const trips = async (plan: TradePlan) =>
      (
        await new TradeRunTripSource(
          () => transactions(LINES),
          async () => HISTORY,
          () => plan,
        ).collect(NOW)
      ).trips[0];
    for (const plan of [
      { ...base, buy_unit_price: 189, sell_unit_price: 457 }, // another commodity's prices
      { ...base, buy_unit_price: 1900, sell_unit_price: 6000 }, // the selling price is far off
      { ...base, scu: 100 }, // ten times the quantity bought
      { ...base, buy_unit_price: undefined, sell_unit_price: undefined },
    ]) {
      const trip = await trips(plan);
      expect(trip.plan_link).toBeNull();
      expect(trip.planned_profit_auec).toBeNull();
      expect(trip.commodity).toBeNull();
      expect(trip.plan_sell_terminal).toBeNull();
    }
  });

  it("Given a plan for other goods, Then none of it is attached to the run", async () => {
    const src = new TradeRunTripSource(
      () => transactions(LINES),
      async () => HISTORY,
      () => ({
        commodity: "Gold",
        expected_profit_auec: 8000,
        scu: 10,
        buy_terminal: "A",
        sell_terminal: "B",
      }),
    );
    const [trip] = (await src.collect(NOW)).trips;
    expect(trip.planned_profit_auec).toBeNull();
    expect(trip.planned_scu).toBeNull();
    expect(trip.plan_buy_terminal).toBeNull();
    expect(trip.plan_sell_terminal).toBeNull();
  });

  it("Given a run that grows after it was saved, Then the plan's quantity and terminals are kept", () => {
    const state = emptyState();
    const cfg = { gapMs: 3 * 3_600_000 };
    const base = { running: true, freshStart: false, connection: null, game: null, context: null };
    const mk = (endSec: number, withPlan: boolean) => ({
      key: "bbbbbb000001",
      kind: "trade" as const,
      source: "trade_journal" as const,
      started_at: new Date(DAY + 10_000).toISOString(),
      ended_at: new Date(DAY + endSec * 1000).toISOString(),
      commodity: "Waste",
      gross_margin_auec: endSec * 100,
      planned_profit_auec: withPlan ? 8000 : null,
      planned_scu: withPlan ? 10 : null,
      plan_buy_terminal: withPlan ? "Port Tressler" : null,
      plan_sell_terminal: withPlan ? "Area18 TDD" : null,
    });
    observe(state, { ...base, now: DAY, balance: 1, trips: [mk(60, true)] }, cfg);
    observe(state, { ...base, now: DAY + 1, balance: 1, trips: [mk(1300, false)] }, cfg);
    const [trip] = latest(state)!.trips;
    expect(trip.gross_margin_auec).toBe(130_000);
    expect(trip).toMatchObject({
      planned_profit_auec: 8000,
      planned_scu: 10,
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
    });
  });
});

describe("Feature: version 2 adds optional fields without breaking a version 1 file", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-cal-"));
    file = path.join(dir, "sessions.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const v1Trip = {
    key: "aaaaaa000001",
    kind: "trade",
    source: "trade_journal",
    ended_at: stamp(5),
    commodity: "Waste",
    gross_margin_auec: 6500,
    planned_profit_auec: 8000,
  };

  it("Given a version 1 file, Then it is migrated, its trips are kept and the new fields read as unknown (null)", () => {
    expect(SESSIONS_VERSION).toBe(2);
    expect(Object.keys(MIGRATIONS)).toContain("1");
    const r = parseState(
      JSON.stringify({ version: 1, sessions: [session(1, { trips: [v1Trip] as never })] }),
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.state.version).toBe(2);
    expect(r.state.sessions[0].trips).toHaveLength(1);
    expect(r.state.sessions[0].trips[0]).toMatchObject({
      planned_profit_auec: 8000,
      planned_scu: null,
      plan_buy_terminal: null,
      plan_sell_terminal: null,
      fees_method: null,
    });
  });

  it("Given a version 2 trip, Then the new fields survive a write and a read", async () => {
    const store = new SessionStore(file);
    const trip = {
      ...v1Trip,
      planned_scu: 100,
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
      fees_method: "mesure",
    };
    await store.transact((d) => {
      d.sessions.push(session(1, { trips: [trip] as never }));
      d.next_number = 2;
      return { changed: true, result: null };
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(2);
    const back = (await new SessionStore(file).read()).sessions[0].trips[0];
    expect(back).toMatchObject({
      planned_scu: 100,
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
      fees_method: "mesure",
    });
  });

  it("Given a file from version 3, Then it is still refused as newer and never touched", () => {
    expect(parseState(JSON.stringify({ version: 3, sessions: [] })).kind).toBe("newer");
  });

  it("Given a hostile terminal name, Then it is cleaned; given an unknown fee method, Then that session is set aside, the others stay", () => {
    const dirty = { ...v1Trip, plan_buy_terminal: "Port‮\u0000 Tressler\n\n  x" };
    const ok = parseState(
      JSON.stringify({ version: 2, sessions: [session(1, { trips: [dirty] as never })] }),
    );
    if (ok.kind !== "ok") throw new Error("not ok");
    expect(ok.state.sessions[0].trips[0].plan_buy_terminal).toBe("Port Tressler x");
    const bad = parseState(
      JSON.stringify({
        version: 2,
        sessions: [
          session(1, { trips: [{ ...v1Trip, fees_method: "evil" }] as never }),
          session(2),
        ],
      }),
    );
    if (bad.kind !== "ok") throw new Error("not ok");
    expect(bad.state.sessions.map((s) => s.number)).toEqual([2]);
    expect(bad.dropped).toBe(1);
  });
});
