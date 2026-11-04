/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { calibrationFromLedger } from "../dashboard/calibrationPanel.js";
import { ledgerNum, ledgerOneOf, ledgerText } from "../dashboard/ledgerPanel.js";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import { PLAYER_RUN, RUN_TIMES, scheduleRun } from "../testing/replay/scripts.js";
import { F, MONEY, newestRun, useWorld } from "../testing/replay/story.js";

// The session file is fsynced at every change, and these scenarios make dozens of them (like the session tool tests).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: a complete synthetic run, replayed through the real objects (see src/testing/replay/world.ts).
 *
 * Every component of the trade pipeline has its own tests. These scenarios play ONE timeline through all of them
 * together: Game.log growing, telemetry frames carrying the balance, a plan applied by the action bar's tool, the
 * session manager writing its file, and the tools and the poll read at several moments. The expected figures are
 * worked out from the story (src/testing/replay/scripts.ts), not read from the code under test.
 */

const rig = useWorld();
const L = { ledgerNum, ledgerText, ledgerOneOf };
const newWorld = () => rig.start();
const run = newestRun;

describe("Feature: the player's run, from the first frame to the saved session", () => {
  it("Scenario: the whole run, checked at every step, comes out with the player's figures", async () => {
    const w = await newWorld();
    const t0 = 20;
    const settled = scheduleRun(w, t0);

    // ---- Step 1: nothing happened yet. The session is open, its start balance seen when the game began.
    await w.playTo(10);
    let withB = await w.poll(true);
    expect(withB.balance.uec).toBe(PLAYER_RUN.start);
    expect(withB.sessions.current.money).toMatchObject({
      start_balance_auec: PLAYER_RUN.start,
      start_balance_quality: "game_start",
    });
    expect(withB.ledger.trade).toMatchObject({ source: "journal", runs: [], runs_total: 0 });
    expectAbsent((await sweepWithoutBalance(w)).all, MONEY, "the answers without the balance (step 1)");
    expectPresent(JSON.stringify(withB), [PLAYER_RUN.start], "the poll with the balance (step 1)");

    // ---- Step 2: the plan is applied by the action bar (a search, then "apply" on the first option).
    const plan = await w.applyPlan();
    expect(plan).toMatchObject({
      commodity: "Laranite",
      scu: 600,
      expected_profit_auec: PLAYER_RUN.planned,
      buy_unit_price: 190,
      sell_unit_price: 490,
    });
    withB = await w.poll(true);
    // The plan is compared with contracts only: no contract yet, so nothing is measured against it.
    expect(withB.ledger.plan_compare).toMatchObject({ expected_auec: PLAYER_RUN.planned, measured_auec: null });
    expectAbsent((await sweepWithoutBalance(w)).all, MONEY, "the answers without the balance (plan applied)");

    // ---- Step 3: the purchases (lines at 20 and 22 s, the balance drops 0.7 s and 0.9 s later).
    // One second after the first line the journal cannot believe it yet: the game logs only failures, so a cargo line
    // is taken as done once 3 s of log have passed without an error.
    await w.playTo(t0 + RUN_TIMES.buy[0] + 1);
    expect(run(await w.poll(false))).toBeUndefined();
    // At +4 s the first purchase is confirmed; the second (written at +2 s) is still waiting for its 3 s.
    await w.playTo(t0 + 4);
    let r = run(await w.poll(false));
    expect(r).toMatchObject({ stage: "open", buys: 1, sells: 0, scu_bought: 640, uncertain: 1 });
    expect(r.money).toBeUndefined(); // no amount without the balance
    await w.playTo(t0 + 10);
    withB = await w.poll(true);
    r = run(withB);
    expect(r.stage).toBe("open");
    expect(r).toMatchObject({ buys: 2, scu_bought: 696, scu_sold: null });
    expect(r.money).toMatchObject({
      cost: F.cost,
      turnover: null,
      gross_margin: null,
      net: { auec: null, reason: "en_cours" },
    });
    // The purchase side is already measured against the balance.
    expect(r.money.fees.buy).toEqual({ auec: F.buyFee, method: "groupe" });
    expect(r.money.fees.sell).toBeNull();
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(0); // an open run is not a trip yet
    expectAbsent((await sweepWithoutBalance(w)).all, MONEY, "the answers without the balance (purchases)");

    // ---- Step 4: the first sale is believed (4 s of log), the second (written at +82 s) is still waiting for its 3 s:
    // a partial run, valued on what was paired.
    await w.playTo(t0 + RUN_TIMES.sell[0] + 4);
    r = run(await w.poll(true));
    expect(r.stage).toBe("partial");
    expect(r.uncertain).toBe(1);
    expect(r.money.gross_margin).toBe(PLAYER_RUN.sells[0].amount - PLAYER_RUN.buys[0].price);
    expect(r.money.net).toMatchObject({ auec: null, reason: "en_cours" });
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(0);

    // ---- Step 5: the last sale is written, the model waits 8 s for a late fee before it reads the final balance.
    await w.playTo(t0 + RUN_TIMES.sellChange[1] + 3);
    r = run(await w.poll(true));
    expect(r.stage).toBe("complete");
    expect(r.money.net).toMatchObject({ auec: null, reason: "en_attente" });
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(0); // not stored while the result is pending
    expectAbsent((await sweepWithoutBalance(w)).all, MONEY, "the answers without the balance (pending)");

    // ---- Step 6: settled. Every figure of the story.
    await w.playTo(settled + 6);
    withB = await w.poll(true);
    r = run(withB);
    expect(r).toMatchObject({
      stage: "complete",
      buys: 2,
      sells: 2,
      scu_bought: F.scu,
      scu_sold: F.scu,
      prior_stock_scu: 0,
      failed: 0,
      uncertain: 0,
    });
    const m = r.money;
    expect(m).toMatchObject({
      planned_profit: PLAYER_RUN.planned,
      turnover: F.turnover,
      cost: F.cost,
      cost_paired: false,
      gross_margin: F.gross, // 186 568
      price_gap: F.priceGap, // +6 568
      plan_match: "non_verifie", // the log names the goods by an id: the plan is not "verified" against the name
      gap_includes_quantity: true, // 696 SCU bought for a plan of 600
    });
    expect(m.fees).toMatchObject({
      method: "mesure",
      total: F.fees,
      buy: { auec: F.buyFee, method: "groupe" }, // 19 468
      sell: { auec: F.sellFee, method: "groupe" }, // 24 100
      unexplained: 0, // nothing the margin and the fees leave unexplained
    });
    expect(m.fees.rate).toBeCloseTo(F.fees / F.turnover, 6);
    expect(m.net).toMatchObject({
      auec: F.net, // +143 000
      method: "mesure",
      start_balance: PLAYER_RUN.start,
      end_balance: PLAYER_RUN.end,
    });
    expect(m.net.auec).toBe(PLAYER_RUN.end - PLAYER_RUN.start);
    // The balance movements list sums, to the aUEC, to the variation of the balance.
    const parts = m.decomposition.parts;
    expect(m.decomposition).toMatchObject({ net: F.net, residual: 0, closes: true });
    expect(parts).toMatchObject({
      transactions: F.gross,
      fees: -F.fees,
      items: 0,
      probable_rewards: 0,
      probable_costs: 0,
      unexplained: 0,
      ambiguous: 0,
      stream_gap: 0,
    });
    const listed = withB.ledger.movements.listed as { amount: number; category: string }[];
    expect(withB.ledger.movements.total_auec).toBe(PLAYER_RUN.end - PLAYER_RUN.start);
    expect(listed.reduce((s, x) => s + x.amount, 0)).toBe(PLAYER_RUN.end - PLAYER_RUN.start);
    expect(listed.filter((x) => x.category === "unexplained")).toEqual([]);
    expect(withB.ledger.movements.totals.fee_on_transaction.auec).toBe(-F.fees);

    // ---- The session: the trip is stored ONCE, with the plan linked by the prices of the run.
    const file = w.sessionsJson();
    expect(file.sessions).toHaveLength(1);
    const session = file.sessions[0]!;
    expect(session.trips).toHaveLength(1);
    expect(session.trips[0]).toMatchObject({
      kind: "trade",
      source: "trade_journal",
      commodity: "Laranite", // named after the plan: the log never names goods
      label: "Cargo Laranite (lien par prix)",
      scu: F.scu,
      cost_auec: F.cost,
      revenue_auec: F.turnover,
      fees_auec: F.fees,
      gross_margin_auec: F.gross,
      net_auec: F.net,
      net_kind: "balance_delta",
      fees_method: "mesure",
      unexplained_auec: 0,
      net_doubtful: false,
      planned_profit_auec: PLAYER_RUN.planned,
      planned_scu: 600,
      plan_link: "prices",
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
    });
    expect(session).toMatchObject({
      start_balance: PLAYER_RUN.start,
      start_balance_quality: "game_start",
      last_balance: PLAYER_RUN.end,
    });

    // The card, the session tool and the journal agree on the same run.
    const current = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(current.session.money).toMatchObject({
      net_auec: F.net,
      net_source: "trips",
      turnover_auec: F.turnover,
      cost_auec: F.cost,
      fees_auec: F.fees,
      gross_margin_auec: F.gross,
      start_balance_auec: PLAYER_RUN.start,
      last_balance_auec: PLAYER_RUN.end,
      balance_change_auec: F.net,
      overlap_excluded: 0,
      plan: { planned_auec: PLAYER_RUN.planned, measured_auec: F.net, trips: 1, price_linked_trips: 1 },
    });
    expect(current.session.money.plan.efficiency).toBeCloseTo(F.net / PLAYER_RUN.planned, 3);
    expect(current.recent_trips).toHaveLength(1);
    const journal = (await w.call("sc_trade_journal", { resolve_names: false })).data;
    const cargo = journal.sessions[0].cargo_runs[0];
    expect(cargo).toMatchObject({
      state: "closed",
      bought_scu: F.scu,
      sold_scu: F.scu,
      cost_auec: F.cost,
      revenue_auec: F.turnover,
      gross_margin_auec: F.gross, // the journal's pairing = the card's gross margin
    });
    expect(journal.sessions[0].totals.cargo).toMatchObject({
      bought_auec: F.cost,
      sold_auec: F.turnover,
    });
    // The journal states what the log says and nothing the balance gives.
    const journalText = JSON.stringify(journal);
    expectAbsent(
      journalText,
      [PLAYER_RUN.start, PLAYER_RUN.end, F.net, F.fees, F.buyFee, F.sellFee],
      "sc_trade_journal",
    );

    // Route reliability is silent: one run is not a sample (n < 2), in the tool and in the poll.
    const stats = (await w.call("sc_session_stats", { include_balance: true })).data;
    expect(stats.route_reliability.runs_with_plan).toBe(1);
    for (const g of stats.route_reliability.groups) {
      expect(g).toMatchObject({ n: 1, confidence: "none", gross_ratio: null, fee_rate: null });
      expect(g.goods_unverified).toBe(true);
    }
    expect(withB.ledger.calibration).toBeUndefined();

    // ---- Privacy at the end: nothing from the balance without it; the same figures with it (positive control).
    const without = await sweepWithoutBalance(w);
    expectAbsent(without.all, MONEY, "the answers without the balance (end of the run)");
    const withAll = await sweepWithBalance(w);
    expectPresent(withAll, [PLAYER_RUN.start, PLAYER_RUN.end, F.net, F.fees, F.gross], "the answers with the balance");
    // Without the balance the card still knows the run happened: places, quantities, times, counts.
    const open = run(await w.poll(false));
    expect(open).toMatchObject({ stage: "complete", buys: 2, sells: 2, scu_bought: F.scu });
    expect(open.money).toBeUndefined();

    // ---- Later: nothing changes, nothing is stored twice.
    const revision = w.sessionsJson().revision;
    await w.playTo(settled + 60);
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(1);
    expect(w.sessionsJson().sessions[0]!.trips[0]!.key).toBe(session.trips[0]!.key);
    void revision;
    // The label the View shows for a plan tied by prices exists only from two runs: a single one gives no line.
    const calib = calibrationFromLedger(L, (await w.poll(true)).ledger);
    expect(calib).toBeNull();
  });
});
