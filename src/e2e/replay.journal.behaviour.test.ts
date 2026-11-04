/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import { buyLine, errorLine, sellLine } from "../testing/replay/lines.js";
import { PLAYER_RUN, scheduleRun } from "../testing/replay/scripts.js";
import { F, MONEY, newestRun, useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: what the log says about lines that are not part of the plain story: a sale of stock from before, and
 * transactions the game rejects. The card, the journal and the saved session must tell the same thing.
 */

const rig = useWorld();

describe("Feature: a late sale of stock from before the run", () => {
  // 20 SCU left over from an earlier trip, sold five minutes after the run was settled for 8 000, 700 of fee.
  const LATE = { at: 310, amount: 8_000, scu: 20, fee: 700 };

  it("Scenario: the run grows by one sale, its trip is replaced (not doubled) and flagged as not the run's own", async () => {
    const w = await rig.start();
    scheduleRun(w, 20);
    w.at(LATE.at).log(sellLine(w.ms(LATE.at), LATE.amount, LATE.scu));
    w.at(LATE.at + 0.8).change(LATE.amount - LATE.fee);
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(130);

    // ---- The run is settled and stored with the player's figures.
    let file = w.sessionsJson();
    expect(file.sessions[0]!.trips).toHaveLength(1);
    const first = file.sessions[0]!.trips[0]!;
    expect(first).toMatchObject({
      revenue_auec: F.turnover,
      fees_auec: F.fees,
      net_auec: F.net,
      net_doubtful: false,
    });
    const revision = file.revision;

    // ---- The late sale is written. While its result settles (8 s), the stored trip does not move.
    await w.playTo(LATE.at + 5);
    let r = newestRun(await w.poll(true));
    expect(r.sells).toBe(3);
    expect(w.sessionsJson().sessions[0]!.trips[0]).toEqual(first);

    // ---- Settled: the same run, now with the sale. Stock from before is counted in the turnover and the balance, never
    // valued in the margin (nothing was bought for it in this run).
    await w.playTo(LATE.at + 20);
    const withB = await w.poll(true);
    expect(withB.ledger.trade.runs_total).toBe(1);
    r = newestRun(withB);
    expect(r).toMatchObject({
      stage: "complete",
      buys: 2,
      sells: 3,
      scu_bought: F.scu,
      scu_sold: F.scu + LATE.scu,
      prior_stock_scu: LATE.scu,
    });
    const turnover = F.turnover + LATE.amount;
    const fees = F.fees + LATE.fee;
    const net = F.net + LATE.amount - LATE.fee;
    expect(r.money).toMatchObject({
      turnover,
      cost: F.cost,
      cost_paired: true,
      gross_margin: F.gross, // unchanged: the 20 SCU are not valued
      fees: { total: fees, method: "mesure", sell: { auec: F.sellFee + LATE.fee } },
      net: { auec: net, method: "mesure" },
    });
    // What the margin and the fees do not explain is the revenue of the stock: it is in the balance, not in the margin.
    expect(r.money.fees.unexplained).toBe(F.gross - net - fees);
    expect(r.money.fees.unexplained).toBe(-LATE.amount);
    expect(r.money.projection).toBeNull(); // a run that sold stock from before is not projected

    file = w.sessionsJson();
    expect(file.sessions).toHaveLength(1);
    expect(file.sessions[0]!.trips).toHaveLength(1); // replaced, not duplicated
    const grown = file.sessions[0]!.trips[0]!;
    expect(grown.key).toBe(first.key);
    expect(grown).toMatchObject({
      revenue_auec: turnover,
      fees_auec: fees,
      net_auec: net,
      gross_margin_auec: F.gross,
      scu: F.scu + LATE.scu,
      unexplained_auec: -LATE.amount,
      // 8 000 is above 2 % of the turnover: the net holds more than the run, and the trip says so.
      net_doubtful: true,
      planned_profit_auec: PLAYER_RUN.planned,
      plan_link: "prices",
    });
    expect(Date.parse(grown.ended_at)).toBeGreaterThan(Date.parse(first.ended_at));
    expect(file.revision).toBeGreaterThan(revision);

    // The journal pairs the same lines by goods, over the whole session: the sale without a purchase is a run of its
    // own there, and the two gross margins add up to the card's.
    const journal = (
      await w.call("sc_trade_journal", { resolve_names: false, include_balance: true })
    ).data;
    const cargo = journal.sessions[0].cargo_runs as any[];
    expect(cargo.reduce((s, c) => s + c.gross_margin_auec, 0)).toBe(F.gross);
    expect(cargo.reduce((s, c) => s + c.sold_without_purchase_scu, 0)).toBe(LATE.scu);
    expect(journal.sessions[0].totals.cargo).toMatchObject({
      sold_auec: turnover,
      sold_scu: F.scu + LATE.scu,
      sell_lines: 3,
    });
    // The session total follows the replaced trip, once.
    const cur = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(cur.session.money).toMatchObject({
      net_auec: net,
      turnover_auec: turnover,
      fees_auec: fees,
    });
    expect(cur.session.trips).toBe(1);

    // Privacy: none of it without the balance.
    const without = await sweepWithoutBalance(w);
    expectAbsent(
      without.all,
      [...MONEY, net, turnover, fees, LATE.amount, LATE.fee],
      "the answers without the balance",
    );
    expectPresent(await sweepWithBalance(w), [net, turnover, fees], "the answers with the balance");
  });
});

describe("Feature: cargo transactions the game rejects", () => {
  it("Scenario: a purchase that fails and a sale of zero are excluded from every total and listed", async () => {
    const w = await rig.start();
    scheduleRun(w, 20);
    // A purchase of 30 SCU rejected: the error line comes a second later, the balance never moved.
    w.at(40).log(buyLine(w.ms(40), 5_000, 30));
    w.at(41).log(errorLine(w.ms(41)));
    // A sale of 10 SCU for nothing: the game answers it with an error too.
    w.at(60).log(sellLine(w.ms(60), 0, 10));
    w.at(61).log(errorLine(w.ms(61)));
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(120);

    const withB = await w.poll(true);
    const r = newestRun(withB);
    expect(withB.ledger.trade.runs_total).toBe(1);
    expect(r).toMatchObject({ stage: "complete", buys: 2, sells: 2, failed: 2, uncertain: 0 });
    expect(r.money).toMatchObject({
      cost: F.cost,
      turnover: F.turnover,
      gross_margin: F.gross,
      fees: { total: F.fees, method: "mesure" },
      net: { auec: F.net, method: "mesure" },
    });
    // The session keeps the run as the player lived it.
    const trips = w.sessionsJson().sessions[0]!.trips;
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      cost_auec: F.cost,
      revenue_auec: F.turnover,
      net_auec: F.net,
      scu: F.scu,
    });

    // The journal lists both rows as failed and does not count them.
    const journal = (
      await w.call("sc_trade_journal", { resolve_names: false, include_balance: true })
    ).data;
    const s = journal.sessions[0];
    expect(s.totals.excluded.failed).toBe(2);
    expect(s.totals.cargo).toMatchObject({
      bought_auec: F.cost,
      bought_scu: F.scu,
      sold_auec: F.turnover,
      sold_scu: F.scu,
      buy_lines: 2,
      sell_lines: 2,
    });
    const failed = (s.transactions as any[]).filter((t) => t.status === "failed");
    expect(failed).toHaveLength(2);
    expect(failed.map((t) => [t.side, t.total_auec, t.reason]).sort()).toEqual([
      ["buy", 5_000, "TransactionCostMismatch"],
      ["sell", 0, "TransactionCostMismatch"],
    ]);
    expect(s.cargo_runs[0]).toMatchObject({ bought_scu: F.scu, gross_margin_auec: F.gross });
    // The failed lines moved nothing: the movements are the four changes of the run.
    expect(withB.ledger.movements.count).toBe(4);
    expect(withB.ledger.movements.totals.unexplained.count).toBe(0);

    const without = await sweepWithoutBalance(w);
    expectAbsent(without.all, [...MONEY, 5_000], "the answers without the balance");
  });
});
