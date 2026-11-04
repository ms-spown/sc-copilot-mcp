/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { buildTradeSection } from "./tradeRun.js";
import { tradeHistory, tradeTransactions } from "./testing/tradeScenario.js";
import {
  tradeCourse,
  tradeCoursePoints,
  tradeInlineText,
  tradeWaterfall,
  tradeWaterfallLayout,
} from "./tradePanel.js";
import { ledgerTradeNormalize } from "./ledgerPanel.js";
import * as L from "./viewLogic.js";

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = BASE + 400_000;
const trade = (include = true, plan: any = { expected_profit_auec: 180_000, scu: 696 }) =>
  ledgerTradeNormalize(
    JSON.parse(
      JSON.stringify(
        buildTradeSection({
          transactions: tradeTransactions(BASE),
          history: tradeHistory(BASE, NOW),
          includeBalance: include,
          plan: plan === null ? undefined : plan,
          nowMs: NOW,
        }),
      ),
    ),
  );

describe("Feature: the waterfall", () => {
  it("Given the player's run, Then it goes planned -> price gap -> gross margin -> fees -> net, on one scale from zero", () => {
    const rows = tradeWaterfall(trade().runs[0].money);
    expect(rows.map((r) => [r.id, r.value])).toEqual([
      ["planned", 180_000],
      ["gap", 6_568],
      ["gross", 186_568],
      ["fees", -43_568],
      ["net", 143_000],
    ]);
    const { rows: placed, zero } = tradeWaterfallLayout(rows);
    expect(zero).toBe(0);
    for (const r of placed) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(100.01);
    }
    // the fee bar floats from the gross margin down to the net
    const fees = placed.find((r: any) => r.id === "fees");
    const gross = placed.find((r: any) => r.id === "gross");
    expect(fees.left + fees.width).toBeCloseTo(gross.width, 1);
  });

  it("Given a run at a loss, Then the zero line moves inside the track and the bar goes to its left", () => {
    const rows = [
      {
        id: "gross",
        kind: "total",
        from: 0,
        to: 50_000,
        value: 50_000,
        estimate: false,
        tone: "ok",
        label: "",
        hint: "",
      },
      {
        id: "net",
        kind: "total",
        from: 0,
        to: -20_000,
        value: -20_000,
        estimate: false,
        tone: "bad",
        label: "",
        hint: "",
      },
    ];
    const { rows: placed, zero } = tradeWaterfallLayout(rows);
    expect(zero).toBeGreaterThan(0);
    expect(placed[1].left + placed[1].width).toBeCloseTo(zero, 1);
  });

  it("Given a missing plan or missing fees, Then those rows are left out, not drawn at zero", () => {
    const noPlan = tradeWaterfall(trade(true, null).runs[0].money);
    expect(noPlan.map((r) => r.id)).toEqual(["gross", "fees", "net"]);
    const none = tradeWaterfall(null);
    expect(none).toEqual([]);
  });

  it("Given an estimated figure, Then its row is flagged as an estimate", () => {
    const money = trade().runs[0].money;
    money.fees.method = "estime";
    expect(tradeWaterfall(money).find((r) => r.id === "fees")!.estimate).toBe(true);
    expect(tradeWaterfall(money).find((r) => r.id === "gross")!.estimate).toBe(false);
  });
});

describe("Feature: the price curve", () => {
  const plan = {
    sell_unit_price: 457,
    price_points: [430, 440, 450, 460],
    price_points_for: "sell",
  };

  it("Given points, a target and a price obtained, Then all sit on one scale that contains them", () => {
    const c = tradeCourse(plan, { avg_sell_per_scu: 470 });
    expect(c.lo).toBe(430);
    expect(c.hi).toBe(470);
    expect(c.targetAt).toBeCloseTo((457 - 430) / 40, 6);
    expect(c.realisedAt).toBe(1);
    expect(c.mean).toBe(445);
    expect(c.targetVsMean).toBeCloseTo(457 / 445 - 1, 6);
    for (const p of tradeCoursePoints(c, 300, 72).split(" ")) {
      const [x, y] = p.split(",").map(Number) as [number, number];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(72);
    }
  });

  it("Given the balance hidden, Then the price obtained is not drawn; given one point only, Then no curve", () => {
    expect(tradeCourse(plan, null).realised).toBeNull();
    expect(tradeCourse({ price_points: [5] }, null)).toBeNull();
    expect(tradeCourse(null, null)).toBeNull();
  });

  it("Given a flat series, Then the scale does not divide by zero", () => {
    const c = tradeCourse({ price_points: [100, 100, 100] }, null);
    expect(Number.isFinite(c.meanAt)).toBe(true);
    expect(tradeCoursePoints(c, 300, 72)).not.toContain("NaN");
  });
});

describe("Feature: the compact line", () => {
  it("Given the balance shown or hidden, Then an amount appears only when shown", () => {
    const line = (include: boolean) =>
      tradeInlineText(L, trade(include), include).replace(/[\u00a0\u202f]/g, " ");
    expect(line(true)).toBe(
      "Dernier trajet · marchandise inconnue : bénéfice net +143 000 aUEC (mesuré)",
    );
    expect(line(false)).toBe("Dernier trajet · marchandise inconnue : terminé");
    expect(tradeInlineText(L, null, true)).toBe("");
    expect(tradeInlineText(L, { source: "none", runs: [] }, true)).toBe("");
  });
});
