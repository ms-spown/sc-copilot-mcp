import { describe, expect, it } from "vitest";
import type { BalancePoint } from "../providers/telemetry/service.js";
import { buildTradeJournal, pairCargoRuns, parseCommerceText } from "../providers/gamelog/trade.js";
import { hashText } from "./poll.js";
import { buildTradeSection, prepareTransactions, reconcileFees, splitRuns } from "./tradeRun.js";
import type { Transaction } from "../providers/gamelog/trade.js";
import {
  AGRICIUM_ID,
  LARANITE_ID,
  TRADE_FIGURES as F,
  tradeHistory,
  tradeLines,
  tradeTransactions,
} from "./testing/tradeScenario.js";

/**
 * Given/When/Then for the commerce model, on the synthetic copy of the player's run: bought 131 504, sold 318 072,
 * planned 180 000, balance 320 000 -> 463 000.
 */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = BASE + 400_000;
const PLAN = {
  expected_profit_auec: 180_000,
  scu: 696,
  commodity: "Laranite",
  sell_unit_price: 457,
};

const run = (over: Partial<Parameters<typeof buildTradeSection>[0]> = {}) =>
  buildTradeSection({
    transactions: tradeTransactions(BASE),
    history: tradeHistory(BASE, NOW),
    includeBalance: true,
    plan: PLAN,
    nowMs: NOW,
    ...over,
  });
const latest = (over: Partial<Parameters<typeof buildTradeSection>[0]> = {}) => run(over).runs[0]!;

