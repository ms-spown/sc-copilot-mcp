import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools, createRegistry } from "./registry.js";

/**
 * Feature: an answer says how old its DATA is (not how long ago it was fetched), UEX rows of an
 * old game version do not pass for current ones, estimated routes do not top the list, and a
 * price query does not dump every terminal.
 */

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (ms: number) => Math.floor((NOW - ms) / 1000); // UEX dates are Unix seconds
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The real shape: date_added is when UEX created the row (long ago), date_modified when a price
// was last reported, price_*_users_rows how many players reported it (0 = UEX's estimate).
const CREATED = 1703551048; // 2023-12
const row = (name: string, extra: Record<string, unknown>) => ({
  date_added: CREATED,
  commodity_name: "Recycled Material Composite",
  star_system_name: "Stanton",
  terminal_name: name,
  price_buy_users_rows: 3,
  price_sell_users_rows: 3,
  ...extra,
});
const PRICES = [
  row("Buy Fresh", { price_buy: 100, game_version: "4.10.2", date_modified: ago(2 * HOUR) }),
  row("Buy Old Patch", { price_buy: 90, game_version: "4.8.3", date_modified: ago(60 * DAY) }),
  row("Buy Undated", { price_buy: 120, game_version: "4.10.2" }),
  row("Sell Mid", { price_sell: 500, game_version: "4.10.2", date_modified: ago(1 * DAY) }),
  row("Sell Best", { price_sell: 900, game_version: "4.10.2", date_modified: ago(3 * DAY) }),
  row("Sell Old Patch", { price_sell: 950, game_version: "4.8.3", date_modified: ago(50 * DAY) }),
  row("Nothing Here", { game_version: "4.10.2", date_modified: ago(HOUR) }),
];

let counter = 0;
function fakeUex(routes: Record<string, unknown>) {
  const get = vi.fn(async (url: string) => {
    if (!(url in routes)) throw new Error(`fake uex: no route for ${url}`);
    return { data: routes[url] };
  });
  return { defaults: { baseURL: `https://fresh-${++counter}.test` }, get } as unknown as HttpClient;
}
const empty = () =>
  ({
    defaults: { baseURL: `https://empty-${++counter}.test` },
    get: async () => ({ data: {} }),
  }) as unknown as HttpClient;

