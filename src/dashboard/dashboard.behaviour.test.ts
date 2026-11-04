import http2 from "node:http2";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { createProbes } from "../providers/probes.js";
import { NO_NETWORK } from "../providers/probes.testing.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { createTelemetry, type Telemetry } from "../providers/telemetry/index.js";
import { actorField, frame, vehicleField } from "../providers/telemetry/testing/encode.js";
import { startFakeGame } from "../providers/telemetry/testing/fakeServer.js";
import { createMcpServer } from "../server.js";
import {
  allResources,
  allTools,
  createRegistry,
  type Selection,
  type ToolClients,
} from "../tools/registry.js";
import { DASHBOARD_URI, UI_EXTENSION_ID, UI_MIME_TYPE } from "./constants.js";
import { waitFor } from "../testing/waitFor.js";
import type { BalancePolicy } from "../core/balance.js";
import { HIDDEN_MODES } from "../testing/balanceModes.js";

const empty = {
  defaults: { baseURL: "https://unused.test" },
  get: async () => ({ data: {} }),
} as unknown as HttpClient;

function clients(telemetry?: Telemetry, balance?: BalancePolicy): ToolClients {
  return {
    uexClient: empty,
    scwClient: empty,
    sctClient: empty,
    scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
    gameLog: new GameLog({}),
    fleet: new FleetStore("unused-fleet.json"),
    ...(telemetry ? { telemetry } : {}),
    ...(balance ? { balance } : {}),
  };
}

// Real loopback sockets: a loaded machine must not turn a slow connect into a failure (waitFor below waits up to 15 s).
vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const UI_CAPS = { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } };

/** A client that renders Views declares the UI extension at initialize, exactly as Claude Desktop does. */
async function connect(
  c: ToolClients,
  caps: Record<string, unknown> = {},
  selection: Selection = {},
) {
  const registry = createRegistry(allTools(c, createProbes(c, NO_NETWORK)), selection, {
    resources: allResources(c),
  });
  const server = createMcpServer(registry);
  const client = new Client({ name: "test", version: "1" }, { capabilities: caps } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return {
      r,
      text: (r.content as { text: string }[])[0]!.text,
      sc: r.structuredContent as Record<string, any> | undefined, // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  };
  return { client, names, call, registry };
}

const DASHBOARD_TOOLS = ["sc_live_dashboard", "sc_live_poll", "sc_live_mark", "sc_trade_suggest"];

const spyTelemetry = (enabled: boolean) => {
  const base = createTelemetry({ enabled: false });
  return {
    enabled,
    status: vi.fn(base.status),
    snapshot: vi.fn(base.snapshot),
    events: vi.fn(base.events),
    resetUecDelta: vi.fn(base.resetUecDelta),
    stop: vi.fn(base.stop),
  } satisfies Telemetry;
};

async function liveWorld(balance?: BalancePolicy) {
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
  const world = await connect(clients(telemetry, balance), UI_CAPS);
  const untilState = (state: string) =>
    waitFor(async () => (await world.call("sc_live_poll")).sc?.["state"] === state, state);
  return { game, telemetry, waitFor, untilState, ...world };
}

describe("Feature: the dashboard tools are listed only to clients that can show them", () => {
  it("Given telemetry on and a text-only client, When tools are listed, Then no dashboard tool appears", async () => {
    const { names } = await connect(clients(createTelemetry({ enabled: true })));
    const listed = await names();
    expect(listed).toContain("sc_live_state");
    for (const t of DASHBOARD_TOOLS) expect(listed).not.toContain(t);
  });

  it("Given a client that declared the UI extension without the HTML MIME type, Then no dashboard tool appears", async () => {
    const caps = { extensions: { [UI_EXTENSION_ID]: { mimeTypes: ["text/plain"] } } };
    const { names } = await connect(clients(createTelemetry({ enabled: true })), caps);
    for (const t of DASHBOARD_TOOLS) expect(await names()).not.toContain(t);
  });

  it("Given telemetry on and a client that declared the UI extension, Then the three tools are listed with their _meta", async () => {
    const { client } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    const tools = (await client.listTools()).tools;
    const by = (n: string) => tools.find((t) => t.name === n)!;
    for (const t of DASHBOARD_TOOLS) expect(by(t), t).toBeDefined();
    expect(by("sc_live_dashboard")._meta).toEqual({
      ui: { resourceUri: DASHBOARD_URI },
      "ui/resourceUri": DASHBOARD_URI,
    });
    for (const t of ["sc_live_poll", "sc_live_mark"]) {
      expect(by(t)._meta).toEqual({ ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } });
    }
    // The tools that have no View carry no _meta.
    expect(by("sc_live_state")._meta).toBeUndefined();
  });

  it("Given telemetry off and a client that renders Views, Then no dashboard tool appears (the model never sees them)", async () => {
    const { names } = await connect(clients(createTelemetry({ enabled: false })), UI_CAPS);
    const listed = await names();
    for (const t of DASHBOARD_TOOLS) expect(listed).not.toContain(t);
    expect(listed).toContain("sc_live_status");
  });

  it("Given a scoped tool list that names the dashboard, Then its two app-only tools come with it", async () => {
    const { names } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS, {
      tools: new Set(["sc_live_dashboard"]),
    });
    expect((await names()).sort()).toEqual(["sc_data_status", ...DASHBOARD_TOOLS].sort());
  });

  it("Given the tool descriptions, Then the model is told to use sc_live_state and not the app-only tools", async () => {
    const { client } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    const tools = (await client.listTools()).tools;
    const dashboard = tools.find((t) => t.name === "sc_live_dashboard")!.description!;
    expect(dashboard).toContain("sc_live_state");
    expect(dashboard).toMatch(/never call sc_live_poll/);
    expect(dashboard).toMatch(/no cargo/);
    expect(dashboard).toMatch(
      /already open in this conversation, do not open it again unless the player explicitly asks/,
    );
    const poll = tools.find((t) => t.name === "sc_live_poll")!.description!;
    expect(poll).toMatch(/not for the model/);
  });
});

