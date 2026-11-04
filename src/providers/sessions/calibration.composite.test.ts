import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCalibration } from "./calibration.js";
import { NOW, session } from "./fixtures.testing.js";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { CompositeTripSource, type TripCollection, type TripSource } from "./trips.js";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import type { Trip, TripInput } from "./types.js";

/**
 * Feature: the server builds its trips through a composite source, so the distance of each candidate run to the plan must
 * cross it (otherwise every distance reads 0 and the oldest run wins), and the calibration says what it cannot show.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-comp-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const candidate = (id: number, end: number): TripInput => ({
  key: `00000000000000${id.toString(16).padStart(2, "0")}`,
  kind: "trade",
  source: "trade_journal",
  started_at: new Date(end - 8 * MIN).toISOString(),
  ended_at: new Date(end).toISOString(),
  commodity: null,
  label: null,
  scu: 100,
  gross_margin_auec: 2500,
  net_auec: 2400,
  revenue_auec: 12_500,
  fees_auec: 100,
  fees_method: "mesure",
  planned_profit_auec: 3000,
  plan_link: "prices",
});

describe("Feature: the closest candidate takes the plan through the composite source", () => {
  it("Given two candidate runs in one tick from the trade source, Then the closer takes the plan even when it is the later one", async () => {
    const clock = { t: T0 };
    const trade: TripSource = {
      collect: async (): Promise<TripCollection> => ({
        trips: [candidate(1, T0 + 3 * MIN), candidate(2, T0 + 5 * MIN)],
        context: null,
        plan_distance: { [candidate(1, 0).key]: 0.4, [candidate(2, 0).key]: 0.05 },
      }),
    };
    const contracts: TripSource = {
      collect: async (): Promise<TripCollection> => ({ trips: [], context: null }),
    };
    const broken: TripSource = {
      collect: async () => {
        throw new Error("boom");
      },
    };
    const composite = new CompositeTripSource([contracts, trade, broken]);
    const merged = await composite.collect(T0);
    expect(merged.plan_distance).toEqual({
      [candidate(1, 0).key]: 0.4,
      [candidate(2, 0).key]: 0.05,
    });
    const telemetry: Telemetry = {
      enabled: true,
      status: async () => ({ state: "live" }) as TelemetryStatusReport,
      snapshot: async () =>
        ({ state: { pilot: { uec_balance: 5_000_000 } } }) as unknown as TelemetrySnapshot,
      events: async () => ({ events: [], last_seq: 0 }),
      resetUecDelta: async () => undefined,
      stop: async () => undefined,
    };
    const store = new SessionStore(file, { now: () => clock.t });
    const manager = new SessionManager({
      telemetry,
      store,
      config: { enabled: true, file, gapMs: 3 * 60 * MIN },
      gameHint: async () => ({ running: true, telemetryRegistered: true }),
      trips: composite,
      now: () => clock.t,
      newId: () => `s_comp_${clock.t}`,
    });
    manager.setPlan({
      commodity: "Laranite",
      scu: 100,
      expected_profit_auec: 3000,
      buy_unit_price: 100,
      sell_unit_price: 130,
    });
    for (let i = 0; i < 8; i++) {
      clock.t += MIN;
      await manager.tick();
    }
    const [a, b] = (await store.read()).sessions[0].trips;
    expect(a.planned_profit_auec).toBeNull();
    expect(b).toMatchObject({
      planned_profit_auec: 3000,
      plan_link: "prices",
      commodity: "Laranite",
    });
  });
});

describe("Feature: the confidence cap by the price link is flagged for the View", () => {
  it("Given eight steady runs tied by prices, Then the group says the cap was applied; fewer runs do not", () => {
    const DAY = 86_400_000;
    const mk = (i: number): Trip => ({
      key: `ad${i.toString(16).padStart(8, "0")}`,
      kind: "trade",
      source: "trade_journal",
      started_at: new Date(NOW - (i + 1) * DAY - 600_000).toISOString(),
      ended_at: new Date(NOW - (i + 1) * DAY).toISOString(),
      label: null,
      commodity: "Laranite",
      buy_terminal: null,
      sell_terminal: null,
      scu: 100,
      cost_auec: 200_000,
      revenue_auec: 280_000,
      fees_auec: 4_000,
      gross_margin_auec: 80_000,
      net_auec: 76_000,
      net_kind: "balance_delta",
      planned_profit_auec: 100_000,
      planned_scu: 100,
      plan_buy_terminal: null,
      plan_sell_terminal: null,
      plan_link: "prices",
      unexplained_auec: null,
      net_doubtful: null,
      fees_method: "mesure",
    });
    const groupOf = (n: number) =>
      buildCalibration(
        [session(1, { trips: Array.from({ length: n }, (_, i) => mk(i)), game_version: "4.10.1" })],
        { nowMs: NOW, gameVersion: "4.10.1" },
      ).groups[0]!;
    expect(groupOf(8)).toMatchObject({ confidence: "medium", confidence_capped: true });
    expect(groupOf(5)).toMatchObject({ confidence: "medium", confidence_capped: false });
  });
});
