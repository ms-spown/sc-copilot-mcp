import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import { MAX_OUTPUT_CHARS } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { compareAttributes } from "../providers/uex/items.js";
import { isBundle, priceCheck, averageViews } from "../providers/uex/marketplace.js";
import { groupOres, rankOres } from "../providers/uex/refining.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools, createRegistry } from "./registry.js";
import { OUTPUT_BUDGET } from "./uexBounds.js";
import type { ToolResult } from "./types.js";

/**
 * Feature: the commerce tools bound their own output (under the repo limit, with a `truncated` note and
 * counts), at the maximum parameters and with large synthetic answers; unit and ranking edge cases.
 */

const DAY = 86_400_000;
const ago = (days: number) => Math.floor((Date.now() - days * DAY) / 1000);
const ok = (data: unknown) => ({ status: "ok", http_code: 200, data, message: "" });
const long = (label: string, n: number) => `${label} ${"x".repeat(n)}`;

type Route = unknown | ((params: Record<string, unknown>) => unknown);
let counter = 0;
function fakeUex(routes: Record<string, Route>) {
  const calls: string[] = [];
  const client = {
    defaults: { baseURL: `https://bounds-${++counter}.test` },
    get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
      calls.push(url);
      if (!(url in routes)) throw new Error(`fake uex: no route for ${url}`);
      const route = routes[url];
      return { data: typeof route === "function" ? route(config?.params ?? {}) : route };
    }),
  } as unknown as HttpClient;
  return { client, calls };
}
function registryFor(client: HttpClient) {
  const empty = fakeUex({}).client;
  return createRegistry(
    allTools({
      uexClient: client,
      scwClient: empty,
      sctClient: empty,
      scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
      gameLog: new GameLog({}),
      fleet: new FleetStore("unused-fleet.json"),
    }),
  );
}
const body = (r: ToolResult) => JSON.parse(r.content[0].text);

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: every answer fits the output limit, and says what was cut", () => {
  it("Given uex_get_item_prices at its maximum parameters on a huge catalogue, Then the whole answer is under the limit and the request count is bounded", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      id_category: 22,
      name: `Mega ${i}`,
      company_name: "Maker",
      size: "1",
      category: "Quantum Drives",
      section: "Systems",
    }));
    const priceRows = (id: number) =>
      Array.from({ length: 90 }, (_, i) => ({
        id_item: id,
        terminal_name: long(`Terminal ${i}`, 90),
        star_system_name: "Stanton",
        planet_name: long("Planet", 60),
        city_name: long("City", 60),
        price_buy: 1000 + i,
        price_sell: 500 + i,
        game_version: "4.10.0",
        date_modified: ago(i),
      }));
    const attrs = (id: number) =>
      Array.from({ length: 40 }, (_, i) => ({
        id_item: id,
        attribute_name: `Attribute ${i}`,
        value: String(i),
        unit: "kg",
      }));
    const { client, calls } = fakeUex({
      "/categories": ok([{ id: 22, type: "item", section: "Systems", name: "Quantum Drives" }]),
      "/game_versions": ok({ live: "4.10.2" }),
      "/items": ok(items),
      "/items_prices": (p: Record<string, unknown>) => ok(priceRows(Number(p.id_item))),
      "/items_attributes": (p: Record<string, unknown>) => ok(attrs(Number(p.id_item))),
    });
    const result = await registryFor(client).call("uex_get_item_prices", {
      item_name: "mega",
      category: "Quantum Drives",
      limit: 8,
      locations: 25,
      with_attributes: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const { data } = body(result);
    expect(data.truncated).toMatch(/Cut to fit the output size/);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    expect(data.matched).toBe(12);
    // limit 8 is capped at 4 items: categories + items + game versions + 4 x (prices + attributes).
    expect(data.priced).toBe(4);
    expect(calls.length).toBeLessThanOrEqual(11);
  });

  it("Given uex_compare_items with 300 attributes each, Then the answer is cut to fit and says so", async () => {
    const mk = (id: number, name: string) => ({
      id,
      id_category: 22,
      name,
      company_name: "Maker",
      size: "1",
      category: "Quantum Drives",
    });
    const attrs = Array.from({ length: 300 }, (_, i) => ({
      attribute_name: `Attribute number ${i} ${"y".repeat(60)}`,
      value: String(i),
      unit: "kg",
    }));
    const { client } = fakeUex({
      "/categories": ok([{ id: 22, type: "item", section: "Systems", name: "Quantum Drives" }]),
      "/game_versions": ok({ live: "4.10.2" }),
      "/items": ok([mk(1, "Alpha"), mk(2, "Beta")]),
      "/items_prices": ok([]),
      "/items_attributes": ok(attrs),
    });
    const result = await registryFor(client).call("uex_compare_items", {
      item_a: "Alpha",
      item_b: "Beta",
      category: "Quantum Drives",
    });
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const { data } = body(result);
    expect(data.truncated).toMatch(/of 300 attributes/);
    expect(data.attributes.length).toBeGreaterThanOrEqual(1);
  });

  it("Given uex_get_marketplace_prices asked for 50 items with very long names, Then the list is cut to fit", async () => {
    const trend = (i: number) => ({
      id_item: i,
      item_name: long(`Item ${i}`, 180),
      currency: "UEC",
      price_avg_sell: "100",
      price_avg_month_sell: "100",
      price_min_sell: "1",
      price_max_sell: "1000",
      listings_count_sell: 5,
      negotiations_count: 1000 - i,
    });
    const { client } = fakeUex({
      "/marketplace_trends": ok(Array.from({ length: 500 }, (_, i) => trend(i))),
    });
    const result = await registryFor(client).call("uex_get_marketplace_prices", { limit: 50 });
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const { data } = body(result);
    expect(data.truncated).toMatch(/of the 50 items asked for/);
    expect(data.items.length).toBeLessThan(50);
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  it("Given uex_get_marketplace_prices on an item with hundreds of average lines and history groups, Then both are cut together", async () => {
    const averages = Array.from({ length: 400 }, (_, i) => ({
      id_item: 7,
      item_name: "Many",
      operation: i % 2 ? "buy" : "sell",
      unit: "unit",
      quality_tier: i,
      currency: "UEC",
      listings_count: 1,
      price_avg: "100",
      price_avg_week: "100",
      price_avg_month: "100",
      date_modified: ago(0.1),
    }));
    const history = Array.from({ length: 400 }, (_, i) => ({
      operation: "sell",
      unit: "unit",
      quality_tier: i,
      price: "100",
      date_added: ago(1),
    }));
    const { client } = fakeUex({
      "/marketplace_trends": ok([{ id_item: 7, item_name: "Many", currency: "UEC" }]),
      "/marketplace_prices_averages": ok(averages),
      "/marketplace_prices_history": ok(history),
    });
    const result = await registryFor(client).call("uex_get_marketplace_prices", {
      id_item: 7,
      include_history: true,
    });
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const { data } = body(result);
    expect(data.truncated).toMatch(/average lines/);
    expect(data.averages.length).toBeLessThan(400);
  });

  it("Given 30 ores each tied at the best bonus in 30 refineries with long names, Then the ranking fits and tied refineries are counted, not all listed", async () => {
    const commodities = Array.from({ length: 30 }, (_, i) => [
      { id: 1000 + i, id_parent: 2000 + i, name: long(`Ore ${i} (Raw)`, 100), is_raw: 1 },
      {
        id: 2000 + i,
        id_parent: 1000 + i,
        name: long(`Refined ${i}`, 100),
        is_refined: 1,
        price_sell: 1000 + i,
      },
    ]).flat();
    const yields = Array.from({ length: 30 }, (_, o) =>
      Array.from({ length: 30 }, (_, t) => ({
        id_commodity: 1000 + o,
        id_terminal: t,
        terminal_name: long(`Refinery ${t}`, 100),
        star_system_name: "Stanton",
        value: 5,
        date_modified: ago(3),
      })),
    ).flat();
    const { client } = fakeUex({
      "/refineries_yields": ok(yields),
      "/commodities": ok(commodities),
      "/commodities_raw_prices_all": ok([]),
    });
    const result = await registryFor(client).call("uex_get_refining_margins", { limit: 30 });
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const { data } = body(result);
    expect(data.ores[0].best_refineries.length).toBeLessThanOrEqual(5);
    expect(data.ores[0].best_refineries_total).toBe(30);
    expect(OUTPUT_BUDGET).toBeLessThan(MAX_OUTPUT_CHARS);
  });
});