describe("Feature: the View is served as a resource, only while telemetry is on", () => {
  it("Given telemetry on, Then the server announces resources and serves the View with the right MIME type and _meta", async () => {
    const { client } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const listed = (await client.listResources()).resources;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ uri: DASHBOARD_URI, mimeType: "text/html;profile=mcp-app" });
    const read = await client.readResource({ uri: DASHBOARD_URI });
    const content = read.contents[0]! as { mimeType: string; text: string; _meta?: unknown };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content._meta).toEqual({ ui: { prefersBorder: false } });
    expect(content.text.startsWith("<!doctype html>")).toBe(true);
    expect(content.text).toContain("Content-Security-Policy");
  });

  it("Given telemetry off, Then no resources capability is announced and nothing can be read", async () => {
    const world = await connect(clients(createTelemetry({ enabled: false })), UI_CAPS);
    expect(world.client.getServerCapabilities()?.resources).toBeUndefined();
    await expect(world.client.listResources()).rejects.toThrow();
    await expect(world.client.readResource({ uri: DASHBOARD_URI })).rejects.toThrow();
    // And at the registry level the refusal says why.
    expect(() => world.registry.readResource(DASHBOARD_URI)).toThrow(/switched off/);
    expect(world.registry.listResources()).toEqual([]);
  });

  it("Given an unknown ui:// URI, Then the read is refused", async () => {
    const { client } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    await expect(client.readResource({ uri: "ui://other/page.html" })).rejects.toThrow(
      /Unknown resource/,
    );
  });

  it("Given telemetry off, Then the server is what it was before the dashboard: same capabilities as without a telemetry object", async () => {
    const off = await connect(clients(createTelemetry({ enabled: false })));
    const none = await connect(clients());
    expect(Object.keys(off.client.getServerCapabilities()!).sort()).toEqual(["prompts", "tools"]);
    expect(Object.keys(none.client.getServerCapabilities()!).sort()).toEqual(["prompts", "tools"]);
  });
});

