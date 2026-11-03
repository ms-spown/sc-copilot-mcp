import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { createGameVersionResolver, createProbes } from "../providers/probes.js";
import { NO_NETWORK } from "../providers/probes.testing.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { createMcpServer } from "../server.js";
import { allTools, createRegistry, type Selection } from "../tools/registry.js";

/**
 * Feature: what Claude actually experiences, through the real MCP protocol.
 * A client and the server are linked in memory; only the outside world (UEX, the wiki) is faked.
 */

const UEX_VEHICLES = [
  { id: 1, name: "Vulture", name_full: "Drake Vulture", scu: 12, crew: "1" },
  {
    id: 2,
    name: "C2 Hercules Starlifter",
    name_full: "Crusader C2 Hercules Starlifter",
    scu: 696,
    crew: "1,2",
  },
];

let n = 0;
function fakeHttp(routes: Record<string, unknown>): HttpClient {
  return {
    defaults: { baseURL: `https://proto-${++n}.test` },
    get: async (url: string) => {
      const r = routes[url];
      if (r === undefined)
        throw Object.assign(new Error("404"), { isAxiosError: true, response: { status: 404 } });
      return { data: r };
    },
  } as unknown as HttpClient;
}

describe("Feature: Claude uses the Star Citizen tools", () => {
  let dir: string;
  let client: Client;

  async function connect(selection: Selection = {}) {
    const uexClient = fakeHttp({
      "/vehicles": { data: UEX_VEHICLES },
      "/game_versions": { data: { live: "4.10.2", ptu: null } },
    });
    const scwClient = fakeHttp({
      "/vehicles/Vulture": {
        data: { name: "Vulture", cargo_capacity: 12, manufacturer: { name: "Drake" } },
      },
      "/vehicles": { data: [{ version: "4.10.2-LIVE.1", updated_at: "2026-10-28T00:00:00Z" }] },
    });
    const sctClient = fakeHttp({});
    const scmdb = new Scmdb({
      raw: fakeHttp({}),
      api: fakeHttp({}),
      repo: "o/r",
      cacheDir: () => dir,
    });
    const clients = {
      uexClient,
      scwClient,
      sctClient,
      scmdb,
      gameLog: new GameLog({}),
      fleet: new FleetStore(path.join(dir, "fleet.json")),
    };
    const registry = createRegistry(
      allTools(clients, createProbes(clients, NO_NETWORK)),
      selection,
      {
        gameVersionFor: createGameVersionResolver(clients),
      },
    );
    const server = createMcpServer(registry);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "claude-test", version: "1.0.0" });
    await client.connect(clientSide);
  }

  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-proto-"));
    configureDiskCache(null);
    clearCache();
  });
  afterEach(async () => {
    await client?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("Scenario: Claude connects and looks at what it can use", () => {
    it("Given a connection, Then the server announces sc-copilot-mcp, the package name, not the old star-citizen-mcp", async () => {
      await connect();
      expect(client.getServerVersion()?.name).toBe("sc-copilot-mcp");
    });

    it("Given no scoping, Then every tool is listed with a description and an input schema", async () => {
      await connect();
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(40);
      for (const tool of tools) {
        expect(tool.description?.length, tool.name).toBeGreaterThan(40);
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("Given the core profile, Then Claude sees a short list that includes the status tool and the fleet", async () => {
      await connect({ profiles: ["core"] });
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeLessThan(15);
      expect(names).toEqual(
        expect.arrayContaining(["sc_data_status", "sc_fleet_get", "uex_get_trade_routes"]),
      );
      expect(names).not.toContain("sc_log_status");
    });
  });

  describe("Scenario: Claude asks about the player's fleet", () => {
    it("Given an empty fleet, When Claude adds a ship and asks for the fleet, Then it comes back with its public stats", async () => {
      await connect();
      const added = await call("sc_fleet_upsert", {
        name: "Drake Vulture",
        origin: "pledge",
        notes: "salvage",
      });
      expect(added.isError).toBeFalsy();
      const fleet = JSON.parse(text(await call("sc_fleet_get")));
      expect(fleet.provenance).toMatchObject({ kind: "user", trust: "untrusted_text" });
      expect(fleet.data.ships[0]).toMatchObject({
        match: "found",
        resolved_as: "Drake Vulture",
        notes: "salvage",
        stats: { cargo_scu: 12 },
      });
    });
  });

  describe("Scenario: Claude checks how fresh the data is", () => {
    it("Then sc_data_status lists each source, and one that is down is reported with its error instead of being hidden", async () => {
      await connect();
      const status = JSON.parse(text(await call("sc_data_status")));
      const bySource = Object.fromEntries(
        status.data.sources.map((s: { id: string }) => [s.id, s]),
      );
      expect(bySource.uex).toMatchObject({ status: "ok" });
      expect(bySource.uex.live.version).toBe("4.10.2");
      expect(bySource["starcitizen.tools"].status).toBe("error"); // the fake wiki has no route
      expect(bySource["game-log"].status).toBe("not_configured");
      expect(status.data.warnings.join(" ")).toMatch(/starcitizen\.tools is unavailable/);
    });
  });

  describe("Scenario: Claude makes a mistake", () => {
    it("Given an unknown tool, Then it gets an error result it can read, not a broken connection", async () => {
      await connect();
      const r = await call("no_such_tool");
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("Error: Unknown tool: no_such_tool");
      expect(JSON.parse(text(await call("uex_get_game_versions"))).data.live).toBe("4.10.2"); // still alive
    });

    it("Given a missing required argument, Then the message names it", async () => {
      await connect();
      const r = await call("uex_get_commodity_prices", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/commodity_name/);
    });

    it("Given a trade route request with no origin, Then it is told exactly what UEX needs", async () => {
      await connect();
      const r = await call("uex_get_trade_routes", { cargo_capacity: 696 });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(
        /at least one of commodity_name, origin_terminal_name or origin_planet_name/,
      );
    });
  });

  describe("Scenario: the game log is off", () => {
    it("Then Claude is told how to enable it, and is not handed an empty answer", async () => {
      await connect();
      const status = JSON.parse(text(await call("sc_log_status")));
      expect(status.data.configured).toBe(false);
      expect(status.data.how_to_enable).toMatch(/SC_INSTALL_DIR/);
      const events = await call("sc_log_recent_events");
      expect(events.isError).toBe(true);
      expect(text(events)).toMatch(/log is off/);
    });
  });
});
