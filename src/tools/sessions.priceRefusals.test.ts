import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { SessionManager } from "../providers/sessions/manager.js";
import { SessionStore } from "../providers/sessions/store.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../providers/telemetry/service.js";
import { allTools, createRegistry } from "./registry.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The session tools report the transactions the game refused because the price moved, as a count, without the balance
 * (it is not an aUEC figure). A fake telemetry, a fake clock, a temporary folder: no game, no network.
 */

const unused = { defaults: {}, get: async () => ({ data: {} }) } as unknown as HttpClient;
const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
const BALANCE = 777_123;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-tools-refusal-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function rig() {
  const clock = { t: T0 };
  const file = path.join(dir, "sessions.json");
  const refusals: { at: string; side: "buy"; kind: "commodity"; confidence: "confirmed" }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    status: async () => ({ state: "live" }) as TelemetryStatusReport,
    snapshot: async () =>
      ({ state: { pilot: { uec_balance: BALANCE } } }) as unknown as TelemetrySnapshot,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
  const manager = new SessionManager({
    telemetry,
    store: new SessionStore(file, { now: () => clock.t }),
    config: { enabled: true, file, gapMs: 3 * 60 * MIN },
    gameHint: async () => ({ running: true, telemetryRegistered: true }),
    now: () => clock.t,
    trips: {
      collect: async () => ({ trips: [], context: null, price_refusals: [...refusals] }),
    },
  });
  const registry = createRegistry(
    allTools(
      {
        uexClient: unused,
        scwClient: unused,
        sctClient: unused,
        scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
        gameLog: new GameLog({}),
        fleet: new FleetStore("unused.json"),
        telemetry,
        sessions: manager,
      },
      [],
    ),
  );
  const play = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      clock.t += MIN;
      await manager.tick();
    }
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await registry.call(name, args);
    return { text: r.content[0].text as string, data: JSON.parse(r.content[0].text).data };
  };
  return { play, call, refusals, clock };
}

describe("Feature: the session tools report price refusals", () => {
  it("Given two refusals during the session, Then current, list and stats give the count without the balance", async () => {
    const t = rig();
    await t.play(2);
    for (const minutes of [3, 5]) {
      t.refusals.push({
        at: new Date(T0 + minutes * MIN).toISOString(),
        side: "buy",
        kind: "commodity",
        confidence: "confirmed",
      });
    }
    await t.play(10);

    const current = await t.call("sc_session_current");
    expect(current.data.session.price_refusals).toBe(2);
    expect(current.data.session.money).toBe("withheld");

    const list = await t.call("sc_session_list");
    expect(list.data.sessions[0].price_refusals).toBe(2);

    const stats = await t.call("sc_session_stats");
    expect(stats.data.price_refusals).toBe(2);
    expect(stats.data.per_session[0].price_refusals).toBe(2);
    expect(stats.data.money).toBe("withheld");

    for (const r of [current, list, stats]) expect(r.text).not.toContain(String(BALANCE));
  });

  it("Given no refusal, Then the count is 0, not absent", async () => {
    const t = rig();
    await t.play(5);
    expect((await t.call("sc_session_stats")).data.price_refusals).toBe(0);
  });
});
