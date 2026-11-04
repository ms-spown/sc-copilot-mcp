/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { calibrationFromLedger, calibrationLine } from "../dashboard/calibrationPanel.js";
import { ledgerNum, ledgerOneOf, ledgerText } from "../dashboard/ledgerPanel.js";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import { PLAYER_RUN, scheduleRun } from "../testing/replay/scripts.js";
import { F, MONEY, newestRun, useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: the player's own runs say how far to trust the planner. Three runs are replayed one after the other through the
 * real objects: the calibration (providers/sessions/calibration.ts) must appear at the second, with the right ratios and
 * the goods flagged "not verified", and a third run whose balance holds a purchase made elsewhere must not poison it.
 */

const rig = useWorld();
/** The helpers the View hands to its panels. */
const L = { ledgerNum, ledgerText, ledgerOneOf };

/** Plan, run, plan, run... at these seconds (a run lasts about 90 s). */
const RUN2 = 1800;
const RUN3 = 3600;
const GIFT = 900_000;
const FUEL = 500_000;

/** The ratios the calibration must find for runs that all look like the player's (worked out from the story). */
const plannedForQuantity = (PLAYER_RUN.planned * F.scu) / 600; // 208 800: the plan, scaled to the 696 SCU moved
const grossRatio = F.gross / plannedForQuantity;
const netRatio = F.net / plannedForQuantity;
const feeRate = F.fees / F.turnover;

describe("Feature: route reliability from the player's own runs", () => {
  it("Scenario: a second identical run makes the calibration appear, a third with a foreign spending is counted out", async () => {
    const w = await rig.start();
    scheduleRun(w, 20);
    scheduleRun(w, RUN2);
    scheduleRun(w, RUN3);
    // A transfer the log knows nothing about, so that the 500 000 of fuel below can be spent.
    w.at(RUN3 - 200).change(GIFT);
    // Fuel bought elsewhere, between the purchases and the sales of the third run.
    w.at(RUN3 + 60).change(-FUEL);

    // ---- Run 1, then a long quiet stretch (the telemetry vouches for the balance only where frames came).
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(120);
    expect((await w.poll(true)).ledger.calibration).toBeUndefined(); // one run: silent
    await w.playTo(RUN2 - 10, { dt: 30 });
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(1);

    // ---- Run 2, the same figures, with a new plan applied before it (one plan carries one run: a second run of the same
    // goods never takes the old plan, which would count it twice).
    await w.playTo(RUN2 - 5);
    await w.applyPlan();
    await w.playTo(RUN2 + 96);
    let withB = await w.poll(true);
    let file = w.sessionsJson();
    expect(file.sessions).toHaveLength(1);
    expect(file.sessions[0]!.trips).toHaveLength(2);
    for (const t of file.sessions[0]!.trips) {
      expect(t).toMatchObject({
        gross_margin_auec: F.gross,
        fees_auec: F.fees,
        net_auec: F.net,
        planned_profit_auec: PLAYER_RUN.planned,
        plan_link: "prices",
        net_doubtful: false,
      });
    }

    // The calibration now has two runs behind it.
    const cal = withB.ledger.calibration;
    expect(cal.groups.map((g: any) => g.kind).sort()).toEqual(["commodity", "route"]);
    for (const g of cal.groups) {
      expect(g).toMatchObject({
        commodity: "Laranite",
        n: 2,
        confidence: "low",
        goods_unverified: true,
        net_n: 2,
        net_excluded: 0,
        fee_n: 2,
      });
      expect(g.gross_ratio).toBeCloseTo(grossRatio, 3);
      expect(g.net_ratio).toBeCloseTo(netRatio, 3);
      expect(g.fee_rate).toBeCloseTo(feeRate, 3);
    }
    // The line the View writes under a suggested route says the goods were not verified.
    const line = calibrationLine(
      calibrationFromLedger(L, withB.ledger),
      "Laranite",
      "Port Tressler",
      "Area18 TDD",
    );
    expect(line.text).toContain("tes 2 trajets similaires (marchandise non vérifiée)");
    expect(line.more).toContain("lien par prix");
    expect(line.goods_unverified).toBe(true);
    // The same report through the tool.
    const stats = (await w.call("sc_session_stats", { include_balance: true })).data;
    expect(stats.route_reliability.groups.find((g: any) => g.kind === "route")).toMatchObject({
      n: 2,
      confidence: "low",
      goods_unverified: true,
      linked_by_prices: 2,
      fee_measured: 2,
    });
    // Nothing of it without the balance: not in the poll, not in the tools, not on the channel.
    let without = await sweepWithoutBalance(w);
    for (const [where, text] of Object.entries(without)) {
      expect(text, where).not.toMatch(/gross_ratio|net_ratio|fee_rate|"calibration"/);
    }
    expectAbsent(without.all, MONEY, "the answers without the balance (second run)");
    expect(without.tools).toContain('"route_reliability":"withheld"');

    // ---- Run 3: a gift on the balance early on, and 500 000 of fuel in the middle of the run.
    await w.playTo(RUN3 - 210, { dt: 30 });
    await w.playTo(RUN3 - 5);
    await w.applyPlan();
    await w.playTo(RUN3 + 96);
    withB = await w.poll(true);
    const r3 = newestRun(withB);
    expect(r3.money).toMatchObject({
      gross_margin: F.gross,
      fees: { method: "mesure", total: F.fees, buy: { auec: F.buyFee }, sell: { auec: F.sellFee } },
      net: { auec: F.net - FUEL, method: "mesure" }, // the variation of the balance holds the fuel
    });
    // What the margin and the fees do not explain is exactly the fuel.
    expect(r3.money.fees.unexplained).toBe(FUEL);
    // The residual is what neither the margin nor a named cause explains: here, the fuel, which the log cannot name.
    expect(r3.money.decomposition).toMatchObject({
      net: F.net - FUEL,
      residual: -FUEL,
      closes: true,
    });
    expect(r3.money.decomposition.parts.unexplained).toBe(-FUEL);
    expect(r3.money.decomposition.named).toEqual([
      expect.objectContaining({ amount: -FUEL, reason: "no_cause" }),
    ]);
    // The parts add up, to the aUEC, to the net.
    const parts = Object.values(r3.money.decomposition.parts) as number[];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(F.net - FUEL);
    const foreign = withB.ledger.movements.listed.filter((x: any) => x.category === "unexplained");
    // Two movements nothing explains, newest first: the fuel (inside the run) and the transfer (before it, outside).
    expect(foreign).toEqual([
      expect.objectContaining({ amount: -FUEL, confidence: "none", reason: "no_cause" }),
      expect.objectContaining({ amount: GIFT, confidence: "none", reason: "no_cause" }),
    ]);
    // The sum invariant holds over the whole session: the movements add up to the variation of the balance.
    const variation = withB.balance.uec - PLAYER_RUN.start;
    expect(withB.ledger.movements.total_auec).toBe(variation);
    expect(withB.ledger.movements.listed.reduce((s: number, x: any) => s + x.amount, 0)).toBe(
      variation,
    );

    file = w.sessionsJson();
    expect(file.sessions[0]!.trips).toHaveLength(3);
    expect(file.sessions[0]!.trips[2]).toMatchObject({
      net_auec: F.net - FUEL,
      net_doubtful: true,
      unexplained_auec: FUEL,
      gross_margin_auec: F.gross,
      fees_auec: F.fees,
      planned_profit_auec: PLAYER_RUN.planned,
    });

    // The calibration keeps the two clean nets, counts the third out; its gross ratio and fee rate use all three.
    for (const g of withB.ledger.calibration.groups) {
      expect(g).toMatchObject({ n: 3, net_n: 2, net_excluded: 1, fee_n: 3, confidence: "low" });
      expect(g.net_ratio).toBeCloseTo(netRatio, 3); // not poisoned by the fuel
      expect(g.gross_ratio).toBeCloseTo(grossRatio, 3);
      expect(g.fee_rate).toBeCloseTo(feeRate, 3);
    }

    // The session total is a raw measure: it holds the fuel (the trip itself carries the flag).
    const cur = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(cur.session.money.net_auec).toBe(2 * F.net + (F.net - FUEL));
    expect(cur.session.money.balance_change_auec).toBe(variation);
    // The efficiency against the plans compares the runs that are the runs' own, as the calibration does: the third run's
    // net holds the fuel and is left out (it used to count against its plan: -357 000 over 180 000).
    expect(cur.session.money.plan).toMatchObject({
      planned_auec: 2 * PLAYER_RUN.planned,
      measured_auec: 2 * F.net,
      trips: 2,
    });
    expect(cur.session.money.plan.efficiency).toBeCloseTo(
      (2 * F.net) / (2 * PLAYER_RUN.planned),
      3,
    );
    // The same across sessions.
    const all = (await w.call("sc_session_stats", { include_balance: true })).data;
    expect(all.money.plan).toMatchObject({ trips: 2 });
    expect(all.money.plan.efficiency).toBeCloseTo(F.net / PLAYER_RUN.planned, 3);

    without = await sweepWithoutBalance(w);
    expectAbsent(
      without.all,
      [...MONEY, FUEL, GIFT, F.net - FUEL],
      "the answers without the balance (third run)",
    );
    expectPresent(await sweepWithBalance(w), [FUEL, F.net - FUEL], "the answers with the balance");
  });
});
