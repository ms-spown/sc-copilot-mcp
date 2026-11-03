import { AxiosError } from "axios";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { allTools, createRegistry } from "../../tools/registry.js";
import type { ToolResult } from "../../tools/types.js";
import { searchCrafting, searchMining, searchMissions, summarizeChanges } from "./queries.js";
import { GameLog } from "../gamelog/reader.js";
import { FleetStore } from "../fleet/store.js";
import { Scmdb } from "./store.js";

// ---- synthetic fixtures: tiny, hand-made, nothing copied from game data ------------------

const manifest = {
  schema: 2,
  generated_at: "2026-11-01T00:00:00Z",
  channels: {
    live: {
      version: "9.9.1-live.111",
      generated_at: "2026-11-01T00:00:00Z",
      files: {
        merged: "merged-9.9.1-live.111.json",
        crafting_blueprints: "crafting_blueprints-9.9.1-live.111.json",
        mining_data: "mining_data-9.9.1-live.111.json",
        mining_equipment: "mining_equipment-9.9.1-live.111.json",
      },
    },
  },
};

const merged = {
  version: "9.9.1-live.111",
  locationPools: {
    p1: { name: "Test Outpost", type: "Outpost", system: "Stanton", planet: "Hurston", moon: null },
    p2: { name: "Far Station", type: "Station", system: "Pyro", planet: null, moon: null },
  },
  blueprintPools: {
    pool1: {
      name: "BP_TEST",
      blueprints: [{ blueprintRecord: "bp-1", name: "Widget Rifle" }, { name: "Gizmo Armor" }],
    },
  },
  contracts: [
    {
      id: "c1",
      title: "Cheap errand",
      category: "career",
      missionType: "Delivery",
      contractorName: "Acme",
      illegal: false,
      rewardUEC: 1000,
      locations: ["p1"],
      systems: ["Stanton"],
      description: "Carry <EM4>a box</EM4> to somewhere.",
      minStanding: { name: "Neutral" },
    },
    {
      id: "c2",
      title: "Big hit",
      category: "career",
      missionType: "Bounty Hunter",
      contractorName: "Shady Co",
      illegal: true,
      rewardUEC: 90000,
      locations: ["p2"],
      systems: ["Pyro"],
      blueprintRewards: [{ blueprintPool: "pool1", chance: 1, trigger: "complete" }],
    },
    {
      id: "c3",
      title: "Mid job",
      category: "event",
      missionType: "Hauling",
      contractorName: "Acme",
      illegal: false,
      rewardUEC: 5000,
      locations: ["p1", "p2"],
      systems: ["Stanton", "Pyro"],
    },
  ],
};

const blueprints = {
  blueprints: [
    {
      guid: "bp-1",
      tag: "BP_X",
      productName: "Widget Rifle",
      type: "weapons",
      gear: "fps",
      manufacturer: "Acme Arms",
      tiers: [
        {
          craftTimeSeconds: 120,
          slots: [
            {
              name: "Barrel",
              options: [
                { type: "resource", quantity: 3, minQuality: 500, resourceName: "Titanium" },
              ],
            },
          ],
        },
      ],
    },
    {
      guid: "bp-2",
      tag: "BP_Y",
      productName: "Plain Shield",
      type: "shield",
      tiers: [
        {
          slots: [
            {
              name: "Core",
              options: [{ type: "item", quantity: 1, minQuality: 0, itemName: "Gem" }],
            },
          ],
        },
      ],
    },
  ],
};

const mining = {
  mineableElements: {
    e1: {
      name: "Zirconite (Ore)",
      materialName: "Zirconite",
      rarity: "rare",
      instability: 500,
      resistance: 0.4,
      density: 3,
      scanSignature: 1234,
      optimalWindowMidpoint: 0.5,
    },
    e2: {
      name: "Plainium (Ore)",
      materialName: "Plainium",
      rarity: "common",
      instability: 100,
      resistance: 0.1,
      density: 1,
    },
  },
  compositions: {
    cA: {
      name: "Zirc rock",
      parts: [{ elementGuid: "e1", elementName: "Zirconite", probability: 1 }],
    },
    cB: {
      name: "Plain rock",
      parts: [{ elementGuid: "e2", elementName: "Plainium", probability: 1 }],
    },
  },
  locations: [
    {
      locationName: "Rich Belt",
      system: "Stanton",
      locationType: "belt",
      groups: [
        {
          groupProbability: 1,
          deposits: [
            { relativeProbability: 3, compositionGuid: "cA" },
            { relativeProbability: 1, compositionGuid: "cB" },
          ],
        },
      ],
    },
    {
      locationName: "Poor Moon",
      system: "Stanton",
      locationType: "moon",
      groups: [
        {
          groupProbability: 1,
          deposits: [
            { relativeProbability: 1, compositionGuid: "cA" },
            { relativeProbability: 9, compositionGuid: "cB" },
          ],
        },
      ],
    },
  ],
};
const equipment = {
  lasers: [{ name: "Test Laser", manufacturer: "Acme" }],
  modules: [{ name: "Test Module" }],
  gadgets: [],
};