describe("Feature: what a run really earned", () => {
  it("Given the player's run, Then every figure means one thing and adds up", () => {
    const m = latest().money!;
    expect(m.planned_profit).toBe(180_000);
    expect(m.turnover).toBe(318_072);
    expect(m.cost).toBe(131_504);
    expect(m.gross_margin).toBe(186_568);
    expect(m.price_gap).toBe(6_568); // gross margin - planned profit
    expect(m.net).toMatchObject({
      auec: 143_000,
      method: "mesure",
      start_balance: 320_000,
      end_balance: 463_000,
    });
    // margin - fees = net, with nothing left unexplained
    expect(m.fees.total).toBe(43_568);
    expect(m.fees.unexplained).toBe(0);
    expect(m.gross_margin! - m.fees.total!).toBe(m.net.auec);
    expect(m.avg_sell_per_scu).toBe(457);
  });

  it("Given a purchase of two lots and a sale of two, Then the fee is measured per side, as a group", () => {
    const m = latest().money!;
    expect(m.fees.method).toBe("mesure");
    expect(m.fees.buy).toEqual({ auec: F.buyFee, method: "groupe" });
    expect(m.fees.sell).toEqual({ auec: F.sellFee, method: "groupe" });
  });

  it("Given one transaction per side, Then the fee is exact and its sign is right on both sides", () => {
    const txs = tradeTransactions(BASE).filter((_, i) => i === 0 || i === 2);
    const history: BalancePoint[] = [
      { at: BASE, uec: 500_000, until: BASE + 9_900 },
      // purchase of 100 000: the balance falls by 100 000 + 7 000 of fees (one change)
      { at: BASE + 10_000, uec: 393_000, until: BASE + 99_000 },
      // sale of 150 000: the balance rises by 150 000 - 11 000
      { at: BASE + 100_000, uec: 532_000, until: BASE + 200_000 },
    ];
    const t = [
      {
        ...txs[0]!,
        time: new Date(BASE + 9_900).toISOString(),
        total_auec: 100_000,
        quantity: 100,
      },
      {
        ...txs[1]!,
        time: new Date(BASE + 99_900).toISOString(),
        total_auec: 150_000,
        quantity: 100,
      },
    ];
    const fees = latest({ transactions: t, history, plan: undefined }).money!.fees;
    expect(fees.buy).toEqual({ auec: 7_000, method: "exact" });
    expect(fees.sell).toEqual({ auec: 11_000, method: "exact" });
    expect(fees.total).toBe(18_000);
  });

  it("Given no balance history at all, Then margins stay and fees and net are unknown (never zero)", () => {
    const m = latest({ history: [] }).money!;
    expect(m.gross_margin).toBe(186_568);
    expect(m.net).toMatchObject({ auec: null, method: null, reason: "solde_avant_inconnu" });
    expect(m.fees.total).toBeNull();
    expect(m.fees.method).toBeNull();
    expect(m.planned_net).toBeNull();
    expect(m.projection?.net_per_hour).toBeNull();
  });

  it("Given a stream cut during the run, Then the fees are not matched and the total is gross margin - net, labelled estimated", () => {
    const history: BalancePoint[] = [
      { at: BASE + 6_000, uec: F.start, until: BASE + 19_000 },
      { at: BASE + 209_000, uec: F.end, until: NOW },
    ];
    const m = latest({ history }).money!;
    expect(m.net).toMatchObject({ auec: 143_000, method: "mesure" });
    expect(m.fees).toMatchObject({ total: 43_568, method: "estime", buy: null, sell: null });
  });

  it("Given fees deduced across a stream cut, Then they promise no planned net and are not carried to the next run (found by the end-to-end replay)", () => {
    const history: BalancePoint[] = [
      { at: BASE + 6_000, uec: F.start, until: BASE + 19_000 },
      { at: BASE + 209_000, uec: F.end, until: NOW },
    ];
    // the rate is shown (labelled estimated) but the plan is not netted with it: it may hold a foreign spending
    const m = latest({ history }).money!;
    expect(m.fees.method).toBe("estime");
    expect(m.fees.rate).toBeCloseTo(43_568 / 318_072, 6);
    expect(m.planned_net).toBeNull();
    // a second run whose own fees are unknown borrows no rate from it either
    const t = tradeTransactions(BASE);
    const mk = (s: number, side: "buy" | "sell", total: number): Transaction => ({
      ...t[0]!,
      time: new Date(BASE + s * 1000).toISOString(),
      side,
      total_auec: total,
      quantity: 300,
      commodity_id: AGRICIUM_ID,
    });
    const two = run({
      transactions: [...t, mk(300, "buy", 60_000), mk(330, "sell", 71_000)],
      history: [...history, { at: BASE + 215_000, uec: F.end, until: BASE + 215_000 }],
    }).runs[0]!.money!;
    expect(two.fees.rate_from).toBeUndefined();
    expect(two.fees.rate).toBeNull();
    expect(two.planned_net).toBeNull();
  });

  it("Given a measured first run and a second whose fees are deduced, Then the planned net says its rate comes from the earlier run", () => {
    const t = tradeTransactions(BASE);
    const mk = (s: number, side: "buy" | "sell", total: number): Transaction => ({
      ...t[0]!,
      time: new Date(BASE + s * 1000).toISOString(),
      side,
      total_auec: total,
      quantity: 300,
      commodity_id: AGRICIUM_ID,
    });
    // run 2: 60 000 bought (+5 000 of fee), the stream is cut over the sale (71 000, 2 000 of fee), back at 336 s
    const history: BalancePoint[] = [
      ...tradeHistory(BASE, BASE + 250_000),
      { at: BASE + 290_000, uec: F.end, until: BASE + 299_000 },
      { at: BASE + 300_500, uec: F.end - 65_000, until: BASE + 327_000 },
      { at: BASE + 336_000, uec: F.end - 65_000 + 69_000, until: NOW },
    ];
    const m = run({
      transactions: [...t, mk(300, "buy", 60_000), mk(330, "sell", 71_000)],
      history,
    }).runs[0]!.money!;
    expect(m.fees).toMatchObject({ method: "estime", total: 7_000 });
    expect(m.fees.rate_from).toBe("ce_trajet"); // the rate shown for this run is its own deduction...
    expect(m.planned_net).toMatchObject({ rate_from: "trajet_precedent" }); // ...the plan is netted with the earlier one
    expect(m.planned_net!.fee_rate).toBeCloseTo(43_568 / 318_072, 6);
  });

  it("Given the dashboard opened after the purchases, Then the net is unknown and says why; the fees of the sales are not claimed alone", () => {
    const history = tradeHistory(BASE, NOW).filter((p) => p.at > BASE + 30_000);
    const m = latest({ history }).money!;
    expect(m.net.auec).toBeNull();
    expect(m.net.reason).toBe("solde_avant_inconnu");
    expect(m.fees.total).toBeNull();
    // the first sale's change is the first point seen, so its price has no predecessor: the side is refused, not guessed
    expect(m.fees.sell).toBeNull();
    expect(m.gross_margin).toBe(186_568);
  });

  it("Given a reward paid inside the sale window, Then that side is not guessed", () => {
    const history = tradeHistory(BASE, NOW);
    // a mission reward of 50 000 right after the second sale
    const polluted = history.map((p) =>
      p.at > BASE + 202_000 ? { ...p, uec: p.uec + 50_000 } : p,
    );
    const sides = reconcileFees(
      prepareTransactions(tradeTransactions(BASE)).counted,
      prepareTransactions(tradeTransactions(BASE)).counted,
      polluted,
    );
    // the sell side includes the fee change and the reward in one window: both are "up", the fee is implausible or wrong
    expect(sides.sell === null || sides.sell.auec !== F.sellFee).toBe(true);
    // the purchase side is unaffected
    expect(sides.buy?.auec).toBe(F.buyFee);
  });

  it("Given other changes of the balance inside a sale window, Then the side is refused (something else moved the balance)", () => {
    const history = tradeHistory(BASE, NOW);
    const extra = [
      { at: BASE + 201_000, uec: history[4]!.uec + F.sells[0] - 5_000, until: BASE + 201_200 },
      { at: BASE + 201_300, uec: history[4]!.uec + F.sells[0] - 9_000, until: BASE + 201_500 },
    ];
    const noisy = [...history.slice(0, 5), ...extra, ...history.slice(5)];
    const prep = prepareTransactions(tradeTransactions(BASE)).counted;
    expect(reconcileFees(prep, prep, noisy).sell).toBeNull();
  });
});

