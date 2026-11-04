import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import type { TripCollection } from "./trips.js";
import type { TripInput } from "./types.js";

/**
 * Feature: the manager keeps what a plan said on the ONE run it marked, and hands the calibration only to a caller that
 * was allowed the balance. A fake telemetry, a fake clock and a temporary folder: no game, no network, no real log.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
/** A ratio that appears nowhere by chance: 73 700 realised over 100 000 planned. */
const RATIO = "0.737";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-calmgr-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rig() {
  const clock = { t: T0 };
  const state = { balance: 5_000_000 };
  const trips = { list: [] as TripInput[] };
  const telemetry: Telemetry = {
    enabled: true,
    status: async () => ({ state: "live" }) as TelemetryStatusReport,
    snapshot: async () =>
      ({ state: { pilot: { uec_balance: state.balance } } }) as unknown as TelemetrySnapshot,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
  const store = new SessionStore(file, { now: () => clock.t });
  let n = 0;
  const manager = new SessionManager({
    telemetry,
    store,
    config: { enabled: true, file, gapMs: 3 * HOUR },
    gameHint: async () => ({ running: true, telemetryRegistered: true }),
    trips: {
      collect: async (): Promise<TripCollection> => ({ trips: trips.list, context: null }),
    },
    now: () => clock.t,
    newId: () => `s_cal_${++n}_${clock.t}`,
  });
  const play = async (minutes: number) => {
    for (let m = 0; m < minutes; m++) {
      clock.t += MIN;
      await manager.tick();
    }
  };
  return { clock, trips, manager, store, play };
}

const PLAN = {
  commodity: "Laranite",
  scu: 100,
  expected_profit_auec: 100_000,
  buy_unit_price: 189,
  sell_unit_price: 457,
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
};

const run = (id: number, endMs: number, gross: number): TripInput => ({
  key: `00000000000000${id.toString(16).padStart(2, "0")}`,
  kind: "trade",
  source: "trade_journal",
  started_at: new Date(endMs - 8 * MIN).toISOString(),
  ended_at: new Date(endMs).toISOString(),
  commodity: "Laranite",
  scu: 100,
  cost_auec: 18_900,
  revenue_auec: 18_900 + gross,
  fees_auec: 1_000,
  fees_method: "mesure",
  gross_margin_auec: gross,
  net_auec: gross - 1_000,
  net_kind: "balance_delta",
});

/** Two plans applied one after the other, each followed by its run: the way the calibration gets its two runs. */
async function twoPlannedRuns(r: ReturnType<typeof rig>) {
  r.manager.setPlan(PLAN);
  r.trips.list = [run(1, r.clock.t + 3 * MIN, 73_700)];
  await r.play(5);
  r.manager.setPlan(PLAN);
  r.trips.list = [...r.trips.list, run(2, r.clock.t + 3 * MIN, 73_700)];
  await r.play(5);
}

describe("Feature: what the plan said is kept on the one run it marked", () => {
  it("Given a plan and two runs of the same goods, Then only the first run carries the profit, the quantity and the terminals", async () => {
    const r = rig();
    r.manager.setPlan(PLAN);
    r.trips.list = [run(1, T0 + 3 * MIN, 73_700), run(2, T0 + 5 * MIN, 73_700)];
    await r.play(8);
    const [s] = (await r.store.read()).sessions;
    const [a, b] = s.trips;
    expect(a).toMatchObject({
      planned_profit_auec: 100_000,
      planned_scu: 100,
      plan_buy_terminal: "Port Tressler",
      plan_sell_terminal: "Area18 TDD",
    });
    expect(b.planned_profit_auec).toBeNull();
    expect(b.planned_scu).toBeNull();
    expect(b.plan_buy_terminal).toBeNull();
    expect(b.plan_sell_terminal).toBeNull();
  });

  it("Given no plan, Then no trip carries any of it", async () => {
    const r = rig();
    r.trips.list = [run(1, T0 + 3 * MIN, 73_700)];
    await r.play(5);
    const [t] = (await r.store.read()).sessions[0].trips;
    expect([
      t.planned_profit_auec,
      t.planned_scu,
      t.plan_buy_terminal,
      t.plan_sell_terminal,
    ]).toEqual([null, null, null, null]);
  });
});

describe("Feature: route reliability follows the balance, in the tool and in the poll", () => {
  it("Given two planned runs, When the balance is allowed, Then sc_session_stats data holds the group with its number of runs", async () => {
    const r = rig();
    await twoPlannedRuns(r);
    const stats = await r.manager.stats(undefined, true);
    const rr = stats.route_reliability;
    if (rr === "withheld") throw new Error("withheld");
    const g = rr.groups.find((x) => x.kind === "commodity")!;
    expect(g).toMatchObject({ commodity: "Laranite", n: 2, confidence: "low" });
    expect(String(g.gross_ratio)).toBe(RATIO);
    expect(rr.groups.some((x) => x.kind === "route" && x.n === 2)).toBe(true);
    expect(rr.note).toMatch(/ESTIMATE/);
  });

  it("Given the balance is not allowed, Then no ratio, rate or run count of the calibration is anywhere in the answers", async () => {
    const r = rig();
    await twoPlannedRuns(r);
    const stats = await r.manager.stats(undefined, false);
    expect(stats.route_reliability).toBe("withheld");
    const bar = await r.manager.bar(false);
    const session = await r.manager.session(undefined, false);
    const list = await r.manager.list(10, false);
    for (const out of [stats, bar, session, list]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(RATIO);
      expect(text).not.toContain("gross_ratio");
      expect(text).not.toContain("fee_rate");
      expect(text).not.toContain("73700");
    }
  });

  it("Given the poll asks for the section, Then it holds only groups with two runs or more, and is rebuilt when the file changes", async () => {
    const r = rig();
    r.manager.setPlan(PLAN);
    r.trips.list = [run(1, T0 + 3 * MIN, 73_700)];
    await r.play(5);
    expect((await r.manager.calibrationSection())!.groups).toEqual([]);
    r.manager.setPlan(PLAN);
    r.trips.list = [...r.trips.list, run(2, r.clock.t + 3 * MIN, 73_700)];
    await r.play(5);
    const section = (await r.manager.calibrationSection())!;
    expect(section.groups.map((g) => g.n)).toEqual([2, 2]);
    expect(section).not.toHaveProperty("note");
    // asked twice without a change: the same answer
    expect(await r.manager.calibrationSection()).toEqual(section);
  });

  it("Given the manager is off, Then there is no section", async () => {
    const r = rig();
    await r.manager.close();
    expect(await r.manager.calibrationSection()).toBeUndefined();
  });
});
