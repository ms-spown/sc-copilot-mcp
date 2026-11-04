import { describe, expect, it, vi } from "vitest";
import { sweepWithoutBalance } from "../testing/replay/audit.js";
import { sellLine } from "../testing/replay/lines.js";
import { PLAYER_RUN, scheduleRun } from "../testing/replay/scripts.js";
import { F, useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: a run that GROWS while the server is down. The restarted server re-reads the log and sees the run with its
 * new line, but the balance history that measured the run is gone (memory only). What was measured is kept, and the
 * trip says it no longer covers the whole run.
 */

const rig = useWorld();

describe("Feature: a run that grows after a restart", () => {
  const LATE = { at: 450, amount: 8_000, scu: 20, fee: 700 };

  it("Scenario: the measured net and fees are kept, tagged as measured before, and the net is flagged doubtful", async () => {
    const w = await rig.start();
    scheduleRun(w, 20);
    // The late sale happens while the server is down: its balance change is never seen.
    w.at(LATE.at).log(sellLine(w.ms(LATE.at), LATE.amount, LATE.scu));
    w.at(LATE.at + 0.8).change(LATE.amount - LATE.fee);
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(140);
    const before = w.sessionsJson().sessions[0]!.trips[0]!;
    expect(before).toMatchObject({ net_auec: F.net, fees_auec: F.fees, net_doubtful: false });
    expect(before.figures_from_before).toBeFalsy();

    await w.crash();
    await w.playDownTo(500);
    await w.restart();
    await w.playTo(530);

    const trips = w.sessionsJson().sessions[0]!.trips;
    expect(trips).toHaveLength(1);
    const t = trips[0]!;
    expect(t.key).toBe(before.key);
    // The run grew: the turnover is the log's, and so is the scu.
    expect(t).toMatchObject({
      revenue_auec: F.turnover + LATE.amount,
      scu: F.scu + LATE.scu,
      gross_margin_auec: F.gross,
    });
    // What was measured is kept (the server cannot measure it again) ...
    expect(t).toMatchObject({
      net_auec: F.net,
      net_kind: "balance_delta",
      fees_auec: F.fees,
      fees_method: "mesure",
      unexplained_auec: 0,
    });
    // ... and says it does not cover the run's last line: tagged, and the net is not the run's own any more.
    expect(t.figures_from_before).toBe(true);
    expect(t.net_doubtful).toBe(true);
    expect(t.planned_profit_auec).toBe(PLAYER_RUN.planned);

    // The session still counts that net (a raw measure); the plan comparison and the calibration leave it out.
    const cur = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(cur.session.money.net_auec).toBe(F.net);
    expect(cur.session.money.plan).toBeNull();
    // Without the balance the tag is not there.
    const without = await sweepWithoutBalance(w);
    expect(without.tools).not.toContain('figures_from_before": true');
    expect(without.tools).not.toMatch(/"figures_from_before":\s*true/);
  });
});