describe("Feature: a line the journal could not confirm is never taken for a fee", () => {
  it("Given an unconfirmed buy that moved the balance inside the purchase window, Then the buy side is not measured and the fees are not deduced", () => {
    const base = tradeTransactions(BASE);
    // an extra, unconfirmed purchase of 30 000 between the two lots: the journal could not say whether it went through
    const ghost: Transaction = {
      ...base[0]!,
      time: new Date(BASE + 21_000).toISOString(),
      total_auec: 30_000,
      quantity: 10,
      status: "unconfirmed",
      confidence: "ambiguous",
      basis: "error_line_ambiguous",
    };
    const txs = [...base, ghost];
    // the balance did fall by 30 000 at 21.1 s: with the two lots and the fee that is 4 changes (< 2 per transaction)
    const history = tradeHistory(BASE, NOW).map((p) =>
      p.at > BASE + 21_000 && p.at < BASE + 150_000 ? { ...p, uec: p.uec - 30_000 } : p,
    );
    history.splice(2, 0, {
      at: BASE + 21_100,
      uec: F.start - F.buys[0] - 30_000,
      until: BASE + 22_000,
    });
    history.sort((a, b) => a.at - b.at);
    const prep = prepareTransactions(txs);
    expect(prep.unconfirmed).toHaveLength(1);
    expect(reconcileFees(prep.counted, prep.counted, history, prep.unconfirmed).buy).toBeNull();
    // Without the refusal that window would have been accepted as a measured fee of 49 468
    expect(reconcileFees(prep.counted, prep.counted, history).buy).not.toBeNull();
    const m = latest({ transactions: txs, history }).money!;
    expect(m.fees.buy).toBeNull();
    expect(m.fees.method).not.toBe("mesure");
    expect(m.fees.total).toBeNull(); // not even deduced from margin - net: it would absorb the unconfirmed line
    expect(latest({ transactions: txs, history }).uncertain).toBe(1);
  });
});

describe("Feature: the model agrees with the journal's own pairing", () => {
  it("Given the player's run, Then the gross margin is the journal's gross margin (first-in first-out)", () => {
    const base = tradeTransactions(BASE);
    const journal = buildTradeJournal(
      parseCommerceText(tradeLines(BASE).join(String.fromCharCode(10))),
      new Date(BASE + 3_600_000).toISOString(),
    );
    expect(journal.cargo_runs).toHaveLength(1);
    expect(latest().money!.gross_margin).toBe(journal.cargo_runs[0]!.gross_margin_auec);
    expect(base).toHaveLength(4);
  });
});