describe("Feature: opening the dashboard", () => {
  it("Given telemetry on, When sc_live_dashboard is called, Then a short text and a small structured object come back", async () => {
    const { call } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    const { r, sc, text } = await call("sc_live_dashboard");
    expect(r.isError).toBeUndefined();
    expect(typeof sc).toBe("object");
    expect(Array.isArray(sc)).toBe(false);
    expect(sc).toMatchObject({ view: "sc_live_dashboard" });
    expect(JSON.stringify(sc).length).toBeLessThan(900);
    // The model is told not to open a second copy: the open one updates by itself.
    expect(sc?.["hint"]).toMatch(
      /already open[^.]*do not open another one unless the player explicitly asks/,
    );
    expect(text).toContain(String(sc?.["hint"]));
    expect(text).toContain("sc_live_state");
    expect(text).toContain("provenance");
  });

  it("Given a plan with long, dirty and unknown fields, Then only known fields survive, capped and cleaned", async () => {
    const { call } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    const ZW = String.fromCharCode(0x200b);
    const BIDI = String.fromCharCode(0x202e);
    const { sc } = await call("sc_live_dashboard", {
      plan: {
        commodity: `Laranite${ZW}${BIDI}` + "x".repeat(200),
        buy_terminal: "Port Tressler",
        sell_terminal: "<img src=x onerror=alert(1)>",
        scu: 96.4,
        expected_profit_auec: 125000.7,
        note: 42,
        secret: "should be dropped",
        __proto__: { polluted: true },
      },
      extra: "ignored",
    });
    const plan = sc!["plan"] as Record<string, unknown>;
    expect(Object.keys(plan).sort()).toEqual([
      "buy_terminal",
      "commodity",
      "expected_profit_auec",
      "scu",
      "sell_terminal",
    ]);
    expect((plan["commodity"] as string).length).toBe(60);
    expect(plan["commodity"]).not.toContain(ZW);
    expect(plan["commodity"]).not.toContain(BIDI);
    expect(plan["scu"]).toBe(96);
    expect(plan["expected_profit_auec"]).toBe(125001);
    // The hostile text is kept as plain text (the View shows it with textContent only).
    expect(plan["sell_terminal"]).toBe("<img src=x onerror=alert(1)>");
  });

  it("Given a plan that is not an object, Then it is dropped silently", async () => {
    const { call } = await connect(clients(createTelemetry({ enabled: true })), UI_CAPS);
    for (const plan of ["text", 12, [1, 2], null, {}]) {
      const { r, sc } = await call("sc_live_dashboard", { plan: plan as never });
      expect(r.isError).toBeUndefined();
      expect(sc).not.toHaveProperty("plan");
    }
  });

  it("Given telemetry off and a call by name, Then it refuses and reads nothing", async () => {
    const connectSpy = vi.spyOn(http2, "connect");
    const { r } = await (
      await connect(clients(createTelemetry({ enabled: false })), UI_CAPS)
    ).call("sc_live_dashboard");
    expect(r.isError).toBe(true);
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe("Feature: the poll never starts the reader while telemetry is off", () => {
  it("Given telemetry off, When the View polls, Then it gets state off, a fixed text, and no service call was made", async () => {
    const spy = spyTelemetry(false);
    const connectSpy = vi.spyOn(http2, "connect");
    const { call } = await connect(clients(spy), UI_CAPS);
    const { sc, text, r } = await call("sc_live_poll", { include_balance: true });
    expect(r.isError).toBeUndefined();
    expect(sc).toMatchObject({ v: 1, state: "off", enabled: false, ship: null, pilot: null });
    expect(sc).not.toHaveProperty("balance");
    expect(text).toContain("live dashboard poll: off");
    expect(spy.status).not.toHaveBeenCalled();
    expect(spy.snapshot).not.toHaveBeenCalled();
    expect(spy.events).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("Given telemetry off, When a marker is set, Then nothing happens and nothing is read", async () => {
    const spy = spyTelemetry(false);
    const { sc } = await (
      await connect(clients(spy), UI_CAPS)
    ).call("sc_live_mark", {
      action: "start",
    });
    expect(sc).toMatchObject({ ok: false });
    expect(spy.events).not.toHaveBeenCalled();
    expect(spy.resetUecDelta).not.toHaveBeenCalled();
  });
});

describe("Feature: the poll answers many Views for the price of one", () => {
  it("Given three polls within 500 ms, Then the telemetry is read once; after 500 ms it is read again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const spy = spyTelemetry(true);
    const { call } = await connect(clients(spy), UI_CAPS);
    await Promise.all([call("sc_live_poll"), call("sc_live_poll"), call("sc_live_poll")]);
    expect(spy.status).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-03T12:00:00.400Z"));
    await call("sc_live_poll");
    expect(spy.status).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-03T12:00:00.600Z"));
    await call("sc_live_poll");
    expect(spy.status).toHaveBeenCalledTimes(2);
  });

  it.each(HIDDEN_MODES)(
    "Given a View that asked for the balance and $label, Then another View that did not ask never receives it",
    async (mode) => {
      const { game, call, untilState } = await liveWorld(mode.policy);
      await untilState("connected");
      game.send(
        frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 80, uec: 424242 })),
      );
      await untilState("live");
      const [withBalance, without] = await Promise.all([
        call("sc_live_poll", { include_balance: true }),
        call("sc_live_poll", mode.args),
      ]);
      // Hidden by the server's setting, an explicit include_balance true is ignored: the mask is not liftable by a call.
      if (mode.policy?.hiddenByDefault || mode.policy?.playerChoice === "hidden") {
        expect(withBalance.sc).not.toHaveProperty("balance");
        expect(JSON.stringify(withBalance.sc)).not.toContain("424242");
      } else {
        expect(withBalance.sc!["balance"]).toMatchObject({ uec: 424242 });
      }
      expect(without.sc).not.toHaveProperty("balance");
      expect(JSON.stringify(without.sc)).not.toContain("424242");
      // The text of the answer never carries data, so it cannot carry the balance either.
      expect(withBalance.text).not.toContain("424242");
      expect(without.text).not.toContain("424242");
    },
  );

  it("Given a server that shows the balance by default, Then a View that says nothing gets it, and one that says false does not", async () => {
    const { game, call, untilState } = await liveWorld();
    await untilState("connected");
    game.send(
      frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 80, uec: 424242 })),
    );
    await untilState("live");
    const said = await call("sc_live_poll");
    expect(said.sc!["balance"]).toMatchObject({ uec: 424242 });
    const hid = await call("sc_live_poll", { include_balance: false });
    expect(hid.sc).not.toHaveProperty("balance");
    expect(JSON.stringify(hid.sc)).not.toContain("424242");
  });

  it("Given SC_BALANCE=hidden, Then the page starts hidden, a poll's include_balance true is ignored, and only a CLICK (balance_choice shown) lifts the mask", async () => {
    const { game, call, untilState, client } = await liveWorld({ hiddenByDefault: true });
    await untilState("connected");
    game.send(
      frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 80, uec: 424242 })),
    );
    await untilState("live");
    const page = async () =>
      ((await client.readResource({ uri: DASHBOARD_URI })).contents[0] as { text: string }).text;
    expect(await page()).toContain('data-balance="hidden"');
    const ignored = await call("sc_live_poll", { include_balance: true });
    expect(ignored.sc).not.toHaveProperty("balance");
    expect(ignored.sc!["balance_state"]).toBe("hidden");
    const clicked = await call("sc_live_poll", { include_balance: true, balance_choice: "shown" });
    expect(clicked.sc!["balance"]).toMatchObject({ uec: 424242 });
    expect(clicked.sc!["balance_state"]).toBe("shown");
    expect(await page()).toContain('data-balance="shown"');
  });

  /** The tools as the model calls them (no UI), after the player's clicks in the dashboard, end to end. */
  describe("Scenario: the dashboard's toggle protects the tools", () => {
    const BAL = "424242";
    async function played() {
      // One policy object for the process: the tools and the dashboard share it, as src/index.ts does.
      const w = await liveWorld({ hiddenByDefault: false, playerChoice: null });
      await w.untilState("connected");
      w.game.send(
        frame(
          vehicleField({ name: "DRAK_Cutter_1" }),
          actorField({ health: 80, uec: Number(BAL) }),
        ),
      );
      await w.untilState("live");
      return w;
    }
    const state = async (w: Awaited<ReturnType<typeof played>>, args = {}) =>
      (await w.call("sc_live_state", args)).text;

    it("Given the player clicks 'Masquer le solde', Then a tool with no argument and one with include_balance true give no amount, with the note; and 'Afficher le solde' gives them back", async () => {
      const w = await played();
      expect(await state(w)).toContain(BAL); // shown by default
      const hid = await w.call("sc_live_poll", {
        include_balance: false,
        balance_choice: "hidden",
      });
      expect(hid.sc!["balance_state"]).toBe("hidden");
      for (const args of [{}, { include_balance: true }]) {
        const text = await state(w, args);
        expect(text, JSON.stringify(args)).not.toContain(BAL);
        expect(text).not.toContain("uec_session");
        expect(text).toContain("Montants masqués par le joueur");
        expect(text).toContain("Afficher le solde");
      }
      // an ordinary poll from another dashboard asking for the balance changes nothing
      const other = await w.call("sc_live_poll", { include_balance: true });
      expect(other.sc).not.toHaveProperty("balance");
      expect(await state(w, { include_balance: true })).not.toContain(BAL);
      // the route button's one-off gives it for that answer only
      const once = await w.call("sc_live_poll", { include_balance: true, balance_once: true });
      expect(once.sc!["balance"]).toMatchObject({ uec: 424242 });
      expect(await state(w)).not.toContain(BAL);
      // the player clicks 'Afficher le solde'
      await w.call("sc_live_poll", { include_balance: true, balance_choice: "shown" });
      expect(await state(w)).toContain(BAL);
      expect(await state(w, { include_balance: true })).toContain(BAL);
    });

    it("Given the last click wins, Then a later 'Masquer' from another dashboard hides again", async () => {
      const w = await played();
      await w.call("sc_live_poll", { balance_choice: "hidden" });
      await w.call("sc_live_poll", { balance_choice: "shown" });
      expect(await state(w)).toContain(BAL);
      await w.call("sc_live_poll", { balance_choice: "hidden" });
      expect(await state(w)).not.toContain(BAL);
    });
  });
});

