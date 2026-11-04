import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import { SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import type { TripCollection } from "./trips.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The refusals the trade journal lists reach the saved session through the manager, once each, and show in the summary
 * that sc_session_stats and the debrief read. A fake telemetry, a fake clock, a temporary folder: no game, no network.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-refusal-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rig() {
  const clock = { t: T0 };
  const refusals: {
    at: string;
    side: "buy" | "sell";
    kind: "commodity" | "item";
    confidence: "confirmed";
  }[] = [];
  const telemetry = {
    enabled: true,
    status: async () => ({ state: "live" }) as TelemetryStatusReport,
    snapshot: async () =>
      ({ state: { pilot: { uec_balance: 5000 } } }) as unknown as TelemetrySnapshot,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  } as Telemetry;
  const store = new SessionStore(file, { now: () => clock.t });
  const manager = new SessionManager({
    telemetry,
    store,
    config: { enabled: true, file, gapMs: 3 * 3_600_000 },
    gameHint: async () => ({ running: true, telemetryRegistered: true }),
    connection: {
      current: async () => ({ state: "unknown", since: null, code: null, reason: null }),
    },
    trips: {
      collect: async (): Promise<TripCollection> => ({
        trips: [],
        context: null,
        price_refusals: [...refusals],
      }),
    },
    now: () => clock.t,
    newId: () => `s_ref_${clock.t}`,
  });
  return { clock, refusals, manager, store };
}

describe("Feature: price refusals reach the saved session", () => {
  it("Given a refusal in the journal seen on several ticks, Then the session counts it once and the summary says so", async () => {
    const r = rig();
    await r.manager.tick();
    r.clock.t += MIN;
    r.refusals.push({
      at: new Date(r.clock.t).toISOString(),
      side: "buy",
      kind: "commodity",
      confidence: "confirmed",
    });
    for (let i = 0; i < 3; i++) {
      r.clock.t += MIN;
      await r.manager.tick();
    }
    const sessions = (await new SessionStore(file).read()).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.price_refusals).toBe(1);
    const bar = await r.manager.bar(false);
    expect(bar.current?.price_refusals).toBe(1);
    expect(bar.current?.money).toBe("withheld");
  });

  it("Given no refusal, Then the session says 0", async () => {
    const r = rig();
    await r.manager.tick();
    r.clock.t += MIN;
    await r.manager.tick();
    expect((await new SessionStore(file).read()).sessions[0]!.price_refusals).toBe(0);
  });
});