describe("Feature: a price is only called per-unit when UEX says so", () => {
  const row = (extra: Record<string, unknown>) => ({
    operation: "sell",
    quality_tier: 0,
    currency: "UEC",
    listings_count: 3,
    price_avg: "1000",
    price_avg_week: "1000",
    price_avg_month: "1000",
    date_modified: ago(1),
    ...extra,
  });

  it("Given a missing or empty unit, Then the line is unknown (null), not a bundle and not per-unit", () => {
    expect(isBundle(undefined)).toBeNull();
    expect(isBundle("")).toBeNull();
    expect(isBundle("  ")).toBeNull();
    expect(isBundle("unit")).toBe(false);
    expect(isBundle("set")).toBe(true);
    const views = averageViews([row({ unit: "" }), row({})], Date.now());
    expect(views.map((v) => v.bundle)).toEqual([null, null]);
    expect(views[0].unit).toBe("not stated by UEX");
  });

  it("Given only lines without a stated unit, Then price_check is unavailable", () => {
    const views = averageViews([row({ unit: "" })], Date.now());
    expect(priceCheck(views, 1500, "sell", 0)).toMatchObject({
      unavailable: expect.stringMatching(/stated per unit/),
    });
  });

  it("Given a month average of 0, Then price_check says it used the current average", () => {
    const views = averageViews([row({ unit: "unit", price_avg_month: "0" })], Date.now());
    const check = priceCheck(views, 1500, "sell", 0);
    expect(check).toMatchObject({ against: "price_avg", average: 1000, difference_percent: 50 });
    expect((check as { warnings: string[] }).warnings.join(" ")).toMatch(/no month average/);
  });

  it("Given a line with no advert now and an old date, Then price_check warns about both", () => {
    const views = averageViews(
      [row({ unit: "unit", listings_count: 0, date_modified: ago(90) })],
      Date.now(),
    );
    const warnings = (priceCheck(views, 900, "sell", 0) as { warnings: string[] }).warnings;
    expect(warnings.join(" ")).toMatch(/history, not an offer/);
    expect(warnings.join(" ")).toMatch(/90\.?\d* days ago/);
  });

  it("Given a line with adverts and one without, Then the line with adverts is used", () => {
    const views = averageViews(
      [
        row({ unit: "unit", listings_count: 0, price_avg_month: "5000" }),
        row({ unit: "unit", listings_count: 4, price_avg_month: "1000" }),
      ],
      Date.now(),
    );
    expect(priceCheck(views, 1000, "sell", 0)).toMatchObject({ average: 1000 });
  });
});

