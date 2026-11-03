import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { allTools, createRegistry } from "../../tools/registry.js";
import { GameLog } from "../gamelog/reader.js";
import { Scmdb } from "../scmdb/store.js";
import { resolveShip, type VehicleRow } from "./resolve.js";
import { FleetError, FleetStore, fleetFilePath } from "./store.js";

// Invented list shaped like UEX's /vehicles: name_full has the maker, name does not.
const UEX: VehicleRow[] = [
  { name: "Vulture", name_full: "Drake Vulture", scu: 12, crew: "1" },
  {
    name: "A2 Hercules Starlifter",
    name_full: "Crusader A2 Hercules Starlifter",
    scu: 234,
    crew: "1,8",
  },
  {
    name: "C2 Hercules Starlifter",
    name_full: "Crusader C2 Hercules Starlifter",
    scu: 696,
    crew: "1,2",
  },
  {
    name: "M2 Hercules Starlifter",
    name_full: "Crusader M2 Hercules Starlifter",
    scu: 522,
    crew: "1,3",
  },
  { name: "Vanguard Harbinger", name_full: "Aegis Vanguard Harbinger", scu: 0, crew: "1" },
  { name: "Vanguard Warden", name_full: "Aegis Vanguard Warden", scu: 0, crew: "1" },
  { name: "Dragonfly Black", name_full: "Drake Dragonfly Black", scu: 0, crew: "1,2" },
  { name: "Dragonfly Yellowjacket", name_full: "Drake Dragonfly Yellowjacket", scu: 0, crew: "1" },
  { name: "Cyclone", name_full: "Tumbril Cyclone", scu: 1, crew: "1" },
  { name: "Cyclone AA", name_full: "Tumbril Cyclone AA", scu: 0, crew: "1" },
  { name: "Cyclone MT", name_full: "Tumbril Cyclone MT", scu: 0, crew: "1" },
];

describe("resolveShip", () => {
  const found = (q: string) => {
    const r = resolveShip(q, UEX);
    return r.match === "found" ? r.vehicle.name_full : r.match;
  };

  it("matches by words, not by string: order and maker do not matter", () => {
    expect(found("Crusader Hercules Starlifter C2")).toBe("Crusader C2 Hercules Starlifter");
    expect(found("c2 hercules")).toBe("Crusader C2 Hercules Starlifter");
    expect(found("Drake Vulture")).toBe("Drake Vulture");
    expect(found("vulture")).toBe("Drake Vulture");
    expect(found("Aegis Vanguard Harbinger")).toBe("Aegis Vanguard Harbinger");
    expect(found("Harbinger")).toBe("Aegis Vanguard Harbinger");
    expect(found("Drake Dragonfly Black")).toBe("Drake Dragonfly Black");
  });

  it("prefers the ship whose words are exactly the query's over its variants", () => {
    expect(found("Tumbril Cyclone")).toBe("Tumbril Cyclone");
    expect(found("cyclone")).toBe("Tumbril Cyclone");
    expect(found("Cyclone AA")).toBe("Tumbril Cyclone AA");
  });

  it("returns the candidates instead of guessing when several ships fit", () => {
    const r = resolveShip("Hercules Starlifter", UEX);
    expect(r.match).toBe("ambiguous");
    expect(r.match === "ambiguous" && r.candidates.map((c) => c.name_full)).toEqual([
      "Crusader A2 Hercules Starlifter",
      "Crusader C2 Hercules Starlifter",
      "Crusader M2 Hercules Starlifter",
    ]);
    expect(resolveShip("Vanguard", UEX).match).toBe("ambiguous");
    expect(resolveShip("Dragonfly", UEX).match).toBe("ambiguous");
  });

  it("says not_found for unknown or empty names", () => {
    expect(resolveShip("Nonexistent Ship", UEX).match).toBe("not_found");
    expect(resolveShip("   ", UEX).match).toBe("not_found");
    expect(resolveShip("Vulture Prime", UEX).match).toBe("not_found");
  });
});