const deltas = {
  pairs: [
    {
      from: "9.9.0-live.100",
      to: "9.9.1-live.111",
      timestamp: "2026-11-01T00:00:00Z",
      total: 3,
      missions: {
        added: [{ title: "New thing" }],
        removed: [{ title: "Old thing" }],
        changed: [{ title: "Tweaked", changes: { rewardUEC: {} } }],
      },
    },
    {
      from: "9.8.0-live.90",
      to: "9.9.0-live.100",
      timestamp: "2026-10-01T00:00:00Z",
      total: 0,
      missions: { added: [], removed: [], changed: [] },
    },
  ],
};
const changelog = [
  {
    version: "1.0.1",
    date: "2026-11-01",
    changes: [
      { type: "data", text: "New <b>build</b> imported" },
      { type: "ui", text: "ignored" },
    ],
  },
];

// ---- fake network ------------------------------------------------------------------------

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
let dir: string;
let sha: string | Error;
let counter = 0;
let rawCalls: string[];
let rawFails: Error | null;

function files(): Record<string, unknown> {
  return {
    "latest.json": manifest,
    "merged-9.9.1-live.111.json": merged,
    "crafting_blueprints-9.9.1-live.111.json": blueprints,
    "mining_data-9.9.1-live.111.json": mining,
    "mining_equipment-9.9.1-live.111.json": equipment,
    "deltas-live.json": deltas,
    "changelog.json": changelog,
  };
}

function makeScmdb(): Scmdb {
  const raw = {
    defaults: { baseURL: `https://raw-${++counter}.test` },
    get: vi.fn(async (url: string) => {
      rawCalls.push(url);
      if (rawFails && !url.endsWith("latest.json")) throw rawFails;
      const body = files()[url.split("/").pop()!];
      if (body === undefined) throw new Error(`fake raw: no file ${url}`);
      return { data: body };
    }),
  } as unknown as HttpClient;
  const api = {
    defaults: {},
    get: vi.fn(async () => {
      if (sha instanceof Error) throw sha;
      return { data: sha };
    }),
  } as unknown as HttpClient;
  return new Scmdb({ raw, api, repo: "o/r", cacheDir: () => dir });
}

