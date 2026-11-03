import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools, createRegistry } from "./registry.js";

/** Feature: the fleet shows where UEX and the wiki disagree instead of picking one. */

const UEX_VEHICLES = [
  {
    id: 1,
    name: "C2 Hercules Starlifter",
    name_full: "Crusader C2 Hercules Starlifter",
    scu: 696,
    crew: "1,2",
  },
  { id: 2, name: "Vanguard Harbinger", name_full: "Aegis Vanguard Harbinger", scu: 0, crew: "1" },
  { id: 3, name: "Cyclone", name_full: "Tumbril Cyclone", scu: 1, crew: "1" },
  { id: 4, name: "Vulture", name_full: "Drake Vulture", scu: 12, crew: "1" },
];

const WIKI: Record<string, unknown> = {
  "C2 Hercules Starlifter": {
    name: "C2 Hercules Starlifter",
    cargo_capacity: 696,
    crew: { min: 2, max: 2 },
    speed: { scm: 112, max: 1200 },
  },
  "Vanguard Harbinger": {
    name: "Vanguard Harbinger",
    crew: { min: 2, max: 4 },
    speed: { scm: 100, max: 1100 },
  },
  Cyclone: {
    name: "Cyclone",
    role: "Passenger",
    crew: { min: 1, max: 1 },
    cargo_capacity: 1,
    speed: { scm: 0, max: 0 },
  },
  Vulture: {
    name: "Vulture",
    cargo_capacity: 12,
    crew: { min: 1, max: 1 },
    speed: { scm: 180, max: 1100 },
  },
};

let n = 0;
let dir: string;

function fakeHttp(get: (url: string) => unknown): HttpClient {
  return {
    defaults: { baseURL: `https://fleet-${++n}.test` },
    get: async (url: string) => ({ data: get(url) }),
  } as unknown as HttpClient;
}

async function world(ships: { name: string; origin: "pledge" | "in_game" }[]) {
  const fleet = new FleetStore(path.join(dir, "fleet.json"));
  for (const s of ships) await fleet.upsert(s);
  const uexClient = fakeHttp(() => ({ data: UEX_VEHICLES }));
  const scwClient = fakeHttp((url) => {
    const key = decodeURIComponent(url.replace("/vehicles/", ""));
    if (key in WIKI) return { data: WIKI[key] };
    throw Object.assign(new Error("404"), { isAxiosError: true, response: { status: 404 } });
  });
  const empty = fakeHttp(() => ({}));
  const registry = createRegistry(
    allTools({
      uexClient,
      scwClient,
      sctClient: empty,
      scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => dir }),
      gameLog: new GameLog({}),
      fleet,
    }),
    {},
  );
  return registry;
}

const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rowOf = async (name: string): Promise<Row> => {
  const registry = await world([{ name, origin: "pledge" }]);
  return body(await registry.call("sc_fleet_get", {})).data.ships[0];
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-fleetconf-"));
  clearCache();
  configureDiskCache(null);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Feature: conflicts between UEX and the wiki are shown, not hidden", () => {
  describe("Scenario: the two sources give a different crew", () => {
    it("Given the C2 (UEX 1 to 2, wiki 2), When I read my fleet, Then both crews are shown with their source and conflict is true", async () => {
      const ship = await rowOf("C2 Hercules Starlifter");
      expect(ship.conflict).toBe(true);
      expect(ship.conflicts).toEqual(["crew"]);
      expect(ship.comparison.crew).toEqual({
        conflict: true,
        uex: { min: 1, max: 2 },
        wiki: { min: 2, max: 2 },
      });
      expect(ship.conflict_hint).toMatch(/both values/);
    });

    it("Given the Harbinger (UEX 1, wiki 2 to 4), Then the conflict is flagged and neither value is dropped", async () => {
      const ship = await rowOf("Vanguard Harbinger");
      expect(ship.conflicts).toEqual(["crew"]);
      expect(ship.comparison.crew.uex).toEqual({ min: 1, max: 1 });
      expect(ship.comparison.crew.wiki).toEqual({ min: 2, max: 4 });
      // The figures that were already there stay, for callers that read them.
      expect(ship.uex.crew).toBe("1");
      expect(ship.stats.crew).toEqual({ min: 2, max: 4 });
    });
  });

  describe("Scenario: the sources agree", () => {
    it("Given the Vulture (same crew and cargo in both), Then conflict is false and there is no conflict list", async () => {
      const ship = await rowOf("Drake Vulture");
      expect(ship.conflict).toBe(false);
      expect(ship.conflicts).toBeUndefined();
      expect(ship.comparison.crew).toMatchObject({ conflict: false });
      expect(ship.comparison.cargo_scu).toEqual({ conflict: false, uex: 12, wiki: 12 });
    });
  });

  describe("Scenario: a speed of 0", () => {
    it("Given the Cyclone (wiki speeds 0), Then the speeds are reported as not provided, not as 0", async () => {
      const ship = await rowOf("Tumbril Cyclone");
      expect(ship.stats).not.toHaveProperty("speed_scm");
      expect(ship.stats).not.toHaveProperty("speed_max");
      expect(ship.stats.not_provided_by_wiki).toEqual(["speed_scm", "speed_max"]);
      expect(ship.stats.role).toBe("Passenger");
    });

    it("Given a ship with real speeds, Then they are kept and nothing is flagged missing", async () => {
      const ship = await rowOf("Drake Vulture");
      expect(ship.stats).toMatchObject({ speed_scm: 180, speed_max: 1100 });
      expect(ship.stats).not.toHaveProperty("not_provided_by_wiki");
    });
  });

  describe("Scenario: UEX has no cargo figure", () => {
    it("Given the Harbinger (UEX scu 0, wiki none), Then 0 is not compared as a real cargo size", async () => {
      const ship = await rowOf("Vanguard Harbinger");
      expect(ship.comparison.cargo_scu).toBeUndefined();
    });
  });

  describe("Scenario: the wiki has no page for the ship", () => {
    it("Given an unknown wiki page, Then UEX figures stay and no comparison is invented", async () => {
      const registry = await world([{ name: "Drake Vulture", origin: "pledge" }]);
      delete WIKI.Vulture;
      try {
        const ship = body(await registry.call("sc_fleet_get", {})).data.ships[0];
        expect(ship.stats_error).toMatch(/no page/);
        expect(ship.comparison).toBeUndefined();
        expect(ship.conflict).toBeUndefined();
        expect(ship.uex).toMatchObject({ scu: 12 });
      } finally {
        WIKI.Vulture = {
          name: "Vulture",
          cargo_capacity: 12,
          crew: { min: 1, max: 1 },
          speed: { scm: 180, max: 1100 },
        };
      }
    });
  });
});