describe("FleetStore", () => {
  let dir: string;
  let file: string;
  let store: FleetStore;
  const clock = () => new Date("2026-11-03T12:00:00Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-fleet-"));
    file = path.join(dir, "nested", "fleet.json");
    store = new FleetStore(file, clock);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("starts empty when the file does not exist, without creating it", async () => {
    expect(await store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("adds a ship and writes a versioned file with no price or account field", async () => {
    const { ship, created } = await store.upsert({ name: "Drake Vulture", origin: "pledge" });
    expect(created).toBe(true);
    expect(ship).toEqual({
      origin: "pledge",
      name: "Drake Vulture",
      notes: "",
      added_at: "2026-11-03T12:00:00.000Z",
    });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(Object.keys(onDisk.ships[0]).sort()).toEqual(["added_at", "name", "notes", "origin"]);
  });

  it("updates the note of the same name and origin (any case), keeping added_at", async () => {
    await store.upsert({ name: "Drake Vulture", origin: "pledge" });
    const later = new FleetStore(file, () => new Date("2027-01-01T00:00:00Z"));
    const { ship, created } = await later.upsert({
      name: "drake vulture",
      origin: "pledge",
      notes: "salvage",
    });
    expect(created).toBe(false);
    expect(ship.notes).toBe("salvage");
    expect(ship.added_at).toBe("2026-11-03T12:00:00.000Z");
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps the same ship as two entries when it is both a pledge and an in-game purchase", async () => {
    await store.upsert({ name: "Cyclone", origin: "pledge" });
    await store.upsert({ name: "Cyclone", origin: "in_game" });
    expect(await store.list()).toHaveLength(2);
    await expect(store.remove("Cyclone")).rejects.toThrow(/both pledge and in_game/);
    await store.remove("cyclone", "in_game");
    expect((await store.list()).map((s) => s.origin)).toEqual(["pledge"]);
  });

  it("reports removing something that is not there", async () => {
    await expect(store.remove("Ghost")).rejects.toThrow(FleetError);
  });

  it("survives many concurrent writes without losing any", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.upsert({ name: `Ship ${i}`, origin: "in_game" })),
    );
    expect(await store.list()).toHaveLength(25);
  });

  it("leaves no temporary file behind", async () => {
    await store.upsert({ name: "A", origin: "pledge" });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["fleet.json"]);
  });

  it("refuses to overwrite a corrupt file, and leaves it exactly as it was", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    await expect(store.upsert({ name: "A", origin: "pledge" })).rejects.toThrow(
      /not valid.*not changed/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  it("refuses a file from a newer version instead of downgrading it", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, ships: [] }));
    await expect(store.list()).rejects.toThrow(/version 2/);
  });

  it("strips control characters and refuses empty or oversized input", async () => {
    const { ship } = await store.upsert({
      name: "  Vul\u0007ture \u0000",
      origin: "pledge",
      notes: "a\u001Bb",
    });
    expect(ship.name).toBe("Vulture");
    expect(ship.notes).toBe("ab");
    await expect(store.upsert({ name: "   ", origin: "pledge" })).rejects.toThrow();
    await expect(store.upsert({ name: "x".repeat(101), origin: "pledge" })).rejects.toThrow();
    await expect(
      store.upsert({ name: "ok", origin: "pledge", notes: "x".repeat(501) }),
    ).rejects.toThrow();
    await expect(store.upsert({ name: "ok", origin: "wishlist" as never })).rejects.toThrow();
  });

  it("lives in the per-user config folder, or where SCMCP_FLEET_FILE says", () => {
    expect(fleetFilePath({ SCMCP_CONFIG_DIR: dir })).toBe(path.join(dir, "fleet.json"));
    expect(fleetFilePath({ SCMCP_FLEET_FILE: path.join(dir, "mine.json") })).toBe(
      path.join(dir, "mine.json"),
    );
  });
});

