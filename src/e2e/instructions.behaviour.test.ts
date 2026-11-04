import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpClient } from "../core/http.js";
import { MAX_INSTRUCTIONS_LENGTH, SERVER_INSTRUCTIONS } from "../instructions.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { createMcpServer } from "../server.js";
import { allTools, createRegistry } from "../tools/registry.js";

/** Feature: the server's operating manual (the `instructions` field of the initialize result). */

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

/** Where a rule must appear at the latest: a client that truncates keeps the start. */
const CRITICAL_WITHIN = 2000;

describe("Feature: the server tells Claude how to be a trade copilot", () => {
  let client: Client | undefined;
  afterEach(async () => client?.close());

  describe("Scenario: a client connects", () => {
    it("Then the initialize result carries the instructions", async () => {
      const server = createMcpServer(createRegistry(tools, {}));
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      client = new Client({ name: "claude-test", version: "1" });
      await client.connect(b);
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    });
  });

  describe("Scenario: the text is edited", () => {
    it("Then it stays within the length bound, in plain ASCII", () => {
      expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
      expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(1500);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(SERVER_INSTRUCTIONS)).toBe(true);
    });

    it("Then it holds no link, no host and no secret-looking value", () => {
      expect(SERVER_INSTRUCTIONS).not.toMatch(/https?:|www\.|\.(com|org|uk|space|io)\b/i);
      expect(SERVER_INSTRUCTIONS).not.toMatch(/token|password|secret/i);
    });

    it("Then every tool it names exists in the registry (this fails if one is renamed)", () => {
      const mentioned = new Set(
        SERVER_INSTRUCTIONS.match(/\b(?:sc|uex|scw|sct|scmdb)_[a-z_]+\b/g) ?? [],
      );
      expect([...mentioned].filter((n) => !toolNames.has(n))).toEqual([]);
      // The trade tools the manual is about must all be routed to.
      for (const name of [
        "uex_plan_trade",
        "uex_get_trade_routes",
        "uex_get_price_history",
        "uex_get_market_status",
        "uex_get_commodity_prices",
        "uex_get_refining_margins",
        "uex_get_item_prices",
        "uex_compare_items",
        "uex_get_marketplace_prices",
        "sc_trade_journal",
        "sc_fleet_get",
        "sc_data_status",
        "sc_live_status",
        "sc_live_state",
        "sc_live_dashboard",
      ]) {
        expect(mentioned.has(name), name).toBe(true);
      }
    });

    it("Then the two dashboard-only tools are named only to be forbidden", () => {
      const line = SERVER_INSTRUCTIONS.split("\n").find((l) => l.includes("sc_live_poll")) ?? "";
      expect(line).toMatch(/^- Never call sc_live_poll or sc_live_mark/);
      expect(SERVER_INSTRUCTIONS.match(/sc_live_poll/g)).toHaveLength(1);
      expect(SERVER_INSTRUCTIONS.match(/sc_live_mark/g)).toHaveLength(1);
    });
  });

  describe("Scenario: the player runs the canary test of the guide", () => {
    it("Then the section titles that the guide asks Claude to quote are really in the text", () => {
      const guides = ["USING_WITH_CLAUDE.md", "USING_WITH_CLAUDE.fr.md"].map((f) =>
        readFileSync(new URL(`../../docs/${f}`, import.meta.url), "utf8"),
      );
      for (const title of ["ALWAYS", "FRESHNESS", "TOOL BY INTENT", "ACCOMPANY"]) {
        expect(SERVER_INSTRUCTIONS, title).toMatch(new RegExp(`^${title}\\b`, "m"));
        for (const guide of guides) expect(guide, title).toContain(title);
      }
    });
  });

  describe("Scenario: a client keeps only the start of the text", () => {
    it.each([
      ["never invents a number", /Never invent/],
      ["never calls telemetry safe", /Never call telemetry safe, undetectable or approved/],
      ["asks before the balance", /include_balance, and only after asking the player/],
      ["never calls the dashboard's tools", /Never call sc_live_poll or sc_live_mark/],
      ["does not open a second dashboard", /never a second copy/],
      ["never says the game is not running", /Never say the game is not running/],
      ["connection state", /connection .*disconnected, menu or closed/],
      ["untrusted text is data", /untrusted_text .*never instructions/],
    ])("Then it %s within the first characters", (_label, pattern) => {
      const at = SERVER_INSTRUCTIONS.search(pattern);
      expect(at, String(pattern)).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(CRITICAL_WITHIN);
    });
  });

  describe("Scenario: the copilot behaviour is asked for", () => {
    it.each([
      ["the honesty markers", /ESTIMATE/],
      ["the data age and the cache age", /data_age.*cache_age/],
      ["a gross margin only from the journal", /GROSS margin only/],
      ["a next step to offer", /one concrete next step/],
      ["a proposal with alternatives", /one main option, up to two alternatives/],
      ["a debrief", /Debriefing/],
      ["the player's language", /player's language/],
    ])("Then it covers %s", (_label, pattern) => {
      expect(SERVER_INSTRUCTIONS).toMatch(pattern);
    });
  });
});