describe("Feature: the ore ranking shows how old the report behind each rank is", () => {
  it("Given a best bonus reported 100 days ago, Then the ore row is stale and carries its age", () => {
    const commodities = [
      { id: 1, id_parent: 2, name: "Old Ore (Raw)", is_raw: 1 },
      { id: 2, id_parent: 1, name: "Old", is_refined: 1, price_sell: 100 },
      { id: 3, id_parent: 4, name: "Fresh Ore (Raw)", is_raw: 1 },
      { id: 4, id_parent: 3, name: "Fresh", is_refined: 1, price_sell: 100 },
    ];
    const y = (ore: number, t: number, value: number, days: number) => ({
      id_commodity: ore,
      id_terminal: t,
      terminal_name: `R${t}`,
      value,
      date_modified: ago(days),
    });
    const ores = groupOres(
      [y(1, 1, 9, 100), y(1, 2, 1, 2), y(3, 1, 5, 2), y(3, 2, 5, 40)],
      commodities,
    );
    const { ranked } = rankOres(ores, [], Date.now());
    const old = ranked.find((r) => r.ore === "Old Ore (Raw)")!;
    const fresh = ranked.find((r) => r.ore === "Fresh Ore (Raw)")!;
    expect(old.stale).toBe(true);
    expect(old.best_report_age_days).toBeGreaterThan(99);
    // Two reports at the best bonus: the freshest decides.
    expect(fresh.stale).toBe(false);
    expect(fresh.best_report_age_days).toBeLessThan(3);
  });
});

describe("Feature: the attribute comparison does not hide or distort", () => {
  const view = (attribute: string, value: number | string, unit: string | null = null) => ({
    attribute,
    value,
    unit,
  });

  it("Given an attribute listed twice on one item, Then it is flagged and not compared", () => {
    const rows = compareAttributes(
      [view("Damage", 10, "hp"), view("Damage", 99, "hp")],
      [view("Damage", 20, "hp")],
    );
    expect(rows[0]).toMatchObject({
      attribute: "Damage",
      repeated_in: ["a"],
      difference: null,
      difference_percent: null,
      a: { value: 10 },
    });
  });

  it("Given a negative first value, Then a rise shows a positive percent", () => {
    const [row] = compareAttributes([view("Heat", -10)], [view("Heat", -5)]);
    expect(row.difference).toBe(5);
    expect(row.difference_percent).toBe(50);
  });

  it("Given a tiny difference, Then the percent comes from the rounded difference so the two agree", () => {
    const [row] = compareAttributes([view("Mass", 1000)], [view("Mass", 1000.0004)]);
    expect(row.difference).toBe(0);
    expect(row.difference_percent).toBe(0);
  });
});

describe("Feature: an unknown category is a bounded answer, not a cut error", () => {
  const categories = [
    ...Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      type: "item",
      section: "S",
      name: `Category number ${i}`,
    })),
    { id: 99, type: "service", section: "S", name: "Hauling" },
  ];

  it("Given a wrong category, Then every item category is listed in `categories` (no service)", async () => {
    const { client } = fakeUex({ "/categories": ok(categories) });
    const result = await registryFor(client).call("uex_get_item_prices", {
      item_name: "x",
      category: "Spaceships",
    });
    expect(result.isError).toBeUndefined();
    const { data } = body(result);
    expect(data.categories).toHaveLength(40);
    expect(data.category_problem).toMatch(/No UEX item category/);
    expect(JSON.stringify(data)).not.toContain("Hauling");
    expect(result.content[0].text).not.toContain("[truncated");
  });

  it("Given uex_compare_items and a wrong category, Then the error names some categories and counts the rest", async () => {
    const { client } = fakeUex({ "/categories": ok(categories) });
    const result = await registryFor(client).call("uex_compare_items", {
      item_a: "a",
      item_b: "b",
      category: "Spaceships",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/and 30 more/);
  });
});