function world(uexRoutes: Record<string, unknown>, scmdb?: Scmdb) {
  const e = empty();
  return createRegistry(
    allTools({
      uexClient: fakeUex(uexRoutes),
      scwClient: e,
      sctClient: e,
      scmdb: scmdb ?? new Scmdb({ raw: e, api: e, repo: "o/r", cacheDir: () => "unused" }),
      gameLog: new GameLog({}),
      fleet: new FleetStore("unused-fleet.json"),
    }),
    {},
    { now: () => NOW, gameVersionFor: async () => "4.10.2" },
  );
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const names = (rows: { terminal_name: string }[]) => rows.map((r) => r.terminal_name);
const live = { "/game_versions": { data: { live: "4.10.2", ptu: null } } };

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: UEX prices say which patch they are from and how old they are", () => {
  describe("Scenario: rows from an old patch are mixed with current ones", () => {
    it("Given 4.8.3 and 4.10.2 rows, When I ask, Then the old ones are left out and counted with their version", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: PRICES } });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(names(data.buy_locations.rows)).not.toContain("Buy Old Patch");
      expect(names(data.sell_locations.rows)).not.toContain("Sell Old Patch");
      expect(data.excluded_older_version).toMatchObject({
        count: 2,
        versions: { "4.8.3": 2 },
      });
      expect(data.excluded_older_version.note).toMatch(/include_older_versions/);
      expect(data.game_version_reference).toMatchObject({ version: "4.10.2" });
    });

    it("Given the same rows, When I ask for older versions too, Then they come back and the count says they are included", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: PRICES } });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", {
          commodity_name: "RMC",
          include_older_versions: true,
        }),
      );
      expect(names(data.buy_locations.rows)).toContain("Buy Old Patch");
      expect(data.excluded_older_version.count).toBe(0);
      expect(data.excluded_older_version.note).toMatch(/INCLUDED/);
    });

    it("Given 4.10 is newer than 4.8, Then versions are compared as numbers, not as text", async () => {
      const registry = world({
        ...live,
        "/commodities_prices": {
          data: [
            row("New", { price_buy: 1, game_version: "4.10.2" }),
            row("Old", { price_buy: 2, game_version: "4.9.0" }),
          ],
        },
      });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(names(data.buy_locations.rows)).toEqual(["New"]);
      expect(data.excluded_older_version.versions).toEqual({ "4.9.0": 1 });
    });

    it("Given UEX cannot say which version is LIVE, Then nothing is excluded and the answer says so", async () => {
      const registry = world({
        "/commodities_prices": {
          data: [
            row("Live row", { price_buy: 100, game_version: "4.10.2" }),
            row("Ptu row", { price_buy: 90, game_version: "4.10.3" }),
          ],
        },
      }); // no /game_versions
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(data.excluded_older_version.count).toBe(0);
      expect(names(data.buy_locations.rows)).toEqual(["Ptu row", "Live row"]);
      expect(data.game_version_reference).toMatchObject({
        version: null,
        versions_in_rows: { "4.10.2": 1, "4.10.3": 1 },
      });
      expect(data.game_version_reference.source).toMatch(/no row was excluded/);
    });

    it("Given a PTU row newer than LIVE, Then it is kept but counted apart, never silently mixed in", async () => {
      const registry = world({
        ...live,
        "/commodities_prices": {
          data: [
            row("Live row", { price_buy: 100, game_version: "4.10.2" }),
            row("Ptu row", { price_buy: 90, game_version: "4.10.3" }),
          ],
        },
      });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(names(data.buy_locations.rows)).toEqual(["Ptu row", "Live row"]);
      expect(data.newer_than_live).toMatchObject({ count: 1, versions: { "4.10.3": 1 } });
      expect(data.excluded_older_version.count).toBe(0);
    });

    it("Given a short version '4.10' against LIVE 4.10.2, Then it is not known to be old and is kept", async () => {
      const registry = world({
        ...live,
        "/commodities_prices": {
          data: [
            row("Short", { price_buy: 1, game_version: "4.10" }),
            row("Older", { price_buy: 2, game_version: "4.9" }),
          ],
        },
      });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(names(data.buy_locations.rows)).toEqual(["Short"]);
      expect(data.excluded_older_version.versions).toEqual({ "4.9": 1 });
    });

    it("Given a row with no version, Then it is kept: it cannot be shown to be old", async () => {
      const registry = world({
        ...live,
        "/commodities_prices": { data: [row("Unversioned", { price_buy: 5 })] },
      });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(names(data.buy_locations.rows)).toEqual(["Unversioned"]);
    });
  });

  describe("Scenario: I want to know how old the prices really are", () => {
    it("Given rows modified 2 hours to 3 days ago, Then data_age is the real age, cache_age the fetch, and each row has updated_at", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: PRICES } });
      const { provenance, data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(provenance.data_age).toBe("3d");
      expect(provenance.data_date).toBe(new Date(NOW - 3 * DAY).toISOString());
      expect(provenance.data_age_note).toMatch(/date_modified/);
      expect(provenance.data_age_note).toMatch(/1 without a date/);
      expect(provenance.cache_age).toBe("0s");
      const best = data.sell_locations.rows[0];
      expect(best).toMatchObject({
        terminal_name: "Sell Best",
        updated_at: new Date(NOW - 3 * DAY).toISOString(),
      });
      expect(data.buy_locations.rows.at(-1).updated_at).toBeNull(); // undated stays visibly undated
    });

    it("Given rows with no date at all, Then data_age is null with the reason, never the fetch age", async () => {
      const registry = world({
        ...live,
        // date_added is set (the row's creation, 2023) but there is no date_modified
        "/commodities_prices": { data: [row("Undated", { price_buy: 5, game_version: "4.10.2" })] },
      });
      const { provenance } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(provenance.data_age).toBeNull();
      expect(provenance).not.toHaveProperty("data_date");
      expect(provenance.data_age_note).toMatch(/no price date \(date_modified\)/);
      expect(provenance.cache_age).toBe("0s");
    });

    it("Given a tool whose source gives no date (UEX terminals), Then data_age is null and says why", async () => {
      const registry = world({
        "/terminals": { data: [{ name: "T", star_system_name: "Stanton" }] },
      });
      const { provenance } = body(await registry.call("uex_get_terminals", {}));
      expect(provenance.data_age).toBeNull();
      expect(provenance.data_age_note).toMatch(/reads no date/);
    });
  });

  describe("Scenario: the answer is huge and mixes buying and selling", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row(`T${i}`, { price_buy: 100 + i, price_sell: 1000 - i, game_version: "4.10.2" }),
    );

    it("Given 40 terminals, When I give no limit, Then each list holds 15 rows, cheapest buy and best sell first, with totals", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: many } });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", { commodity_name: "RMC" }),
      );
      expect(data.rows_from_uex).toBe(40);
      expect(data.buy_locations).toMatchObject({ total: 40, shown: 15 });
      expect(data.sell_locations).toMatchObject({ total: 40, shown: 15 });
      expect(names(data.buy_locations.rows).slice(0, 2)).toEqual(["T0", "T1"]);
      expect(names(data.sell_locations.rows).slice(0, 2)).toEqual(["T0", "T1"]);
      expect(data.buy_locations.sorted_by).toMatch(/cheapest first/);
    });

    it("Given wide real-sized rows and the largest limit on both sides, Then the answer is still complete JSON, not a 'too large' error", async () => {
      const wide = Array.from({ length: 120 }, (_, i) => ({
        ...row(`Terminal number ${i} of the Stanton system`, {
          price_buy: 100 + i,
          price_sell: 1000 - i,
          game_version: "4.10.2",
          date_modified: ago(HOUR),
        }),
        ...Object.fromEntries(
          Array.from({ length: 22 }, (_, k) => [`field_${k}_name`, `some plausible string ${k}`]),
        ),
      }));
      const registry = world({ ...live, "/commodities_prices": { data: wide } });
      const result = await registry.call("uex_get_commodity_prices", {
        commodity_name: "RMC",
        limit: 9999,
      });
      const { data } = body(result);
      expect(data.error).toBeUndefined();
      expect(data.note).toMatch(/to fit the output size/);
      expect(data.buy_locations.shown).toBeGreaterThan(5);
      expect(data.buy_locations.total).toBe(120);
    });

    it("Given side = sell and a limit of 3, Then only the sell list comes back, 3 rows, best price first", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: PRICES } });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", {
          commodity_name: "RMC",
          side: "sell",
          limit: 3,
        }),
      );
      expect(data).not.toHaveProperty("buy_locations");
      expect(names(data.sell_locations.rows)).toEqual(["Sell Best", "Sell Mid"]);
      expect(data.sell_locations).toMatchObject({ total: 2, shown: 2 });
    });

    it("Given side = buy and a limit of 1, Then the total still says how many more there are", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: many } });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", {
          commodity_name: "RMC",
          side: "buy",
          limit: 1,
        }),
      );
      expect(data).not.toHaveProperty("sell_locations");
      expect(data.buy_locations).toMatchObject({ total: 40, shown: 1 });
    });

    it("Given a location filter, Then it applies before the lists are built", async () => {
      const registry = world({
        ...live,
        "/commodities_prices": {
          data: [
            row("Here", { price_buy: 1, game_version: "4.10.2" }),
            { ...row("There", { price_buy: 1, game_version: "4.10.2" }), star_system_name: "Pyro" },
          ],
        },
      });
      const { data } = body(
        await registry.call("uex_get_commodity_prices", {
          commodity_name: "RMC",
          star_system_name: "Stanton",
        }),
      );
      expect(data.rows_from_uex).toBe(1);
    });

    it("Given bad input, Then it is refused", async () => {
      const registry = world({ ...live, "/commodities_prices": { data: [] } });
      const r = await registry.call("uex_get_commodity_prices", {
        commodity_name: "RMC",
        side: "both-ways",
      });
      expect(r.isError).toBe(true);
    });
  });
});

