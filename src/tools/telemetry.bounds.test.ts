import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { createProbes } from "../providers/probes.js";
import { Scmdb } from "../providers/scmdb/store.js";
import type { TelemetryEvent } from "../providers/telemetry/events.js";
import { createTelemetry, type Telemetry } from "../providers/telemetry/index.js";
import type { TelemetryStatusReport } from "../providers/telemetry/service.js";
import { cat, lf, vf } from "../providers/telemetry/testing/encode.js";
import { startFakeGame } from "../providers/telemetry/testing/fakeServer.js";
import { createMcpServer } from "../server.js";
import { allTools, createRegistry, type ToolClients } from "./registry.js";
import { MAX_RESPONSE_CHARS } from "./telemetry.js";

/** The size of what sc_live_state and sc_live_events hand to the model (it goes into the conversation). */

const empty = {
  defaults: { baseURL: "https://unused.test" },
  get: async () => ({ data: {} }),
} as unknown as HttpClient;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

async function connect(telemetry: Telemetry) {
  const c: ToolClients = {
    uexClient: empty,
    scwClient: empty,
    sctClient: empty,
    scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
    gameLog: new GameLog({}),
    fleet: new FleetStore("unused-fleet.json"),
    telemetry,
  };
  const registry = createRegistry(allTools(c, createProbes(c)), {});
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([createMcpServer(registry).connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { text, json: JSON.parse(text) as { data: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

const status: TelemetryStatusReport = {
  state: "live",
  cause: "Frames are arriving.",
  last_frame_age_ms: 10,
  frames_received: 1,
  frames_rejected: 0,
  reconnects: 0,
  unknown_fields: [],
  anomalies: [],
  not_in_stream: [],
  idle_stop_ms: 1,
};

/** A telemetry object that returns whatever a (hypothetical) bug in the decoder would let through. */
function fake(parts: {
  weapons?: number;
  nameLength?: number;
  events?: TelemetryEvent[];
}): Telemetry {
  const weapons = Array.from({ length: parts.weapons ?? 0 }, (_, i) => ({
    name: `GUN_${i}`.padEnd(parts.nameLength ?? 0, "x"),
    powered: true,
    ready: true,
  }));
  return {
    enabled: true,
    status: async () => status,
    snapshot: async () => ({
      frame_age_ms: 5,
      received_at: new Date(0).toISOString(),
      state: {
        pilot: null,
        ship: null,
        weapons: { weapons, countermeasures: {} },
        game_events: [],
        broken: [],
        derived: {
          in_planet_frame: false,
          heading_valid: false,
          radar_valid: false,
          in_quantum_mode: false,
          in_jump: false,
          health_zero: false,
        },
        countermeasure_burst: {},
      },
    }),
    events: async () => ({ events: parts.events ?? [], last_seq: 9 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
}

describe("Feature: sc_live_state and sc_live_events answers stay small", () => {
  it("Given a state that somehow holds 100 000 weapons, Then 64 are shown and the answer says the list was cut", async () => {
    const call = await connect(fake({ weapons: 100_000 }));
    const { text, json } = await call("sc_live_state", { sections: ["weapons"] });
    expect(text.length).toBeLessThan(MAX_RESPONSE_CHARS);
    expect(json.data.weapons.weapons).toHaveLength(64);
    expect(json.data.weapons.truncated).toMatch(/cut to 64/);
  });

  it("Given 64 weapons whose entries are enormous, Then the list is halved until the answer fits the budget", async () => {
    const call = await connect(fake({ weapons: 64, nameLength: 2000 }));
    const { text, json } = await call("sc_live_state", { sections: ["weapons"] });
    expect(text.length).toBeLessThan(MAX_RESPONSE_CHARS + 4096); // the provenance envelope is added around it
    expect(json.data.weapons.weapons.length).toBeGreaterThan(0);
    expect(json.data.weapons.weapons.length).toBeLessThan(64);
    expect(json.data.weapons.truncated).toMatch(/cut to/);
  });

  it("Given a normal state, Then nothing is cut", async () => {
    const call = await connect(fake({ weapons: 64 }));
    const { json } = await call("sc_live_state");
    expect(json.data.weapons.weapons).toHaveLength(64);
    expect(json.data.weapons.truncated).toBeUndefined();
  });

  it("Given 100 events of 2 000 characters each, Then the newest are kept, the answer is under the limit and says so", async () => {
    const events: TelemetryEvent[] = Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1,
      type: "landed",
      group: "ship",
      confidence: "confirmed",
      at: new Date(0).toISOString(),
      text: "x".repeat(2000),
      data: {},
    }));
    const call = await connect(fake({ events }));
    const { text, json } = await call("sc_live_events", { limit: 100 });
    expect(text.length).toBeLessThan(MAX_RESPONSE_CHARS + 4096);
    expect(json.data.truncated).toMatch(/newest/);
    expect(json.data.events.at(-1).seq).toBe(100);
    expect(json.data.last_seq).toBe(9);
  });
});

describe("Feature: the original attack, end to end", () => {
  it("Given a fake game that sends 1 MiB of empty weapons and then 4 000 named ones, Then sc_live_state answers in a few kilobytes", async () => {
    const game = await startFakeGame();
    cleanup.push(() => game.close());
    const telemetry = createTelemetry({
      enabled: true,
      options: {
        endpointForTests: { host: "127.0.0.1", port: game.port },
        reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
      },
    });
    cleanup.push(() => telemetry.stop());
    const call = await connect(telemetry);
    const end = Date.now() + 3000;
    while ((await call("sc_live_status")).json.data.state !== "connected") {
      if (Date.now() > end) throw new Error("not connected");
      await new Promise((r) => setTimeout(r, 10));
    }
    const entry = Buffer.from([0x22, 0x00]);
    const body = Buffer.alloc(2 * 500_000);
    for (let i = 0; i < 500_000; i++) entry.copy(body, i * 2);
    const named = Array.from({ length: 4000 }, (_, i) => {
      const name = `GUN_${i}`;
      return lf(4, cat(Buffer.from([0x0a, name.length]), Buffer.from(name)), vf(2, true));
    });
    game.send(lf(4, body), lf(4, ...named));
    let answer = await call("sc_live_state", { sections: ["weapons"] });
    while (answer.json.data.weapons === undefined) {
      if (Date.now() > end) throw new Error("no weapons");
      await new Promise((r) => setTimeout(r, 10));
      answer = await call("sc_live_state", { sections: ["weapons"] });
    }
    expect(answer.json.data.weapons.weapons).toHaveLength(64);
    expect(answer.text.length).toBeLessThan(20_000);
  });
});
