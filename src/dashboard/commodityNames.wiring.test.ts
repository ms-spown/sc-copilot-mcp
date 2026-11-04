import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { GameLog } from "../providers/gamelog/reader.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import { dashboardTools } from "../tools/dashboard.js";
import { waitFor } from "../testing/waitFor.js";
import { commodityNamesSwitchedOff } from "./commodityNames.js";
import { LARANITE_GUID, tradeLines } from "./testing/tradeScenario.js";
import { transportLogText } from "./testing/ledgerScenario.js";

/**
 * The names of goods, wired through the dashboard tool: the wiki's commodity list is asked for in the background only
 * while telemetry is on and SC_COMMODITY_NAMES is not off. Negative checks are made after a positive sign that the poll
 * went all the way to the commerce section (never by waiting for something not to happen).
 */

let dir: string;
let base = 0;
beforeEach(() => {
  clearCache();
  configureDiskCache(null);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "commodity-names-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function telemetry(enabled: boolean): Telemetry {
  const state = {
    ship: null,
    weapons: null,
    pilot: { health: { current: 100, max: 100 }, unverified: {} },
    conditions: [],
    derived: {},
    game_events: [],
    broken: [],
    countermeasure_burst: {},
  };
  return {
    enabled,
    status: vi.fn(async () => ({
      state: enabled ? "live" : "off",
      cause: "test",
      frames_received: 10,
      frames_rejected: 0,
      reconnects: 0,
      unknown_fields: [],
      anomalies: [],
      not_in_stream: [],
      idle_stop_ms: 0,
    })),
    snapshot: vi.fn(async () => ({
      state,
      frame_age_ms: 20,
      received_at: new Date().toISOString(),
      uec_session: { start: 0, current: 0, delta: 0, since: new Date().toISOString() },
    })),
    events: vi.fn(async () => ({ events: [], last_seq: 0 })),
    resetUecDelta: vi.fn(async () => undefined),
    balanceHistory: vi.fn(async () => []),
    stop: vi.fn(async () => undefined),
  } as unknown as Telemetry;
}

function world(enabled: boolean, env: NodeJS.ProcessEnv = {}) {
  const start = Date.now() - 300_000;
  const file = path.join(dir, "Game.log");
  fs.writeFileSync(file, `${transportLogText(start)}\n${tradeLines(start).join("\n")}\n`);
  const get = vi.fn(async (url: string) => {
    if (url === "/commodities") {
      return {
        data: { data: [{ uuid: LARANITE_GUID, name: "Laranite" }], meta: { last_page: 1 } },
      };
    }
    throw new Error(`unexpected ${url}`);
  });
  const wiki = {
    defaults: { baseURL: `https://names${++base}.test` },
    get,
  } as unknown as HttpClient;
  const tools = dashboardTools(
    { telemetry: telemetry(enabled), scwClient: wiki, gameLog: new GameLog({ logPath: file }) },
    { env },
  );
  const poll = tools.find((t) => t.name === "sc_live_poll")!;
  const run = async () => {
    const r = await poll.handler({ include_balance: false });
    const sc = r.structuredContent as {
      ledger?: { trade?: { runs: { commodity_name?: string }[] } };
    };
    return sc.ledger?.trade?.runs[0];
  };
  const asked = () => get.mock.calls.filter((c) => c[0] === "/commodities").length;
  return { run, asked };
}

describe("Feature: SC_COMMODITY_NAMES", () => {
  it("Given only 'off', '0', 'false' or 'no' switch it off, Then no other value changes anything", () => {
    for (const v of ["off", "OFF", "0", "false", "No", " off "])
      expect(commodityNamesSwitchedOff({ SC_COMMODITY_NAMES: v }), v).toBe(true);
    for (const v of [undefined, "", "on", "1", "true", "yes", "maybe", "of"])
      expect(commodityNamesSwitchedOff({ SC_COMMODITY_NAMES: v }), String(v)).toBe(false);
  });
});

describe("Feature: the wiki is asked for the names of goods only when it should be", () => {
  it("Given telemetry on and the switch left alone, Then the run ends up named, after a request for the public list", async () => {
    const w = world(true);
    await waitFor(
      async () => (await w.run())?.commodity_name === "Laranite",
      "the goods are named",
    );
    expect(w.asked()).toBeGreaterThanOrEqual(1);
  });

  it("Given SC_COMMODITY_NAMES=off, Then the run is there, unnamed, and the wiki's list is never asked for", async () => {
    const w = world(true, { SC_COMMODITY_NAMES: "off" });
    let run: { commodity_name?: string } | undefined;
    await waitFor(async () => (run = await w.run()) !== undefined, "the commerce section is there");
    await w.run();
    expect(run!.commodity_name).toBeUndefined();
    expect(w.asked()).toBe(0);
  });

  it("Given telemetry off, Then the poll stops before the ledger and the wiki is never asked", async () => {
    const w = world(false);
    for (let i = 0; i < 3; i++) expect(await w.run()).toBeUndefined();
    expect(w.asked()).toBe(0);
  });
});
