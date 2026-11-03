import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools, createRegistry } from "./registry.js";

/** Feature: trade routes sized to the ship the player actually flies. */

const VEHICLES = [
  { id: 1, name: "C2 Hercules Starlifter", name_full: "Crusader C2 Hercules Starlifter", scu: 696 },
  { id: 2, name: "M2 Hercules Starlifter", name_full: "Crusader M2 Hercules Starlifter", scu: 522 },
  { id: 3, name: "Vulture", name_full: "Drake Vulture", scu: 12 },
  { id: 4, name: "Vanguard Harbinger", name_full: "Aegis Vanguard Harbinger", scu: 0 },
];
const route = (profit: number, reports = 0) => ({
  commodity_name: "Laranite",
  origin_terminal_name: "Admin - ARC-L1",
  destination_terminal_name: "Rest Stop",
  price_margin: 0,
  profit,
  price_origin_users_rows: reports,
  price_destination_users_rows: 0,
});

let n = 0;
function world() {
  const get = vi.fn(async (url: string) => {
    if (url === "/vehicles") return { data: { data: VEHICLES } };
    if (url === "/commodities") return { data: { data: [{ id: 79, name: "Laranite" }] } };
    if (url === "/commodities_routes") return { data: { data: [route(100), route(900, 7)] } };
    throw new Error(`unexpected ${url}`);
  });
  const uex = {
    defaults: { baseURL: `https://hauling-${++n}.test` },
    get,
  } as unknown as HttpClient;
  const empty = {
    defaults: { baseURL: "https://x.test" },
    get: async () => ({ data: {} }),
  } as unknown as HttpClient;
  const registry = createRegistry(
    allTools({
      uexClient: uex,
      scwClient: empty,
      sctClient: empty,
      scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
      gameLog: new GameLog({}),
      fleet: new FleetStore("unused-fleet.json"),
    }),
    {},
  );
  return { registry, get };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const lastRouteCall = (get: ReturnType<typeof world>["get"]) =>
  get.mock.calls.filter((c) => c[0] === "/commodities_routes").at(-1) as unknown as [
    string,
    { params: Record<string, unknown> },
  ];

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: hauling routes sized to my ship", () => {
  describe("Scenario: I name my ship instead of its cargo size", () => {
    it("Given a C2 Hercules, When I ask for Laranite routes, Then UEX is asked for 696 SCU and the answer says which ship", async () => {
      const { registry, get } = world();
      const { data } = body(
        await registry.call("uex_get_trade_routes", {
          commodity_name: "Laranite",
          ship_name: "Crusader Hercules Starlifter C2",
        }),
      );
      expect(lastRouteCall(get)[1].params.scu).toBe(696);
      expect(data.ship).toEqual({ name: "Crusader C2 Hercules Starlifter", scu: 696 });
      expect(data.cargo_scu_used).toBe(696);
    });
  });

  describe("Scenario: my name fits several ships", () => {
    it("Then I am asked to choose, and no route is requested", async () => {
      const { registry, get } = world();
      const result = await registry.call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        ship_name: "Hercules Starlifter",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(
        /fits several ships \(Crusader C2 Hercules Starlifter; Crusader M2/,
      );
      expect(get.mock.calls.some((c) => c[0] === "/commodities_routes")).toBe(false);
    });
  });

  describe("Scenario: my ship cannot carry cargo", () => {
    it("Then I am told so instead of getting routes for zero SCU", async () => {
      const { registry } = world();
      const result = await registry.call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        ship_name: "Harbinger",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Aegis Vanguard Harbinger has no cargo capacity/);
    });
  });

  describe("Scenario: I give both a ship and a size", () => {
    it("Then the size I typed wins, for example when only part of the hold is free", async () => {
      const { registry, get } = world();
      await registry.call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        ship_name: "Vulture",
        cargo_capacity: 8,
      });
      expect(lastRouteCall(get)[1].params.scu).toBe(8);
    });
  });

  describe("Scenario: an unknown ship", () => {
    it("Then the error says so", async () => {
      const { registry } = world();
      const result = await registry.call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        ship_name: "Nonexistent",
      });
      expect(result.content[0].text).toMatch(/No ship matches "Nonexistent"/);
    });
  });

  describe("Scenario: I want to judge how far to trust a route", () => {
    it("Then each route shows how many player reports back its prices, and zeros stay visible", async () => {
      const { registry } = world();
      const { data } = body(
        await registry.call("uex_get_trade_routes", { commodity_name: "Laranite" }),
      );
      expect(
        data.routes.map((r: { profit: number; reports_origin: number }) => [
          r.profit,
          r.reports_origin,
        ]),
      ).toEqual([
        [900, 7],
        [100, 0],
      ]);
      expect(data.routes[0].margin).toBe(0);
    });
  });
});