describe("Feature: a deduced fee must be a plausible fee", () => {
  it("Given the stream cut around the sales and 400 000 aUEC received during the trip, Then the gap is not shown as fees and no rate is carried", () => {
    const history: BalancePoint[] = [
      { at: BASE + 6_000, uec: F.start, until: BASE + 19_000 },
      // 400 000 received (a reward) on top of the run's own movements
      { at: BASE + 209_000, uec: F.end + 400_000, until: NOW },
    ];
    const m = latest({ history }).money!;
    expect(m.net).toMatchObject({ auec: 543_000, method: "mesure" });
    expect(m.fees.total).toBeNull();
    expect(m.fees.method).toBeNull();
    expect(m.fees.reason).toBe("solde_autre_raison");
    expect(m.fees.unexplained).toBe(186_568 - 543_000);
    expect(m.fees.rate).toBeNull();
    expect(m.planned_net).toBeNull();
    // nothing is built on a net that holds a reward: no next-trip figure, no hourly figure
    expect(m.projection!.net_doubtful).toBe(true);
    expect(m.projection!.next_run_net).toBeNull();
    expect(m.projection!.net_per_hour).toBeNull();
  });

  it("Given such a doubtful run followed by another run, Then the next run does not inherit a rate from it", () => {
    const first = tradeTransactions(BASE);
    const mk = (s: number, side: "buy" | "sell", total: number): Transaction => ({
      ...first[0]!,
      time: new Date(BASE + s * 1000).toISOString(),
      side,
      total_auec: total,
      quantity: 100,
    });
    const txs = [...first, mk(620, "buy", 50_000), mk(800, "sell", 80_000)];
    const history: BalancePoint[] = [
      { at: BASE + 6_000, uec: F.start, until: BASE + 19_000 },
      { at: BASE + 209_000, uec: F.end + 400_000, until: BASE + 210_000 },
    ];
    const second = latest({ transactions: txs, history, nowMs: BASE + 900_000 }).money!;
    expect(second.fees.rate_from).toBeUndefined();
    expect(second.fees.rate).toBeNull();
  });

  it("Given a plausible deduction, Then it is kept; given a negative or a huge one, Then it is refused", () => {
    const stream = (end: number): BalancePoint[] => [
      { at: BASE + 6_000, uec: F.start, until: BASE + 19_000 },
      { at: BASE + 209_000, uec: end, until: NOW },
    ];
    expect(latest({ history: stream(F.end) }).money!.fees).toMatchObject({
      total: 43_568,
      method: "estime",
    });
    // the balance is higher than the margin allows: negative fees are refused
    expect(latest({ history: stream(F.start + 190_000) }).money!.fees.reason).toBe(
      "solde_autre_raison",
    );
    // more than half of the turnover "lost": refused
    expect(latest({ history: stream(F.start - 100_000) }).money!.fees.reason).toBe(
      "solde_autre_raison",
    );
  });
});