describe("fleet tools", () => {
  let dir: string;
  const clientFor = (routes: Record<string, unknown>) => {
    const get = vi.fn(async (url: string) => {
      const r = routes[url];
      if (r instanceof Error) throw r;
      if (r === undefined)
        throw Object.assign(new Error("404"), { isAxiosError: true, response: { status: 404 } });
      return { data: r };
    });
    return {
      client: {
        defaults: { baseURL: `https://f-${Math.random()}.test` },
        get,
      } as unknown as HttpClient,
      get,
    };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-fleet-tools-"));
    configureDiskCache(null);
    clearCache();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup() {
    const uex = clientFor({ "/vehicles": { data: UEX } });
    const wiki = clientFor({
      "/vehicles/Vulture": {
        data: {
          name: "Vulture",
          manufacturer: { name: "Drake Interplanetary" },
          role: "Light Salvage",
          cargo_capacity: 12,
          crew: { min: 1, max: 1 },
          health: 43700,
          msrp: 175,
          size: { en_EN: "Small" },
        },
      },
      "/vehicles/C2 Hercules Starlifter": {
        data: { name: "C2 Hercules Starlifter", cargo_capacity: 696 },
      },
    });
    const fleet = new FleetStore(path.join(dir, "fleet.json"));
    const empty = clientFor({}).client;
    const registry = createRegistry(
      allTools({
        uexClient: uex.client,
        scwClient: wiki.client,
        sctClient: empty,
        scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => dir }),
        gameLog: new GameLog({}),
        fleet,
      }),
      {},
    );
    return { registry, wiki, uex, fleet };
  }
  const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

  it("adds, lists with stats, and removes ships through the tools", async () => {
    const { registry } = setup();
    await registry.call("sc_fleet_upsert", {
      name: "Drake Vulture",
      origin: "pledge",
      notes: "salvage",
    });
    await registry.call("sc_fleet_upsert", {
      name: "Crusader Hercules Starlifter C2",
      origin: "pledge",
    });
    const got = body(await registry.call("sc_fleet_get", {}));

    expect(got.provenance).toMatchObject({
      kind: "user",
      source: expect.stringContaining("fleet file"),
    });
    expect(got.data.count).toBe(2);
    const [vulture, c2] = got.data.ships;
    expect(vulture).toMatchObject({
      match: "found",
      resolved_as: "Drake Vulture",
      notes: "salvage",
    });
    expect(vulture.stats).toMatchObject({
      manufacturer: "Drake Interplanetary",
      cargo_scu: 12,
      size: "Small",
    });
    expect(c2).toMatchObject({
      match: "found",
      resolved_as: "Crusader C2 Hercules Starlifter",
      uex: { scu: 696 },
    });

    await registry.call("sc_fleet_remove", { name: "drake vulture" });
    expect(body(await registry.call("sc_fleet_get", { enrich: false })).data.count).toBe(1);
  });

  it("never puts a price in the stats, and never shows the user's folder", async () => {
    const { registry } = setup();
    await registry.call("sc_fleet_upsert", { name: "Vulture", origin: "pledge" });
    const out = (await registry.call("sc_fleet_get", {})).content[0].text;
    expect(out).not.toMatch(/msrp|price/i);
    expect(out).not.toContain(os.tmpdir());
  });

  it("returns candidates for an ambiguous name and says so for an unknown one", async () => {
    const { registry } = setup();
    await registry.call("sc_fleet_upsert", { name: "Hercules Starlifter", origin: "in_game" });
    await registry.call("sc_fleet_upsert", { name: "Nonexistent", origin: "in_game" });
    const { ships } = body(await registry.call("sc_fleet_get", {})).data;
    expect(ships[0]).toMatchObject({ match: "ambiguous" });
    expect(ships[0].candidates).toHaveLength(3);
    expect(ships[0]).not.toHaveProperty("stats");
    expect(ships[1].match).toBe("not_found");
  });

  it("keeps UEX's figures and says why when the wiki has no page", async () => {
    const { registry } = setup();
    await registry.call("sc_fleet_upsert", { name: "Tumbril Cyclone", origin: "pledge" });
    const [cyclone] = body(await registry.call("sc_fleet_get", {})).data.ships;
    expect(cyclone).toMatchObject({ match: "found", uex: { scu: 1 } });
    expect(cyclone.stats_error).toMatch(/no page for this exact name/);
  });

  it("filters by origin, makes no network call with enrich=false, and explains an empty fleet", async () => {
    const { registry, uex } = setup();
    expect(body(await registry.call("sc_fleet_get", {})).data.hint).toMatch(/empty/);
    await registry.call("sc_fleet_upsert", { name: "Vulture", origin: "pledge" });
    await registry.call("sc_fleet_upsert", { name: "Cyclone", origin: "in_game" });
    const calls = uex.get.mock.calls.length;
    const raw = body(await registry.call("sc_fleet_get", { enrich: false, origin: "in_game" }));
    expect(raw.data.ships.map((s: { name: string }) => s.name)).toEqual(["Cyclone"]);
    expect(uex.get.mock.calls.length).toBe(calls);
  });

  it("reports a bad input or a missing ship as an error result", async () => {
    const { registry } = setup();
    expect((await registry.call("sc_fleet_upsert", { name: "x" })).isError).toBe(true);
    const gone = await registry.call("sc_fleet_remove", { name: "Ghost" });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toMatch(/No ship called "Ghost"/);
  });
});
