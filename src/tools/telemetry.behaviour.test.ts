import fs from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { createProbes } from "../providers/probes.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { createTelemetry, type Telemetry } from "../providers/telemetry/index.js";
import {
  actorField,
  frame,
  vehicleField,
  weaponsField,
} from "../providers/telemetry/testing/encode.js";
import { startFakeGame, type FakeGame } from "../providers/telemetry/testing/fakeServer.js";
import { createMcpServer } from "../server.js";
import { allTools, createRegistry, type ToolClients } from "./registry.js";

const empty = {
  defaults: { baseURL: "https://unused.test" },
  get: async () => ({ data: {} }),
} as unknown as HttpClient;

function clients(telemetry?: Telemetry, gameLog = new GameLog({})): ToolClients {
  return {
    uexClient: empty,
    scwClient: empty,
    sctClient: empty,
    scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
    gameLog,
    fleet: new FleetStore("unused-fleet.json"),
    ...(telemetry ? { telemetry } : {}),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function connect(c: ToolClients) {
  const registry = createRegistry(allTools(c, createProbes(c)), {});
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([createMcpServer(registry).connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { text, json, isError: r.isError === true };
  };
  return { client, call };
}

async function liveWorld() {
  const game: FakeGame = await startFakeGame();
  cleanup.push(() => game.close());
  const telemetry = createTelemetry({
    enabled: true,
    options: {
      endpointForTests: { host: "127.0.0.1", port: game.port },
      reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
    },
  });
  cleanup.push(() => telemetry.stop());
  const world = await connect(clients(telemetry));
  const state = async () => (await world.call("sc_live_status")).json.data.state as string;
  const untilConnected = () => waitFor(async () => (await state()) === "connected", "connected");
  const untilLive = () => waitFor(async () => (await state()) === "live", "live");
  return { game, telemetry, ...world, untilConnected, untilLive };
}

describe("Feature: live telemetry is off by default", () => {
  describe("Scenario: SC_TELEMETRY is not on", () => {
    it("Given telemetry off, When the tools are listed, Then only sc_live_status is advertised", async () => {
      const { client } = await connect(clients(createTelemetry({ enabled: false })));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("sc_live_status");
      expect(names).not.toContain("sc_live_state");
      expect(names).not.toContain("sc_live_events");
    });

    it("Given telemetry off, When sc_live_status is called, Then it says off and how to enable it, and nothing connects", async () => {
      const connectSpy = vi.spyOn(http2, "connect");
      const { call } = await connect(clients(createTelemetry({ enabled: false })));
      const { json } = await call("sc_live_status");
      expect(json.data).toMatchObject({ state: "off", enabled: false });
      expect(JSON.stringify(json.data.how_to_enable)).toContain("SC_TELEMETRY=on");
      expect(JSON.stringify(json.data.how_to_enable)).toContain("docs/TELEMETRY.md");
      expect(json.provenance).toMatchObject({ kind: "local_telemetry", trust: "structured" });
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it("Given no telemetry object at all, Then sc_live_status still answers off", async () => {
      const { call } = await connect(clients());
      expect((await call("sc_live_status")).json.data.state).toBe("off");
    });

    it("Given telemetry off, When sc_live_state is called by name, Then it refuses and reads nothing", async () => {
      const connectSpy = vi.spyOn(http2, "connect");
      const { call } = await connect(clients(createTelemetry({ enabled: false })));
      const state = await call("sc_live_state");
      expect(state.isError).toBe(true);
      expect(state.text).toMatch(/switched off/);
      expect((await call("sc_live_events")).isError).toBe(true);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it("Given telemetry off, When sc_data_status runs, Then the telemetry source is not_configured and nothing connects", async () => {
      const connectSpy = vi.spyOn(http2, "connect");
      const { call } = await connect(clients(createTelemetry({ enabled: false })));
      const { json } = await call("sc_data_status");
      const source = json.data.sources.find((s: { id: string }) => s.id === "live-telemetry");
      expect(source).toMatchObject({ status: "not_configured", state: "off" });
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});

describe("Feature: reading the live game through the tools", () => {
  describe("Scenario: telemetry on, game not running", () => {
    it("Given nothing answers, Then sc_live_status says waiting with how to enable, and sc_live_state has no frame", async () => {
      const game = await startFakeGame();
      const port = game.port;
      await game.close();
      const telemetry = createTelemetry({
        enabled: true,
        options: {
          endpointForTests: { host: "127.0.0.1", port },
          reader: { retryMs: [20], connectTimeoutMs: 300 },
        },
      });
      cleanup.push(() => telemetry.stop());
      const { call, client } = await connect(clients(telemetry));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("sc_live_state");
      const status = await call("sc_live_status");
      expect(status.json.data.state).toBe("waiting");
      expect(status.json.data.how_to_enable).toBeDefined();
      const state = await call("sc_live_state");
      expect(state.json.data.available).toBe(false);
    });
  });

  describe("Scenario: the game is live", () => {
    it("Given frames, When sc_live_state is called, Then values come with their age and limits, WITHOUT the balance", async () => {
      const { game, call, untilConnected, untilLive } = await liveWorld();
      await untilConnected();
      game.send(
        frame(
          vehicleField({
            name: "DRAK_Cutter_1",
            speed: 180,
            altitude: 2000,
            heading: 45,
            lights: { shld: "nominal" },
          }),
          actorField({ health: 90, uec: 987654321, locomotion: 3 }),
          weaponsField({ decoy: 8 }),
        ),
      );
      await untilLive();
      const { json, text } = await call("sc_live_state");
      expect(json.data.stream.state).toBe("live");
      expect(json.data.stream.frame_age_ms).toBeGreaterThanOrEqual(0);
      expect(json.data.ship.instruments.speed_ms).toBeCloseTo(180);
      expect(json.data.ship.manufacturer_derived).toBe("Drake");
      expect(json.data.pilot.health.percent).toBeCloseTo(0.9);
      expect(json.data.weapons.countermeasures).toEqual({ decoy: 8 });
      expect(json.data.limits.join(" ")).toMatch(/position/);
      expect(json.provenance).toMatchObject({ kind: "local_telemetry" });
      expect(text).not.toContain("987654321");
      expect(json.data.uec_balance).toMatch(/withheld/);
    });

    it("Given include_balance true, Then the balance and the session delta appear", async () => {
      const { game, call, untilConnected, untilLive } = await liveWorld();
      await untilConnected();
      game.send(frame(actorField({ uec: 5000, health: 100 })));
      await untilLive();
      game.send(frame(actorField({ uec: 4000, health: 100 })));
      await waitFor(
        async () =>
          (await call("sc_live_state", { include_balance: true })).json.data?.uec_session
            ?.current === 4000,
        "delta",
      );
      const { json } = await call("sc_live_state", { include_balance: true });
      expect(json.data.pilot.uec_balance).toBe(4000);
      expect(json.data.uec_session).toMatchObject({ start: 5000, delta: -1000 });
    });

    it("Given a pilot on foot, Then the ship section is listed as not available, not empty or zero", async () => {
      const { game, call, untilConnected, untilLive } = await liveWorld();
      await untilConnected();
      game.send(frame(actorField({ health: 50, locomotion: 1 })));
      await untilLive();
      const { json } = await call("sc_live_state");
      expect(json.data.ship).toBeUndefined();
      expect(json.data.not_available.join(" ")).toMatch(/ship/);
    });

    it("Given sections=[pilot], Then only the pilot is returned", async () => {
      const { game, call, untilConnected, untilLive } = await liveWorld();
      await untilConnected();
      game.send(frame(vehicleField({ altitude: 10 }), actorField({ health: 50 })));
      await untilLive();
      const { json } = await call("sc_live_state", { sections: ["pilot"] });
      expect(json.data.pilot).toBeDefined();
      expect(json.data.ship).toBeUndefined();
    });

    it("Given an unverified event, Then sc_live_events labels it, can hide it, and pages with after_seq", async () => {
      const { game, call, untilConnected } = await liveWorld();
      await untilConnected();
      game.send(frame(actorField({ intoxication: 0, uec: 100 })));
      await new Promise((r) => setTimeout(r, 30));
      game.send(frame(actorField({ intoxication: 3, uec: 100 })));
      await waitFor(
        async () => (await call("sc_live_events")).json.data.events.length > 0,
        "event",
      );
      const all = (await call("sc_live_events")).json.data;
      expect(all.events[0]).toMatchObject({ type: "intoxicated", confidence: "unverified" });
      const confirmed = (await call("sc_live_events", { confidence: "confirmed" })).json.data;
      expect(confirmed.events).toEqual([]);
      const after = (await call("sc_live_events", { after_seq: all.last_seq })).json.data;
      expect(after.events).toEqual([]);
    });

    it("Given sc_data_status, Then it reports the telemetry source without starting the reader", async () => {
      const game = await startFakeGame();
      cleanup.push(() => game.close());
      const telemetry = createTelemetry({
        enabled: true,
        options: {
          endpointForTests: { host: "127.0.0.1", port: game.port },
          reader: { retryMs: [20] },
        },
      });
      cleanup.push(() => telemetry.stop());
      const { call } = await connect(clients(telemetry));
      const { json } = await call("sc_data_status");
      const source = json.data.sources.find((s: { id: string }) => s.id === "live-telemetry");
      expect(source.status).toBe("ok");
      expect(game.connections()).toBe(0);
    });
  });

  describe("Scenario: the game version comes from Game.log when it is configured", () => {
    it("Given a readable log, Then the tool still answers and the provenance has a channel", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-telemetry-log-"));
      const log = path.join(dir, "Game.log");
      fs.writeFileSync(log, "<2026-11-03T10:00:00.000Z> Log started\n");
      cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
      const telemetry = createTelemetry({ enabled: true });
      cleanup.push(() => telemetry.stop());
      const { call } = await connect(clients(telemetry, new GameLog({ logPath: log })));
      const { json } = await call("sc_live_status");
      expect(["live", "ptu", "unknown"]).toContain(json.provenance.channel);
    });
  });
});