describe("Feature: the margin follows the journal's first-in first-out pairing", () => {
  const line = (
    s: number,
    side: "buy" | "sell",
    total: number,
    scu: number,
    id: string,
  ): Transaction => ({
    ...tradeTransactions(BASE)[0]!,
    time: new Date(BASE + s * 1000).toISOString(),
    side,
    total_auec: total,
    quantity: scu,
    commodity_id: id,
    resource: id + "-0000-4000-8000-000000000000",
  });

  it("Given two commodities bought and only one sold, Then the margin is that of the sold one (+4 000, not -41 000)", () => {
    const txs = [
      line(20, "buy", 10_000, 100, "aaaaaaaa"),
      line(22, "buy", 100_000, 100, "bbbbbbbb"),
      line(200, "sell", 14_000, 100, "aaaaaaaa"),
    ];
    const m = latest({ transactions: txs, history: [], plan: undefined }).money!;
    expect(m.gross_margin).toBe(4_000);
    expect(m.cost).toBe(10_000);
    expect(m.cost_paired).toBe(true);
  });

  it("Given one commodity in two lots sold in part, Then the first lot is the one sold, as in sc_trade_journal (+5 000)", () => {
    const txs = [
      line(20, "buy", 10_000, 100, "aaaaaaaa"),
      line(22, "buy", 40_000, 100, "aaaaaaaa"),
      line(200, "sell", 15_000, 100, "aaaaaaaa"),
    ];
    expect(latest({ transactions: txs, history: [], plan: undefined }).money!.gross_margin).toBe(
      5_000,
    );
  });

  it("Given the same lines, Then the margin equals what pairCargoRuns says, whatever the shape", () => {
    const txs = [
      line(20, "buy", 10_000, 100, "aaaaaaaa"),
      line(22, "buy", 40_000, 100, "aaaaaaaa"),
      line(200, "sell", 15_000, 100, "aaaaaaaa"),
      line(210, "sell", 60_000, 100, "aaaaaaaa"),
    ];
    const paired = pairCargoRuns(txs);
    const expected = paired.reduce((n, r) => n + r.gross_margin_auec, 0);
    expect(latest({ transactions: txs, history: [], plan: undefined }).money!.gross_margin).toBe(
      expected,
    );
  });

  it("Given sales of SCU that were not bought in the run, Then the run says so, values only the paired ones and withholds fees", () => {
    const txs = [
      line(20, "buy", 10_000, 100, "aaaaaaaa"),
      line(200, "sell", 40_000, 250, "aaaaaaaa"),
    ];
    const history: BalancePoint[] = [
      { at: BASE + 6_000, uec: 100_000, until: BASE + 19_000 },
      { at: BASE + 205_000, uec: 130_000, until: NOW },
    ];
    const r = latest({ transactions: txs, history, plan: undefined });
    expect(r.prior_stock_scu).toBe(150);
    const m = r.money!;
    expect(m.turnover).toBe(40_000);
    expect(m.gross_margin).toBe(16_000 - 10_000); // only the 100 paired SCU: 40 000 x 100/250 = 16 000
    expect(m.fees.reason).toBe("stock_anterieur");
    expect(m.projection).toBeNull();
    // and without the balance, the quantity is still told (it carries no amount)
    expect(latest({ transactions: txs, includeBalance: false }).prior_stock_scu).toBe(150);
  });
});

describe("Feature: without the balance nothing depends on amounts", () => {
  it("Given two commodities whose amounts are swapped, Then the answer and so its hash are identical without the balance", () => {
    const base = tradeTransactions(BASE);
    const other = base.map((t, i) => ({
      ...t,
      commodity_id: i % 2 === 0 ? "aaaaaaaa" : "bbbbbbbb",
      resource: (i % 2 === 0 ? "aaaaaaaa" : "bbbbbbbb") + "-0000-4000-8000-000000000000",
    }));
    const swapped = other.map((t, i) => ({
      ...t,
      total_auec: other[(i + 1) % other.length]!.total_auec,
    }));
    const a = JSON.stringify(run({ transactions: other, includeBalance: false }));
    const b = JSON.stringify(run({ transactions: swapped, includeBalance: false }));
    expect(a).toBe(b);
    expect(hashText(a)).toBe(hashText(b));
    // goods come in order of first appearance
    expect(run({ transactions: other, includeBalance: false }).runs[0]).toMatchObject({
      commodity: "aaaaaaaa",
      more_commodities: ["bbbbbbbb"],
    });
  });
});

describe("Feature: the amounts exist only with the balance", () => {
  it("Given the balance is not asked, Then no run carries an amount of aUEC", () => {
    const section = run({ includeBalance: false });
    const wire = JSON.stringify(section);
    expect(wire).not.toMatch(/131504|318072|186568|143000|463000|320000|180000|43568|457/);
    expect(section.runs[0]).not.toHaveProperty("money");
    // what remains: goods, places, quantities, times, counts
    expect(section.runs[0]).toMatchObject({
      commodity: LARANITE_ID,
      stage: "complete",
      scu_bought: 696,
      scu_sold: 696,
      buys: 2,
      sells: 2,
      buy_shops: ["SCShop_Cargo_Tressler"],
      sell_shops: ["SCShop_Cargo_Area18"],
    });
  });

  it("Given no journal, Then the section says there is none", () => {
    expect(
      buildTradeSection({ transactions: undefined, history: [], includeBalance: true, nowMs: NOW }),
    ).toEqual({
      v: 1,
      source: "none",
      runs: [],
      runs_total: 0,
    });
  });
});

