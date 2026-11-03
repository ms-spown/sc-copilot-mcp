import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient } from "../core/http.js";
import { PROMPTS } from "../prompts.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { createMcpServer } from "../server.js";
import { allTools, createRegistry } from "../tools/registry.js";

/** Feature: ready-made prompts that point Claude at the right tools. */

const unused = { defaults: {}, get: async () => ({ data: {} }) } as unknown as HttpClient;
const tools = allTools({
  uexClient: unused,
  scwClient: unused,
  sctClient: unused,
  scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
  gameLog: new GameLog({}),
  fleet: new FleetStore("unused.json"),
});
const toolNames = new Set(tools.map((t) => t.name));

describe("Feature: prompts the user can pick in Claude", () => {
  let client: Client | undefined;
  async function connect() {
    const server = createMcpServer(createRegistry(tools, {}));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "claude-test", version: "1" });
    await client.connect(b);
    return client;
  }
  afterEach(async () => client?.close());

  describe("Scenario: Claude lists the prompts", () => {
    it("Then each has a name, a title, a description and its arguments", async () => {
      const c = await connect();
      const { prompts } = await c.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(
        ["haul_plan", "mission_hunt", "mining_prep", "patch_briefing", "session_debrief"].sort(),
      );
      for (const p of prompts) {
        expect(p.title, p.name).toBeTruthy();
        expect((p.description ?? "").length, p.name).toBeGreaterThan(20);
      }
    });
  });

  describe("Scenario: the user picks a prompt with arguments", () => {
    it("Given a ship and a starting planet, Then the instruction names them and the tools to use", async () => {
      const c = await connect();
      const r = await c.getPrompt({
        name: "haul_plan",
        arguments: { ship: "C2 Hercules Starlifter", origin: "ArcCorp", budget: "5000000" },
      });
      const text = (r.messages[0].content as { text: string }).text;
      expect(r.messages[0].role).toBe("user");
      expect(text).toContain("Ship: C2 Hercules Starlifter.");
      expect(text).toContain("Starting point: ArcCorp.");
      expect(text).toContain("uex_get_trade_routes");
      expect(text).toContain("untrusted_text");
    });

    it("Given no arguments, Then optional parts are simply left out", async () => {
      const c = await connect();
      const r = await c.getPrompt({ name: "haul_plan" });
      const text = (r.messages[0].content as { text: string }).text;
      expect(text).not.toContain("Ship:");
      expect(text).toContain("sc_fleet_get");
    });
  });

  describe("Scenario: a required argument is missing", () => {
    it("Then the error names it", async () => {
      const c = await connect();
      await expect(c.getPrompt({ name: "mining_prep", arguments: {} })).rejects.toThrow(
        /Missing required argument: ore/,
      );
    });
  });

  describe("Scenario: an unknown prompt", () => {
    it("Then it is refused clearly", async () => {
      const c = await connect();
      await expect(c.getPrompt({ name: "nope" })).rejects.toThrow(/Unknown prompt/);
    });
  });

  describe("Scenario: a tool is renamed", () => {
    it("Then every tool a prompt mentions still exists (this fails if one goes stale)", () => {
      const mentioned = new Set<string>();
      for (const p of PROMPTS) {
        const args = Object.fromEntries(p.arguments.map((a) => [a.name, "x"]));
        for (const m of p.render(args).match(/\b(?:sc|uex|scw|sct|scmdb)_[a-z_]+\b/g) ?? [])
          mentioned.add(m);
      }
      const unknown = [...mentioned].filter((n) => !toolNames.has(n));
      expect(unknown).toEqual([]);
      expect(mentioned.size).toBeGreaterThan(10);
    });
  });
});