const outage = () => new AxiosError("Network Error", "ERR_NETWORK");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmdb-"));
  configureDiskCache(null);
  clearCache();
  sha = SHA1;
  rawCalls = [];
  rawFails = null;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Scmdb store", () => {
  it("reads the manifest and a channel's files", async () => {
    const s = makeScmdb();
    expect((await s.channelInfo("live")).info.version).toBe("9.9.1-live.111");
    expect(((await s.file("live", "merged")).data as typeof merged).contracts).toHaveLength(3);
  });

  it("downloads a file once per commit: a second reader finds it on disk", async () => {
    await makeScmdb().file("live", "merged");
    const before = rawCalls.filter((c) => c.includes("merged-")).length;
    await makeScmdb().file("live", "merged");
    expect(rawCalls.filter((c) => c.includes("merged-")).length).toBe(before);
    expect(rawCalls.find((c) => c.includes("merged-"))).toContain(`/o/r/${SHA1}/data/`);
  });

  it("fetches again when the repository moves to a new commit (a republish)", async () => {
    await makeScmdb().file("live", "merged");
    sha = SHA2;
    await makeScmdb().file("live", "merged");
    expect(rawCalls.filter((c) => c.includes("merged-"))).toHaveLength(2);
    expect(rawCalls.at(-1)).toContain(SHA2);
  });

  it("still works when GitHub's API cannot give a SHA, keyed on the manifest timestamp", async () => {
    sha = new Error("rate limited");
    const s = makeScmdb();
    await s.file("live", "merged");
    expect(rawCalls.find((c) => c.includes("merged-"))).toContain("/o/r/main/data/");
    expect(fs.readdirSync(path.join(dir, "scmdb"))[0]).toMatch(/^main-20261101000000__merged/);
  });

  it("serves the last copy, flagged stale, when the download fails during an outage", async () => {
    await makeScmdb().file("live", "merged");
    sha = SHA2;
    rawFails = outage();
    const { fetches } = await (
      await import("../../core/provenance.js")
    ).runWithProvenance(async (ctx) => {
      await makeScmdb().file("live", "merged");
      return ctx;
    });
    expect(fetches.at(-1)?.cache).toBe("stale-disk");
    expect(fetches.at(-1)?.staleReason).toMatch(/last copy kept on disk/);
  });

  it("does not paper over a non-outage failure with an old copy", async () => {
    await makeScmdb().file("live", "merged");
    sha = SHA2;
    rawFails = new AxiosError("nf", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 404,
      data: {},
      statusText: "",
      headers: {},
      config: {} as never,
    });
    await expect(makeScmdb().file("live", "merged")).rejects.toThrow("nf");
  });

  it("refuses an unsupported manifest schema and a file of the wrong shape", async () => {
    manifest.schema = 3;
    await expect(makeScmdb().manifest()).rejects.toThrow(/schema 3/);
    manifest.schema = 2;

    const good = merged.contracts;
    (merged as { contracts: unknown }).contracts = "nope";
    try {
      await expect(makeScmdb().file("live", "merged")).rejects.toThrow(
        /unexpected shape at "contracts"/,
      );
    } finally {
      (merged as { contracts: unknown }).contracts = good;
    }
  });

  it("says when a channel does not exist, and rejects odd names and repos", async () => {
    await expect(makeScmdb().channelInfo("ptu")).rejects.toThrow(/no PTU build/);
    expect(
      () => new Scmdb({ raw: {} as never, api: {} as never, repo: "../x", cacheDir: () => dir }),
    ).toThrow(/owner\/name/);
  });
});

describe("mission search", () => {
  it("sorts by reward and resolves places", () => {
    const r = searchMissions(merged, {});
    expect(r.missions.map((m) => m.id)).toEqual(["c2", "c3", "c1"]);
    expect(r.missions[2].locations.sample).toEqual(["Test Outpost"]);
    expect(r.missions[2].description).toBe("Carry a box to somewhere.");
  });

  it("filters by words, place, legality, reward and blueprint reward", () => {
    expect(searchMissions(merged, { query: "acme hauling" }).missions.map((m) => m.id)).toEqual([
      "c3",
    ]);
    expect(searchMissions(merged, { location: "pyro" }).total_matches).toBe(2);
    expect(searchMissions(merged, { location: "hurston" }).total_matches).toBe(2);
    expect(searchMissions(merged, { illegal: true }).missions[0].id).toBe("c2");
    expect(searchMissions(merged, { min_reward: 4000 }).total_matches).toBe(2);
    const bp = searchMissions(merged, { reward_blueprint: "gizmo" });
    expect(bp.missions[0].blueprint_rewards?.[0]).toMatchObject({
      count: 2,
      sample: ["Widget Rifle", "Gizmo Armor"],
    });
  });

  it("caps the row count", () => {
    const many = {
      ...merged,
      contracts: Array.from({ length: 80 }, (_, i) => ({
        id: `m${i}`,
        title: `t${i}`,
        rewardUEC: i,
      })),
    };
    expect(searchMissions(many, { limit: 999 }).shown).toBe(30);
    expect(searchMissions(many, {}).shown).toBe(10);
  });
});

describe("crafting search", () => {
  it("shows the recipe and which missions reward the blueprint", () => {
    const r = searchCrafting(blueprints, merged, { query: "rifle" });
    expect(r.blueprints[0]).toMatchObject({
      name: "Widget Rifle",
      craft_time_seconds: 120,
      recipe: [{ slot: "Barrel", needs: ["3× Titanium (quality ≥ 500)"] }],
      rewarded_by_missions: { count: 1, sample: ["Big hit"] },
    });
  });

  it("filters by type and by a resource used, and can skip sources", () => {
    expect(searchCrafting(blueprints, null, { type: "shield" }).blueprints[0].name).toBe(
      "Plain Shield",
    );
    expect(searchCrafting(blueprints, null, { uses_resource: "titan" }).total_matches).toBe(1);
    expect(
      searchCrafting(blueprints, null, { uses_resource: "gem" }).blueprints[0],
    ).not.toHaveProperty("rewarded_by_missions");
  });
});