describe("Feature: the poll carries the live state as a structured object", () => {
  it.each(HIDDEN_MODES)(
    "Given a live game and $label, Then the answer is an object with the state, the age, the ship and the pilot, and no balance",
    async (mode) => {
      const { game, call, untilState } = await liveWorld(mode.policy);
      await untilState("connected");
      game.send(
        frame(
          vehicleField({ name: "DRAK_Cutter_1", speed: 120, lights: { shld: "nominal" } }),
          actorField({ health: 0, uec: 8675309 }),
        ),
      );
      await untilState("live");
      const { sc } = await call("sc_live_poll", { include_static: true, ...mode.args });
      expect(sc).toMatchObject({ v: 1, enabled: true, state: "live" });
      expect(sc!["frame_age_ms"]).toBeGreaterThanOrEqual(0);
      expect(sc!["ship"].instruments.speed_ms).toBeCloseTo(120);
      expect(sc!["ship"].name).toBe("DRAK_Cutter_1");
      expect(sc!["pilot"].health).toMatchObject({ current: 0 });
      expect(sc!["pilot"]).not.toHaveProperty("uec_balance");
      expect(sc!["ship"]).not.toHaveProperty("unverified");
      expect(JSON.stringify(sc)).not.toContain("8675309");
      expect(sc!["not_in_stream"]).toContain("shield_level");
      expect(sc!["session"]).toMatchObject({ started_at: null, flight_ms_is_estimate: true });
    },
  );

  it("Given session markers, Then they live in memory, reset the counters and are returned by the poll", async () => {
    const { game, call, untilState } = await liveWorld();
    await untilState("connected");
    game.send(
      frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 90, uec: 1000 })),
    );
    await untilState("live");
    const start = await call("sc_live_mark", { action: "start" });
    expect(start.sc).toMatchObject({ ok: true, action: "start" });
    const { sc } = await call("sc_live_poll", { include_balance: true });
    expect(sc!["session"].started_at).not.toBeNull();
    expect(sc!["session"].markers.map((m: { kind: string }) => m.kind)).toEqual(["start"]);
    expect(sc!["balance"]).toMatchObject({ uec: 1000, delta: 0 });
    const end = await call("sc_live_mark", { action: "end" });
    expect(end.sc).toMatchObject({ ok: true });
    expect((await call("sc_live_mark", { action: "end" })).sc).toMatchObject({ ok: false });
    expect((await call("sc_live_mark", { action: "nope" as never })).r.isError).toBe(true);
  });
});

