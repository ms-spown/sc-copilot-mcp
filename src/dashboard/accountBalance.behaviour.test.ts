/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BalancePolicy } from "../core/balance.js";
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
import { HIDDEN_MODES, SHOWN_MODES } from "../testing/balanceModes.js";
import { waitFor } from "../testing/waitFor.js";
import { allResources, allTools, createRegistry, type ToolClients } from "../tools/registry.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE } from "./constants.js";

/**
 * The account reminder through the real tool (`sc_live_poll`), in every way the amounts are hidden or shown. The balance
 * 8 675 309 is a made-up reading, searched as a WHOLE figure.
 */

const empty = {
  defaults: { baseURL: "https://unused.test" },
  get: async () => ({ data: {} }),
} as unknown as HttpClient;

function clients(telemetry: Telemetry, balance?: BalancePolicy): ToolClients {
  return {
    uexClient: empty,
    scwClient: empty,
    sctClient: empty,
    scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
    gameLog: new GameLog({}),
    fleet: new FleetStore("unused-fleet.json"),
    telemetry,
    ...(balance ? { balance } : {}),
  };
}

vi.setConfig({ testTimeout: 30_000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const UI_CAPS = { extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } } };
const BAL = 8675309;
const WHOLE = /(?<![\d])8675309(?![\d])/;

async function world(balance?: BalancePolicy, withGame = true) {
  const game = await startFakeGame();
  cleanup.push(() => game.close());
  const telemetry = createTelemetry({
    enabled: true,
    options: {
      endpointForTests: { host: "127.0.0.1", port: withGame ? game.port : 1 },
      reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
    },
  });
  cleanup.push(() => telemetry.stop());
  const c = clients(telemetry, balance);
  const registry = createRegistry(
    allTools(c, createProbes(c, NO_NETWORK)),
    {},
    {
      resources: allResources(c),
    },
  );
  const server = createMcpServer(registry);
  const client = new Client({ name: "test", version: "1" }, { capabilities: UI_CAPS } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(() => client.close());
  const poll = async (args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: "sc_live_poll", arguments: args });
    return {
      sc: r.structuredContent as Record<string, any>,
      text: (r.content as { text: string }[])[0]!.text,
    };
  };
  return { game, poll };
}

async function live(balance?: BalancePolicy) {
  const w = await world(balance);
  await waitFor(async () => (await w.poll()).sc["state"] === "connected", "connected");
  w.game.send(frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 80, uec: BAL })));
  await waitFor(async () => (await w.poll()).sc["state"] === "live", "live");
  return w;
}

describe("Feature: the account reminder follows the player's balance choice", () => {
  it.each(HIDDEN_MODES)(
    "Given a live game and $label, Then the answer has no account and no amount anywhere",
    async (mode) => {
      const { poll } = await live(mode.policy);
      const { sc, text } = await poll({ ...mode.args });
      expect(sc).not.toHaveProperty("account");
      expect(sc).not.toHaveProperty("balance");
      expect(JSON.stringify(sc)).not.toMatch(WHOLE);
      expect(text).not.toMatch(WHOLE);
    },
  );

  it.each(SHOWN_MODES)("Given a live game and $label, Then the account is live", async (mode) => {
    const { poll } = await live(mode.policy);
    const { sc, text } = await poll({ ...mode.args });
    // This world has no Game.log, so the channel is unknown: the figure is shown and flagged, not claimed as verified.
    expect(sc["account"]).toEqual({ source: "live", uec: BAL, channel_unverified: true });
    // The data lives in the structured content only: the text of the answer never carries it.
    expect(text).not.toMatch(WHOLE);
  });

  it("Given telemetry on and no game, Then the balance is unknown because the game is closed, not zero", async () => {
    const { poll } = await world(undefined, false);
    const { sc } = await poll();
    expect(sc["account"]).toMatchObject({ source: "unknown" });
    expect(sc["account"]).not.toHaveProperty("uec");
  });

  it("Given a poll that did not ask for the balance, Then another View that did still gets it", async () => {
    const { poll } = await live();
    const [plain, rich] = await Promise.all([poll({ include_balance: false }), poll()]);
    expect(plain.sc).not.toHaveProperty("account");
    expect(rich.sc["account"]).toMatchObject({ uec: BAL });
  });
});