describe("mining search", () => {
  it("ranks an ore's locations by relative share, for a specific search only", () => {
    const one = searchMining(mining, equipment, { query: "zirconite", scope: "ores" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(one.ores.rows[0].found_at.map((l: { location: string }) => l.location)).toEqual([
      "Rich Belt",
      "Poor Moon",
    ]);
    expect(one.ores.rows[0].found_at[0].relative_share).toBeGreaterThan(
      one.ores.rows[0].found_at[1].relative_share,
    );
    const all = searchMining(mining, equipment, { scope: "ores" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(all.ores.rows[0]).not.toHaveProperty("found_at");
  });

  it("searches equipment by name", () => {
    const r = searchMining(mining, equipment, { query: "test", scope: "equipment" }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.lasers).toHaveLength(1);
    expect(r.ores).toBeUndefined();
  });
});

describe("changes", () => {
  it("summarizes the newest update, with counts, examples and the maintainer's data notes", () => {
    const r = summarizeChanges(deltas, changelog, {});
    expect(r).toMatchObject({ from: "9.9.0-live.100", to: "9.9.1-live.111", total_changes: 3 });
    expect(r.sections).toMatchObject({
      missions: {
        added: { count: 1, sample: ["New thing"] },
        removed: { count: 1, sample: ["Old thing"] },
        changed: { count: 1, sample: [{ name: "Tweaked", what: ["rewardUEC"] }] },
      },
    });
    expect(r.recent_site_notes[0].data_notes).toEqual(["New build imported"]);
    expect(r.other_updates_available).toEqual(["9.8.0-live.90 -> 9.9.0-live.100"]);
  });

  it("skips newer builds that changed no data, and says so", () => {
    const quiet = {
      pairs: [
        { from: "9.9.1", to: "9.9.2", timestamp: "2026-11-02T00:00:00Z", total: 0 },
        ...deltas.pairs,
      ],
    };
    const r = summarizeChanges(quiet, null, {});
    expect(r.to).toBe("9.9.1-live.111");
    expect(r.note).toBe("Newer builds with no data change were skipped: 9.9.2.");
  });

  it("can look at an older update, and lists what exists when none matches", () => {
    expect(summarizeChanges(deltas, null, { to: "9.9.0" }).to).toBe("9.9.0-live.100");
    expect(() => summarizeChanges(deltas, null, { to: "1.2.3" })).toThrow(
      /Available: 9\.9\.1-live\.111/,
    );
  });
});

describe("SCMDB tools through the registry", () => {
  const registry = () => {
    const empty = {
      defaults: { baseURL: "https://x.test" },
      get: async () => ({ data: {} }),
    } as unknown as HttpClient;
    return createRegistry(
      allTools({
        uexClient: empty,
        scwClient: empty,
        sctClient: empty,
        scmdb: makeScmdb(),
        gameLog: new GameLog({}),
        fleet: new FleetStore("unused-fleet.json"),
      }),
      {},
    );
  };
  const body = (r: ToolResult) => JSON.parse(r.content[0].text);

  it("answers with LIVE provenance carrying the build, and never a whole file", async () => {
    const r = await registry().call("scmdb_search_missions", { query: "big" });
    const { provenance, data } = body(r);
    expect(provenance).toMatchObject({
      source: "scmdb",
      channel: "live",
      game_version: "9.9.1-live.111",
      kind: "datamined",
    });
    expect(data.missions).toHaveLength(1);
  });

  it("keeps zeros and ids in the data (not run through formatOutput)", async () => {
    const r = await registry().call("scmdb_search_missions", { query: "cheap" });
    expect(body(r).data.missions[0]).toMatchObject({ id: "c1", illegal: false });
  });

  it("explains that PTU is absent instead of returning LIVE data under a PTU label", async () => {
    const r = await registry().call("scmdb_search_missions", { channel: "ptu" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no PTU build/);
  });

  it("scmdb_changes flags the maintainer's notes as untrusted text", async () => {
    const r = await registry().call("scmdb_changes", {});
    expect(body(r).provenance.trust).toBe("untrusted_text");
    expect(body(r).data.to).toBe("9.9.1-live.111");
  });

  it("scmdb_search_crafting and scmdb_search_mining work end to end", async () => {
    expect(
      body(await registry().call("scmdb_search_crafting", { uses_resource: "titanium" })).data
        .blueprints[0].name,
    ).toBe("Widget Rifle");
    expect(
      body(await registry().call("scmdb_search_mining", { query: "zirconite", scope: "ores" })).data
        .ores.rows[0].name,
    ).toBe("Zirconite (Ore)");
  });
});