describe("Feature: the plan, net of the fees observed", () => {
  it("Given a plan with unit prices, Then the planned profit is cut by the observed fee rate on the planned turnover", () => {
    const m = latest().money!;
    expect(m.fees.rate).toBeCloseTo(43_568 / 318_072, 6);
    // 696 SCU at 457 = 318 072 planned turnover: the same base here
    expect(m.planned_net).toMatchObject({ basis: "prix_du_plan", fee: 43_568, auec: 136_432 });
  });

  it("Given a plan without unit prices, Then the observed turnover is the base, and it says so", () => {
    const m = latest({ plan: { expected_profit_auec: 180_000 } }).money!;
    expect(m.planned_net?.basis).toBe("chiffre_affaires_observe");
    expect(m.planned_net?.auec).toBe(136_432);
  });

  it("Given a plan for 800 SCU and a run of 696, Then the gap says that quantity is mixed in", () => {
    expect(latest({ plan: { ...PLAN, scu: 800 } }).money!.gap_includes_quantity).toBe(true);
    expect(latest().money!.gap_includes_quantity).toBe(false);
  });

  it("Given no plan, Then there is no gap and no planned figure", () => {
    const m = latest({ plan: undefined }).money!;
    expect(m.planned_profit).toBeNull();
    expect(m.price_gap).toBeNull();
    expect(m.planned_net).toBeNull();
    expect(m.plan_match).toBeNull();
  });

  it("Given a plan for other goods, Then it is compared but flagged as not verified", () => {
    expect(latest({ plan: { ...PLAN, commodity: "Agricium" } }).money!.plan_match).toBe(
      "non_verifie",
    );
    // The journal names goods by an id only (a GUID prefix): a plan can not be checked against it.
    expect(latest().money!.plan_match).toBe("non_verifie");
    // With a name that starts like the plan's (a future name lookup), it is checked.
    const named = tradeTransactions(BASE).map((x) => ({ ...x, commodity_id: "Laranite" }));
    expect(latest({ transactions: named }).money!.plan_match).toBe("ok");
  });
});

describe("Feature: pace and projection", () => {
  it("Given a single run of 182 s, Then the hours rest on the run plus an assumed overhead, and no per-day figure", () => {
    const p = latest().money!.projection!;
    expect(p.run_ms).toBe(182_000);
    expect(p.basis).toBe("duree_plus_marge");
    expect(p.overhead_ms).toBe(600_000);
    expect(p.cycle_ms).toBe(782_000);
    expect(p.runs_per_hour).toBeCloseTo(3_600 / 782, 2);
    expect(p.net_per_hour).toBe(Math.round((143_000 * 3_600) / 782));
    expect(p.measured_runs).toBe(1);
    // "sur N h de jeu" needs two measured runs
    expect(p.runs_per_day).toBeNull();
    expect(p.net_per_day).toBeNull();
    expect(p.next_run_net).toBe(136_432);
    const text = p.assumptions.join(" ");
    expect(text).toMatch(/10 min/);
    expect(text).toMatch(/hypothèse/);
    expect(text).not.toMatch(/journée/);
  });

  it("Given two measured runs, Then the cycle is the time between their starts and the day figure appears", () => {
    const first = tradeTransactions(BASE);
    // a second Laranite run, 10 minutes after the start of the first, with its own balance movements
    const at = (s: number) => new Date(BASE + s * 1000).toISOString();
    const mk = (s: number, side: "buy" | "sell", total: number): Transaction => ({
      ...first[0]!,
      time: at(s),
      side,
      total_auec: total,
      quantity: 100,
    });
    const txs = [...first, mk(620, "buy", 50_000), mk(800, "sell", 80_000)];
    const base = tradeHistory(BASE, BASE + 210_000);
    const history: BalancePoint[] = [
      ...base.slice(0, -1),
      { ...base.at(-1)!, until: BASE + 619_000 },
      { at: BASE + 620_100, uec: F.end - 50_000, until: BASE + 799_000 },
      { at: BASE + 800_100, uec: F.end - 50_000 + 80_000, until: NOW + 1_000_000 },
    ];
    const m = latest({ transactions: txs, history, nowMs: BASE + 900_000 }).money!;
    expect(m.net).toMatchObject({ auec: 30_000, method: "mesure" });
    const p = m.projection!;
    expect(p.basis).toBe("cycle_observe");
    expect(p.cycle_ms).toBe(600_000);
    expect(p.overhead_ms).toBe(0);
    expect(p.measured_runs).toBe(2);
    expect(p.runs_per_hour).toBe(6);
    expect(p.runs_per_day).toBe(24);
    expect(p.net_per_day).toBe(30_000 * 24);
    expect(p.assumptions.join(" ")).toMatch(/journée de jeu = 4 h/);
  });

  it("Given a run under two minutes, Then there is no projection", () => {
    const t = tradeTransactions(BASE).map((x, i) => ({
      ...x,
      time: new Date(BASE + 20_000 + i * 10_000).toISOString(),
    }));
    expect(latest({ transactions: t }).money!.projection).toBeNull();
  });
});