describe("Feature: trade routes built on estimates do not top the list", () => {
  const route = (name: string, perScu: number, o: number, d: number, extra = {}) => ({
    commodity_name: "Laranite",
    origin_terminal_name: name,
    destination_terminal_name: "Rest Stop",
    price_origin: 100,
    price_destination: 100 + perScu,
    scu_reachable: 1000,
    date_added: ago(8 * 60_000), // UEX recalculated the route 8 minutes ago; no date_modified
    price_origin_users_rows: o,
    price_destination_users_rows: d,
    ...extra,
  });
  const ROUTES = [
    route("Invented", 900, 0, 0),
    route("Half", 500, 2, 0),
    route("Reported", 100, 5, 3),
  ];
  const routesWorld = () =>
    world({
      "/commodities": { data: [{ id: 79, name: "Laranite" }] },
      "/commodities_routes": { data: ROUTES },
    });
  const origins = (rs: { origin: { terminal: string } }[]) => rs.map((r) => r.origin.terminal);

  it("Given an estimate that pays 9x more, When I list routes, Then reported routes come first and estimates are flagged", async () => {
    const { data } = body(
      await routesWorld().call("uex_get_trade_routes", { commodity_name: "Laranite" }),
    );
    expect(origins(data.routes)).toEqual(["Reported", "Invented", "Half"]);
    expect(data.routes.map((r: { is_estimate: boolean }) => r.is_estimate)).toEqual([
      false,
      true,
      true,
    ]);
    expect(data.routes[2].estimated_sides).toEqual(["destination"]);
    expect(data.routes[1].estimated_sides).toEqual(["origin", "destination"]);
    expect(data.estimates_among_all_routes).toBe(2);
    expect(data.sorted_by).toMatch(/estimate/);
  });

  it("Given min_reports = 1, Then routes with no report at either end are dropped and counted", async () => {
    const { data } = body(
      await routesWorld().call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        min_reports: 1,
      }),
    );
    expect(origins(data.routes)).toEqual(["Reported"]);
    expect(data).toMatchObject({ total_routes: 3, excluded_below_min_reports: 2, min_reports: 1 });
  });

  it("Given min_reports = 4, Then the destination's 3 reports are not enough", async () => {
    const { data } = body(
      await routesWorld().call("uex_get_trade_routes", {
        commodity_name: "Laranite",
        min_reports: 4,
      }),
    );
    expect(data.routes).toEqual([]);
    expect(data.excluded_below_min_reports).toBe(3);
  });

  it("Given the default, Then nothing is excluded (backward compatible) and a negative minimum is refused", async () => {
    const registry = routesWorld();
    const { data } = body(
      await registry.call("uex_get_trade_routes", { commodity_name: "Laranite" }),
    );
    expect(data.excluded_below_min_reports).toBe(0);
    const bad = await registry.call("uex_get_trade_routes", {
      commodity_name: "Laranite",
      min_reports: -1,
    });
    expect(bad.isError).toBe(true);
  });

  it("Given real routes (date_added = recalculation time, no date_modified), Then data_age is null, not '8m', and says why", async () => {
    const { data, provenance } = body(
      await routesWorld().call("uex_get_trade_routes", { commodity_name: "Laranite" }),
    );
    expect(provenance.data_age).toBeNull();
    expect(provenance).not.toHaveProperty("data_date");
    expect(provenance.data_age_note).toMatch(/no price date \(date_modified\)/);
    expect(provenance.data_age_note).toMatch(/recalculated/);
    expect(data.routes[0]).not.toHaveProperty("updated_at");
  });
});

