import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { allTools, createRegistry, type ToolClients } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * A client that answers from a table and records what it was asked. No network.
 * Each fake gets its own baseURL because the response cache is keyed on it.
 */
let fakeCounter = 0;
function fakeClient(routes: Record<string, unknown | ((params: unknown) => unknown)>) {
  const get = vi.fn(async (url: string, config?: { params?: unknown }) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`fake client: no route for ${url}`);
    return { data: typeof route === "function" ? route(config?.params) : route };
  });
  const client = {
    defaults: { baseURL: `https://fake-${++fakeCounter}.test` },
    get,
  } as unknown as HttpClient;
  return { client, get };
}

function clientsWith(overrides: Partial<ToolClients> = {}): ToolClients {
  const empty = fakeClient({}).client;
  return { uexClient: empty, scwClient: empty, sctClient: empty, ...overrides };
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;

beforeEach(() => clearCache());

describe("tool list (non-regression against the upstream 1.5.0 surface)", () => {
  const golden = JSON.parse(
    fs.readFileSync(new URL("./tools-list.golden.json", import.meta.url), "utf8"),
  ) as { name: string; description: string; inputSchema: unknown }[];

  it("advertises exactly the same names, descriptions and schemas", () => {
    const listed = createRegistry(allTools(clientsWith()), null)
      .list()
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(listed).toEqual(golden);
  });

  it("has 29 tools with unique names", () => {
    const names = allTools(clientsWith()).map((t) => t.name);
    expect(names).toHaveLength(29);
    expect(new Set(names).size).toBe(29);
  });

  it("never leaks handlers into the listing", () => {
    for (const tool of createRegistry(allTools(clientsWith()), null).list()) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
  });
});

describe("createRegistry", () => {
  const tools = allTools(clientsWith());

  it("scopes the listing to the enabled tools (SCMCP_TOOLS)", () => {
    const registry = createRegistry(tools, new Set(["uex_get_commodities", "sct_search"]));
    expect(
      registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["sct_search", "uex_get_commodities"]);
  });

  it("does not block calls to tools that are not advertised (latency scoping, not access control)", async () => {
    const { client } = fakeClient({ "/game_versions": { data: { live: "4.10.2", ptu: null } } });
    const registry = createRegistry(
      allTools(clientsWith({ uexClient: client })),
      new Set(["sct_search"]),
    );
    const result = await registry.call("uex_get_game_versions", {});
    expect(result.isError).toBeUndefined();
  });

  it("returns an error result, not an exception, for an unknown tool", async () => {
    const result = await createRegistry(tools, null).call("nope", {});
    expect(result.isError).toBe(true);
    expect(text(result as never)).toBe("Error: Unknown tool: nope");
  });

  it("returns an error result for arguments that fail validation", async () => {
    const result = await createRegistry(tools, null).call("uex_get_commodity_prices", {});
    expect(result.isError).toBe(true);
    expect(text(result as never)).toMatch(/commodity_name/);
  });

  it("refuses two tools with the same name", () => {
    const dup: ToolDefinition = { ...tools[0] };
    expect(() => createRegistry([tools[0], dup], null)).toThrow(/Duplicate tool name/);
  });

  it("appends the HTTP error body when an upstream call fails", async () => {
    const failing = {
      defaults: { baseURL: "https://fake-failing.test" },
      get: async () => {
        throw Object.assign(new Error("Request failed with status code 401"), {
          response: { data: { message: "bad token" } },
        });
      },
    } as unknown as HttpClient;
    const result = await createRegistry(allTools(clientsWith({ uexClient: failing })), null).call(
      "uex_get_commodities",
      {},
    );
    expect(result.isError).toBe(true);
    expect(text(result as never)).toBe(
      'Error: Request failed with status code 401\nDetails: {"message":"bad token"}',
    );
  });
});

describe("handlers keep their behavior after the split", () => {
  it("uex_get_game_versions says so explicitly when no PTU is up", async () => {
    const { client } = fakeClient({ "/game_versions": { data: { live: "4.10.2", ptu: null } } });
    const result = await createRegistry(allTools(clientsWith({ uexClient: client })), null).call(
      "uex_get_game_versions",
      {},
    );
    expect(JSON.parse(text(result as never))).toEqual({
      live: "4.10.2",
      ptu: "no active PTU build",
    });
  });

  it("uex_get_ship_prices resolves the name to an id first, then filters by id_vehicle", async () => {
    const { client, get } = fakeClient({
      "/vehicles": { data: [{ id: 7, name: "Cutlass Black", name_full: "Drake Cutlass Black" }] },
      "/vehicles_purchases_prices": {
        data: [{ star_system_name: "Stanton", terminal_name: "Teasa Spaceport", price_buy: 1 }],
      },
      "/vehicles_rentals_prices": { data: [] },
    });
    const result = await createRegistry(allTools(clientsWith({ uexClient: client })), null).call(
      "uex_get_ship_prices",
      { vehicle_name: "cutlass black" },
    );
    const body = JSON.parse(text(result as never));
    // Not asserting body.id_vehicle: formatOutput strips every "id_*" key (upstream behavior).
    expect(body.vehicle).toBe("Drake Cutlass Black");
    expect(body.purchase_locations).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/vehicles_purchases_prices", { params: { id_vehicle: 7 } });
  });

  it("uex_get_ship_prices reports an unknown ship instead of guessing", async () => {
    const { client } = fakeClient({ "/vehicles": { data: [{ id: 1, name: "Aurora" }] } });
    const result = await createRegistry(allTools(clientsWith({ uexClient: client })), null).call(
      "uex_get_ship_prices",
      { vehicle_name: "Zzzz" },
    );
    expect(text(result as never)).toContain("No vehicle matched");
  });

  it("uex_search_marketplace filters client-side and honours the limit", async () => {
    const { client } = fakeClient({
      "/marketplace_listings": {
        data: [
          { title: "Selling Laranite", type: "item" },
          { title: "Laranite hauling contract", type: "contract" },
          { title: "Gold wanted", type: "item" },
        ],
      },
    });
    const registry = createRegistry(allTools(clientsWith({ uexClient: client })), null);
    const all = JSON.parse(
      text((await registry.call("uex_search_marketplace", { query: "laranite" })) as never),
    );
    expect(all).toHaveLength(2);
    const limited = JSON.parse(
      text(
        (await registry.call("uex_search_marketplace", { query: "laranite", limit: 1 })) as never,
      ),
    );
    expect(limited).toHaveLength(1);
  });

  it("scw_list_vehicles uses bracketed paging parameters and caps the page size at 50", async () => {
    const { client, get } = fakeClient({
      "/vehicles": {
        data: [{ name: "Aurora MR", manufacturer: { name: "RSI" } }],
        meta: { total: 1 },
      },
    });
    await createRegistry(allTools(clientsWith({ scwClient: client })), null).call(
      "scw_list_vehicles",
      { per_page: 500, role: "Medical" },
    );
    expect(get).toHaveBeenCalledWith("/vehicles", {
      params: { "page[number]": 1, "page[size]": 50, "filter[role]": "Medical" },
    });
  });

  it("sct_get_article returns the article text, or says it was not found", async () => {
    const pages = vi.fn((params: unknown) =>
      (params as { titles: string }).titles === "Wikelo"
        ? { query: { pages: { "123": { extract: "Wikelo is a trader." } } } }
        : { query: { pages: { "-1": { missing: "" } } } },
    );
    const { client } = fakeClient({ "/api.php": pages });
    const registry = createRegistry(allTools(clientsWith({ sctClient: client })), null);
    expect(text((await registry.call("sct_get_article", { title: "Wikelo" })) as never)).toBe(
      "Wikelo is a trader.",
    );
    expect(text((await registry.call("sct_get_article", { title: "Nope" })) as never)).toBe(
      "Article not found.",
    );
  });

  it("caches repeated reads for a few minutes", async () => {
    const { client, get } = fakeClient({ "/commodities": { data: [{ name: "Gold" }] } });
    const registry = createRegistry(allTools(clientsWith({ uexClient: client })), null);
    await registry.call("uex_get_commodities", {});
    await registry.call("uex_get_commodities", {});
    expect(get).toHaveBeenCalledTimes(1);
  });
});