describe("Feature: runs that are not clean", () => {
  it("Given a sale of only the first lot, Then the run is partial: no net, a margin on the paired SCU only", () => {
    const t = tradeTransactions(BASE).slice(0, 3);
    const history = tradeHistory(BASE, BASE + 205_000);
    const m = latest({ transactions: t, history, nowMs: BASE + 205_000 }).money!;
    const r = latest({ transactions: t, history, nowMs: BASE + 205_000 });
    expect(r.stage).toBe("partial");
    expect(r.scu_bought).toBe(696);
    expect(r.scu_sold).toBe(640);
    expect(m.net).toMatchObject({ auec: null, reason: "en_cours" });
    expect(m.cost_paired).toBe(true);
    // first in, first out, as the journal pairs: the 640 SCU sold are the first lot
    expect(m.cost).toBe(120_923);
    expect(m.gross_margin).toBe(292_480 - 120_923);
    expect(m.price_gap).toBeNull(); // not compared with the plan before the end
    expect(m.projection).toBeNull();
  });

  it("Given purchases and no sale, Then the run is open and there is no margin", () => {
    const t = tradeTransactions(BASE).slice(0, 2);
    const r = latest({ transactions: t });
    expect(r.stage).toBe("open");
    expect(r.money!.gross_margin).toBeNull();
    expect(r.money!.cost).toBe(131_504);
    expect(r.money!.net.reason).toBe("en_cours");
  });

  it("Given sales with no purchase in view, Then the cost is unknown", () => {
    const t = tradeTransactions(BASE).slice(2);
    const r = latest({ transactions: t });
    expect(r.stage).toBe("sold_only");
    expect(r.money!.turnover).toBe(318_072);
    expect(r.money!.gross_margin).toBeNull();
    expect(r.money!.net.auec).toBeNull();
  });

  it("Given the last sale is recent, Then the net waits for the fee to be charged", () => {
    const now = BASE + 205_000;
    const m = latest({ nowMs: now, history: tradeHistory(BASE, now) }).money!;
    expect(m.net).toMatchObject({ auec: null, reason: "en_attente" });
  });

  it("Given a failed transaction, Then it is not counted and is told", () => {
    const t = tradeTransactions(BASE);
    t.push({
      ...t[1]!,
      time: new Date(BASE + 30_000).toISOString(),
      total_auec: 99_999,
      status: "failed",
      confidence: "confirmed",
    });
    const r = latest({ transactions: t });
    expect(r.failed).toBe(1);
    expect(r.money!.cost).toBe(131_504);
    expect(r.buys).toBe(2);
  });

  it("Given a sale for nothing that the game rejected, Then the card tells it as failed like the journal does, and counts nothing", () => {
    // The journal lists a cargo line with an amount of 0 as failed (`zero_amount`): the card used to drop it silently
    // because it has no positive amount, so the two disagreed on how many lines failed.
    const t = tradeTransactions(BASE);
    t.push({
      ...t[3]!,
      time: new Date(BASE + 60_000).toISOString(),
      total_auec: 0,
      status: "failed",
      reason: "zero_amount",
      basis: "zero_amount",
      confidence: "confirmed",
    });
    const r = latest({ transactions: t });
    expect(r.failed).toBe(1);
    expect(r.sells).toBe(2);
    expect(r.money!.turnover).toBe(318_072);
    expect(r.money!.fees.total).toBe(43_568);
    // Only a FAILED line may carry no amount: a completed one with nothing is still dropped.
    const done = tradeTransactions(BASE);
    done.push({ ...done[3]!, time: new Date(BASE + 60_000).toISOString(), total_auec: 0 });
    const kept = prepareTransactions(done);
    expect(kept.failed).toHaveLength(0);
    expect(kept.counted).toHaveLength(4);
  });

  it("Given a line the journal could not confirm (even an ambiguous one), Then it is not counted, exactly as the journal does, and is told", () => {
    const t = tradeTransactions(BASE);
    t[3] = {
      ...t[3]!,
      status: "unconfirmed",
      confidence: "ambiguous",
      basis: "error_line_ambiguous",
    };
    const r = latest({ transactions: t });
    expect(r.uncertain).toBe(1);
    expect(r.sells).toBe(1);
    expect(r.money!.turnover).toBe(292_480);
    expect(r.stage).toBe("partial");
  });

  it("Given a cargo line in another currency, Then it is never added to aUEC", () => {
    const t = tradeTransactions(BASE);
    t[0] = { ...t[0]!, currency: "REC" };
    expect(latest({ transactions: t }).buys).toBe(1);
  });

  it("Given items and rubbish, Then items are ignored and rubbish is dropped without an error", () => {
    const t: unknown[] = [
      ...tradeTransactions(BASE),
      { ...tradeTransactions(BASE)[0]!, kind: "item" },
      {
        time: "nope",
        side: "buy",
        kind: "commodity",
        total_auec: 5,
        currency: "aUEC",
        status: "completed",
      },
      {
        time: new Date(BASE).toISOString(),
        side: "buy",
        kind: "commodity",
        total_auec: -4,
        currency: "aUEC",
        status: "completed",
      },
      null,
      7,
    ];
    const r = latest({ transactions: t as Transaction[] });
    expect(r.ignored).toBe(1);
    expect(r.money!.turnover).toBe(318_072);
  });

  it("Given text in a label, Then it is cleaned and bounded", () => {
    const t = tradeTransactions(BASE).map((x) => ({
      ...x,
      shop: "Port\u200b Tressler\n" + "x".repeat(200),
    }));
    const shop = latest({ transactions: t }).buy_shops[0]!;
    expect(shop).not.toMatch(/[\u200b\n]/);
    expect(shop.length).toBeLessThanOrEqual(60);
  });
});

