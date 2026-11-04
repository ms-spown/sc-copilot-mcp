/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import { joinLines, kickLines } from "../testing/replay/lines.js";
import { PLAYER_RUN, scheduleRun } from "../testing/replay/scripts.js";
import { F, MONEY, newestRun, useWorld } from "../testing/replay/story.js";
import { QUANTUM } from "../testing/replay/world.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: a play session that is interrupted: the server link is cut, the server process dies, the telemetry goes quiet.
 * The state the dashboard shows must follow the game's own log at once, and what was saved must survive.
 */

const rig = useWorld();

describe("Feature: the player is disconnected, then rejoins, then the server crashes", () => {
  it("Scenario: the connection is shown at once, the session resumes, a restart keeps the session and marks the gap", async () => {
    const w = await rig.start();
    // The ship flies in quantum mode from the start: a condition the dashboard shows while the player is online.
    w.at(1).ship(QUANTUM);
    scheduleRun(w, 20);
    await w.playTo(10);
    await w.applyPlan();

    // ---- Online: the conditions are shown.
    await w.playTo(15);
    let p = await w.poll(false);
    expect(p.state).toBe("live");
    expect(p.connection).toMatchObject({ state: "online", code: null });
    expect(p.conditions.map((c: any) => c.id)).toContain("in_quantum"); // without this the "emptied" check below proves nothing

    // ---- The run, then the server cuts the player for inactivity (cause 30028) at second 150.
    await w.playTo(140);
    expect(w.sessionsJson().sessions[0]!.trips).toHaveLength(1);
    const before = w.sessionsJson().sessions[0]!;
    w.at(150).log(kickLines(w.ms(150)));
    await w.playTo(150);
    // The very next poll: the frames keep coming (the game repeats its last values), the log says otherwise.
    p = await w.poll(false);
    expect(p.state).toBe("live");
    expect(p.frame_age_ms).toBeLessThan(5_000);
    expect(p.connection).toMatchObject({
      state: "disconnected",
      code: 30028,
      reason: "Remote Disconnect - player inactive",
    });
    expect(p.conditions).toEqual([]);
    const state = (await w.call("sc_live_state")).data;
    expect(state.connection).toMatchObject({ state: "disconnected", code: 30028 });
    expect(state.connection.meaning).toMatch(/NOT current/);
    expect(state.connection).not.toHaveProperty("reason"); // the game's own text stays out of the model's reading
    expect(state.conditions).toEqual([]);
    const status = (await w.call("sc_live_status")).data;
    expect(status.connection.state).toBe("disconnected");
    // The handle the game writes on the same lines never comes out.
    expect(JSON.stringify([p, state, status])).not.toContain("FakePilotQrs");
    expectAbsent(
      (await sweepWithoutBalance(w)).all,
      MONEY,
      "the answers without the balance (disconnected)",
    );

    // The session did not end: the game process runs, the link to the server is what broke.
    await w.playTo(190);
    expect(w.sessionsJson().sessions).toHaveLength(1);
    expect(w.sessionsJson().sessions[0]!.ended_at).toBeNull();

    // ---- The player joins a server again: the conditions come back, the same session goes on.
    w.at(200).log(joinLines(w.ms(200)));
    await w.playTo(206);
    p = await w.poll(false);
    expect(p.connection).toMatchObject({ state: "online" });
    expect(p.conditions.map((c: any) => c.id)).toContain("in_quantum");
    const resumed = w.sessionsJson();
    expect(resumed.sessions).toHaveLength(1);
    expect(resumed.sessions[0]!.id).toBe(before.id);
    expect(resumed.sessions[0]!.interruptions).toEqual([]); // frames never stopped: nothing to mark
    expect(resumed.sessions[0]!.trips).toEqual(before.trips);

    // ---- The server process dies (no flush, no close) and the game goes on without it for 200 s.
    await w.playTo(300);
    const beforeCrash = w.sessionsJson().sessions[0]!;
    await w.crash();
    // A transfer the server does not see.
    w.at(400).change(50_000);
    await w.playDownTo(500);

    // ---- The server starts again on the same files.
    await w.restart();
    expect(w.manager.currentPlan).toBeUndefined(); // the plan was in memory only
    await w.playTo(520);
    const after = w.sessionsJson();
    expect(after.sessions).toHaveLength(1);
    const s = after.sessions[0]!;
    expect(s.id).toBe(before.id);
    expect(s.number).toBe(1);
    // The start balance is the one seen when the game began, not the balance at the restart.
    expect(s.start_balance).toBe(PLAYER_RUN.start);
    expect(s.start_balance_quality).toBe("game_start");
    expect(s.last_balance).toBe(PLAYER_RUN.end + 50_000);
    // The gap is marked, honestly: nothing says why the server was not looking.
    expect(s.interruptions).toHaveLength(1);
    expect(s.interruptions[0]).toMatchObject({ kind: "unclean" });
    expect(Date.parse(s.interruptions[0]!.from)).toBeGreaterThanOrEqual(
      Date.parse(beforeCrash.last_activity_at),
    );
    expect(
      Date.parse(s.interruptions[0]!.to) - Date.parse(s.interruptions[0]!.from),
    ).toBeGreaterThan(90_000);
    // The trip is still there, once, with what was measured while the server watched. The restarted server has no
    // balance history of that run any more; it must not replace a measured result by an unknown one.
    expect(s.trips).toHaveLength(1);
    expect(s.trips[0]).toMatchObject({
      key: before.trips[0]!.key,
      net_auec: F.net,
      fees_auec: F.fees,
      gross_margin_auec: F.gross,
      revenue_auec: F.turnover,
      cost_auec: F.cost,
      planned_profit_auec: PLAYER_RUN.planned,
      net_kind: "balance_delta",
      fees_method: "mesure",
    });
    // The tools say the same.
    const cur = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(cur.session.interruptions).toBe(1);
    expect(cur.session.money).toMatchObject({
      start_balance_auec: PLAYER_RUN.start,
      net_auec: F.net,
      last_balance_auec: PLAYER_RUN.end + 50_000,
    });
    expect(cur.interruptions).toEqual([expect.objectContaining({ kind: "unclean" })]);
    expectAbsent(
      (await sweepWithoutBalance(w)).all,
      [...MONEY, 50_000],
      "the answers without the balance (restarted)",
    );
    expectPresent(
      await sweepWithBalance(w),
      [PLAYER_RUN.start, F.net],
      "the answers with the balance",
    );
  });
});

