import type { BalancePolicy } from "../core/balance.js";
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
import { HIDDEN_MODES } from "../testing/balanceModes.js";
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
/** The managers of the test: a tool call starts a look at the file in the background (see afterEach). */
const managers: SessionManager[] = [];
afterEach(async () => {
  // A look started by a call may still be reading or writing the file when the test ends, depending on the load:
  // close() waits for it, only then is the folder removed.
  await Promise.all(managers.splice(0).map((m) => m.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(balance?: BalancePolicy) {
  const clock = { t: T0 };
  const file = path.join(dir, "sessions.json");
  const refusals: {
    at: string;
    side: "buy";
    kind: "commodity";
    confidence: "confirmed";
    superseded: boolean;
  }[] = [];
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
  managers.push(manager);
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
        ...(balance ? { balance } : {}),
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
  it.each(HIDDEN_MODES)(
    "Given two refusals during the session and $label, Then current, list and stats give the count without the balance",
    async (mode) => {
      const t = rig(mode.policy);
      await t.play(2);
      for (const minutes of [3, 5]) {
        t.refusals.push({
          at: new Date(T0 + minutes * MIN).toISOString(),
          side: "buy",
          kind: "commodity",
          confidence: "confirmed",
          superseded: false,
        });
      }
      await t.play(10);

      const current = await t.call("sc_session_current", mode.args);
      expect(current.data.session.price_refusals).toBe(2);
      expect(current.data.session.money).toBe("withheld");

      const list = await t.call("sc_session_list", mode.args);
      expect(list.data.sessions[0].price_refusals).toBe(2);

      const stats = await t.call("sc_session_stats", mode.args);
      expect(stats.data.price_refusals).toBe(2);
      expect(stats.data.per_session[0].price_refusals).toBe(2);
      expect(stats.data.money).toBe("withheld");

      for (const r of [current, list, stats]) expect(r.text).not.toContain(String(BALANCE));
    },
  );

  it("Given two refusals and the default (amounts shown), Then the count is there too and the money is not 'withheld'", async () => {
    const t = rig();
    await t.play(2);
    t.refusals.push({
      at: new Date(T0 + 3 * MIN).toISOString(),
      side: "buy",
      kind: "commodity",
      confidence: "confirmed",
      superseded: false,
    });
    await t.play(10);
    const current = await t.call("sc_session_current");
    expect(current.data.session.price_refusals).toBe(1);
    expect(current.data.session.money).not.toBe("withheld");
  });

  it("Given no refusal, Then the count is 0, not absent", async () => {
    const t = rig();
    await t.play(5);
    expect((await t.call("sc_session_stats")).data.price_refusals).toBe(0);
  });
});