describe("Feature: two runs", () => {
  const second = (): Transaction[] => {
    const t = tradeTransactions(BASE);
    const mk = (s: number, side: "buy" | "sell", total: number): Transaction => ({
      ...t[0]!,
      time: new Date(BASE + s * 1000).toISOString(),
      side,
      total_auec: total,
      quantity: 300,
      commodity_id: AGRICIUM_ID,
    });
    return [...t, mk(300, "buy", 60_000), mk(330, "sell", 71_000)];
  };

  it("Given a purchase after a sale, Then it starts a second run, newest first", () => {
    const section = run({ transactions: second() });
    expect(section.runs_total).toBe(2);
    expect(section.runs.map((r) => r.commodity)).toEqual([AGRICIUM_ID, LARANITE_ID]);
    expect(section.runs[1]!.money!.net.auec).toBe(143_000);
    // the plan is for the latest run only
    expect(section.runs[1]!.money!.planned_profit).toBeNull();
  });

  it("Given the second run has no fee of its own, Then it borrows the rate of the earlier run and says so", () => {
    // the stream is known up to 210 s only: the second run's balance is not seen
    const money = run({
      transactions: second(),
      history: tradeHistory(BASE, BASE + 210_000),
    }).runs[0]!.money!;
    expect(money.fees.total).toBeNull();
    expect(money.fees.rate_from).toBe("trajet_precedent");
    expect(money.fees.rate).toBeCloseTo(43_568 / 318_072, 6);
    // the plan (Laranite) is applied to the latest run (AGRI) but flagged as not verified
    expect(money.plan_match).toBe("non_verifie");
    expect(money.planned_net?.basis).toBe("prix_du_plan");
  });

  it("Given a long silence, Then it is another run even without a sale in between", () => {
    const t = tradeTransactions(BASE);
    const late = { ...t[0]!, time: new Date(BASE + 3 * 3_600_000).toISOString() };
    expect(splitRuns(prepareTransactions([...t.slice(0, 2), late]).counted)).toHaveLength(2);
  });
});