describe("Feature: terminals that only carry a UEX estimate do not top the price lists", () => {
  it("Given an estimated 7200 sell price and a reported 900, Then the reported row is first and the estimate is flagged", async () => {
    const registry = world({
      ...live,
      "/commodities_prices": {
        data: [
          row("Estimate", { price_sell: 7200, price_sell_users_rows: 0, game_version: "4.10.2" }),
          row("Reported", {
            price_sell: 900,
            price_sell_users_rows: 4,
            game_version: "4.10.2",
            date_modified: ago(HOUR),
          }),
        ],
      },
    });
    const { data } = body(
      await registry.call("uex_get_commodity_prices", { commodity_name: "RMC", side: "sell" }),
    );
    expect(names(data.sell_locations.rows)).toEqual(["Reported", "Estimate"]);
    expect(data.sell_locations.rows.map((r: { is_estimate: boolean }) => r.is_estimate)).toEqual([
      false,
      true,
    ]);
    expect(data.sell_locations.estimates).toBe(1);
    expect(data.sell_locations.sorted_by).toMatch(/before UEX estimates/);
  });
});

describe("Feature: SCMDB says how old the channel's data is, not when it was downloaded", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmdb-age-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("Given a LIVE channel dated 13 October and a manifest regenerated today, Then data_age counts from 13 October", async () => {
    const manifest = {
      schema: 2,
      generated_at: "2026-11-03T09:00:00Z",
      channels: {
        live: {
          version: "9.9.1-live.111",
          generated_at: "2026-10-13T00:00:00Z",
          files: { merged: "merged.json" },
        },
      },
    };
    const files: Record<string, unknown> = {
      "latest.json": manifest,
      "merged.json": { contracts: [], locationPools: {}, blueprintPools: {} },
    };
    const raw = {
      defaults: { baseURL: `https://raw-age-${++counter}.test` },
      get: vi.fn(async (url: string) => ({ data: files[url.split("/").pop()!] })),
    } as unknown as HttpClient;
    const api = {
      defaults: {},
      get: vi.fn(async () => ({ data: "c".repeat(40) })),
    } as unknown as HttpClient;
    const scmdb = new Scmdb({ raw, api, repo: "o/r", cacheDir: () => dir });
    const { provenance } = body(await world({}, scmdb).call("scmdb_search_missions", {}));
    expect(provenance.data_age).toBe("21d");
    expect(provenance.data_date).toBe("2026-10-13T00:00:00.000Z");
    expect(provenance.data_age_note).toMatch(/SCMDB LIVE channel generated_at/);
    expect(provenance.cache_age).not.toBe("21d");
  });
});