describe("Feature: the telemetry goes quiet around a sale", () => {
  /**
   * The run of the player, with the stream cut for 20 s around the sales (the sales are written at +80 s and +82 s, the
   * stream is cut from +69 s to +89 s). Frames resume 1 s before the model reads the final balance (+90 s): were they to
   * resume later, the final balance would be unknown, not estimated. `hidden` is a balance change inside the cut that the
   * stream never showed (fuel bought, a transfer).
   */
  async function quietSale(opts: { hidden?: number; first?: boolean } = {}) {
    const w = await rig.start();
    const t0 = opts.first === false ? 1800 : 20;
    if (opts.first === false) scheduleRun(w, 20);
    scheduleRun(w, t0);
    w.at(t0 + 69).cut();
    if (opts.hidden) w.at(t0 + 85).change(opts.hidden);
    w.at(t0 + 89).resume();
    await w.playTo(10);
    await w.applyPlan();
    if (opts.first === false) {
      await w.playTo(1790, { dt: 30 });
      await w.applyPlan();
    }
    await w.playTo(t0 + 96);
    return { w, p: await w.poll(true) };
  }

  it("Scenario: the fees fall back to the deduced total, labelled as an estimate, and the movements say the stream was cut", async () => {
    const { w, p } = await quietSale();
    const m = newestRun(p).money;
    // The purchases were seen: measured. The sales were not: only the total can be deduced (margin minus net).
    expect(m.net).toMatchObject({ auec: F.net, method: "mesure" });
    expect(m.fees).toMatchObject({
      total: F.fees,
      method: "estime",
      buy: { auec: F.buyFee, method: "groupe" },
      sell: { auec: F.sellFee, method: "estime" }, // what is left of the total once the measured side is taken
      unexplained: null, // a first run has no earlier rate to compare with: unknown, not zero
    });
    // The plausible-fee guard passed: 0 <= 43 568 <= half of the turnover.
    expect(m.fees.total).toBeGreaterThanOrEqual(0);
    expect(m.fees.total).toBeLessThanOrEqual(F.turnover / 2);
    // The movements list cuts the same way: the sales sit in one change across the gap, honestly "stream_gap".
    const gap = p.ledger.movements.listed.filter((x: any) => x.reason === "stream_gap");
    expect(gap).toEqual([
      expect.objectContaining({
        category: "unexplained",
        confidence: "none",
        amount: F.turnover - F.sellFee,
      }),
    ]);
    expect(m.decomposition.parts.stream_gap).toBe(F.turnover - F.sellFee);
    expect(m.decomposition.closes).toBe(false);
    const parts = Object.values(m.decomposition.parts) as number[];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(F.net);
    expect(p.ledger.movements.coverage.gap_changes).toBe(1);
    // The session keeps the label: the fees of this trip were deduced.
    const trip = w.sessionsJson().sessions[0]!.trips[0]!;
    expect(trip).toMatchObject({ fees_auec: F.fees, fees_method: "estime", net_auec: F.net });
    expectAbsent((await sweepWithoutBalance(w)).all, MONEY, "the answers without the balance");
  });

  it.each([-400_000, 400_000])(
    "Scenario: a fee that cannot be one (more than half of the turnover, or below zero) is refused and the gap is shown as unexplained (hidden change %i)",
    async (hidden) => {
      {
        const { w, p } = await quietSale({ hidden });
        const m = newestRun(p).money;
        const net = F.net + hidden;
        expect(m.net).toMatchObject({ auec: net, method: "mesure" });
        // gross margin - net: 443 568 (more than half of the 318 072 sold) or -356 432 (negative): not a fee.
        expect(m.fees.total).toBeNull();
        expect(m.fees.method).toBeNull();
        expect(m.fees.reason).toBe("solde_autre_raison");
        expect(m.fees.unexplained).toBe(F.gross - net);
        expect(m.fees.buy).toEqual({ auec: F.buyFee, method: "groupe" }); // the measured side stays
        expect(m.fees.sell).toBeNull();
        expect(m.fees.rate).toBeNull();
        // The trip is stored with its net, flagged as not the run's own, and with no fees at all.
        const trip = w.sessionsJson().sessions[0]!.trips[0]!;
        expect(trip).toMatchObject({
          net_auec: net,
          fees_auec: null,
          fees_method: null,
          unexplained_auec: F.gross - net,
          net_doubtful: true,
        });
      }
    },
  );

  it("Scenario: a deduced fee that is plausible but far from the rate seen on the earlier run is shown as unexplained", async () => {
    // Run 1 is clean (rate = 43 568 / 318 072). Run 2 loses its sales in a gap and 20 000 of fuel were spent in it.
    const { w, p } = await quietSale({ hidden: -20_000, first: false });
    const m = newestRun(p).money;
    const rate = F.fees / F.turnover;
    expect(m.net).toMatchObject({ auec: F.net - 20_000, method: "mesure" });
    expect(m.fees).toMatchObject({ total: F.fees + 20_000, method: "estime" });
    // Compared with the earlier rate, 20 000 of the deduced "fees" are not fees.
    expect(m.fees.unexplained).toBe(Math.round(F.fees + 20_000 - rate * F.turnover));
    expect(m.fees.unexplained).toBe(20_000);
    const trips = w.sessionsJson().sessions[0]!.trips;
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ net_doubtful: false, fees_method: "mesure" });
    expect(trips[1]).toMatchObject({
      net_doubtful: true, // 20 000 is above 2 % of the turnover
      unexplained_auec: 20_000,
      fees_method: "estime",
    });
  });

  it("Scenario: fees deduced across a stream gap feed neither the next run's reference rate, nor the planned net, nor the calibration", async () => {
    // Two runs, each with its sales lost in a gap, the second with 20 000 of fuel hidden in it. The deduced "fees" of the
    // first may hold anything: they must not become the yardstick that the second is judged by.
    const w = await rig.start();
    const [t1, t2] = [20, 1800];
    scheduleRun(w, t1);
    scheduleRun(w, t2);
    for (const t0 of [t1, t2]) {
      w.at(t0 + 69).cut();
      w.at(t0 + 89).resume();
    }
    w.at(t2 + 85).change(-20_000);
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(t2 - 10, { dt: 30 });
    await w.playTo(t2 - 5);
    await w.applyPlan();
    await w.playTo(t2 + 96);
    const p = await w.poll(true);
    const m = newestRun(p).money;
    expect(m.fees).toMatchObject({ method: "estime", total: F.fees + 20_000 });
    // No reference rate: the first run's was deduced. Unknown, not computed against it.
    expect(m.fees.unexplained).toBeNull();
    expect(m.planned_net).toBeNull(); // the planned net needs a rate that was measured
    const trips = w.sessionsJson().sessions[0]!.trips;
    expect(trips.map((t) => t.fees_method)).toEqual(["estime", "estime"]);
    // The calibration has the two runs but no fee rate from them, and no net ratio (the nets cannot be told clean).
    for (const g of p.ledger.calibration.groups) {
      expect(g).toMatchObject({ n: 2, fee_n: 0, fee_rate: null, net_n: 0, net_ratio: null });
    }
    // The card names what the figure is.
    const stats = (await w.call("sc_session_stats", { include_balance: true })).data;
    expect(stats.route_reliability.groups[0]).toMatchObject({ fee_measured: 0, fee_n: 0 });
  });
});