describe("Feature: a View only receives what it does not hold yet", () => {
  async function liveShip() {
    const world = await liveWorld();
    await world.untilState("connected");
    world.game.send(
      frame(
        vehicleField({ name: "DRAK_Cutter_1", speed: 120, lights: { shld: "nominal" } }),
        actorField({ health: 90, uec: 1000 }),
      ),
    );
    await world.untilState("live");
    return world;
  }

  it("Given a first poll and a second one that sends the hashes and the event cursor, Then unchanged sections and old events are left out", async () => {
    const { call } = await liveShip();
    const first = (await call("sc_live_poll", { include_static: true })).sc!;
    expect(first["not_in_stream"]).toContain("shield_level");
    expect(first["hash"]).toEqual({
      ship: expect.stringMatching(/^[0-9a-f]{14}$/),
      pilot: expect.stringMatching(/^[0-9a-f]{14}$/),
      weapons: expect.stringMatching(/^[0-9a-f]{14}$/),
      specs: expect.stringMatching(/^[0-9a-f]{14}$/),
      ledger: expect.stringMatching(/^[0-9a-f]{14}$/),
    });
    const second = (
      await call("sc_live_poll", {
        since_seq: first["last_seq"],
        have: {
          ship: first["hash"].ship,
          pilot: first["hash"].pilot,
          weapons: first["hash"].weapons,
          ledger: first["hash"].ledger,
        },
      })
    ).sc!;
    expect(second).not.toHaveProperty("not_in_stream");
    expect(second["events"]).toEqual([]);
    // The frame is the same one: nothing changed in the ship and the pilot.
    expect(second["unchanged"]).toEqual(expect.arrayContaining(["ship", "pilot"]));
    expect(second).not.toHaveProperty("ship");
    expect(second).not.toHaveProperty("pilot");
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length / 2);
  });

  it("Given a hash that is not the current one, Then the section comes back whole", async () => {
    const { call } = await liveShip();
    const { sc } = await call("sc_live_poll", { have: { ship: "0123456789abcd" } });
    expect(sc!["ship"]).toMatchObject({ name: "DRAK_Cutter_1" });
    expect(sc).not.toHaveProperty("unchanged");
  });

  it("Given an event cursor ahead of the server (it restarted), Then all events come back", async () => {
    const { call } = await liveShip();
    const all = (await call("sc_live_poll", {})).sc!["events"];
    const ahead = (await call("sc_live_poll", { since_seq: 999_999 })).sc!["events"];
    expect(ahead).toEqual(all);
  });

  it.each([
    ["a hash with markup", { have: { ship: "<script>" } }],
    ["a long hash", { have: { ship: "a".repeat(40) } }],
    ["a negative cursor", { since_seq: -1 }],
    ["a cursor that is not a number", { since_seq: "x" }],
    ["a flag that is not a boolean", { include_static: "yes" }],
  ])("Given %s, Then the call is refused", async (_name, args) => {
    const { call } = await liveShip();
    expect((await call("sc_live_poll", args as never)).r.isError).toBe(true);
  });

  it("Given two Views asking different things at the same moment, Then the telemetry is still read once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const spy = spyTelemetry(true);
    const { call } = await connect(clients(spy), UI_CAPS);
    await Promise.all([
      call("sc_live_poll", { include_static: true }),
      call("sc_live_poll", { since_seq: 5, have: { ship: "abc" } }),
      call("sc_live_poll", {}),
    ]);
    expect(spy.status).toHaveBeenCalledTimes(1);
  });
});
