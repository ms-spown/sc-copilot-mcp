/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { planTrips } from "../providers/uex/tripPlanner.js";
import { allTools, createRegistry } from "../tools/registry.js";
import {
  resolveOriginHint,
  suggestInputSchema,
  SUGGEST_MIN_INTERVAL_MS,
  TradeSuggestService,
  type FlownShip,
} from "./tradeSuggest.js";
import {
  tradeAgentMessage,
  tradeBuildRequest,
  tradeRecipeArgs,
  tradeRecipeText,
  tradeSuggestClean,
} from "./tradeActions.js";
import * as L from "./viewLogic.js";

/**
 * F9: the route card and the agent must find the SAME thing. The card's request goes to `sc_trade_suggest`; the message of
 * "Demander à l'agent" carries a recipe, a `uex_plan_trade` call. Here both run the real planner on one synthetic UEX market:
 * the recipe built from the card's request must give the card's first option, with its figures. No network, made-up data.
 */

const NOW = Date.now();
const DAY = 86_400_000;
const secs = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);
const env = (data: unknown) => ({ status: "ok", http_code: 200, data, message: "" });
const terminal = (id: number, nick: string, extra: Record<string, unknown>) => ({
  id,
  name: `${nick} full name`,
  nickname: nick,
  id_planet: 1,
  star_system_name: "Stanton",
  planet_name: "ArcCorp",
  id_star_system: 68,
  id_space_station: 0,
  id_city: 0,
  id_outpost: 0,
  ...extra,
});
const TERMINALS = [
  terminal(1, "ARC-L1", { id_orbit: 326, id_space_station: 1 }),
  terminal(2, "Area 18", { id_orbit: 4, id_city: 1 }),
  terminal(3, "Lorville", { id_orbit: 116, id_city: 2, planet_name: "Hurston", id_planet: 2 }),
  terminal(4, "Mining 056", { id_orbit: 4, id_outpost: 1 }),
  terminal(5, "Ruin Station", {
    id_orbit: 400,
    id_space_station: 9,
    id_star_system: 64,
    star_system_name: "Pyro",
    planet_name: "Pyro I",
    id_planet: 9,
  }),
  terminal(6, "Checkmate", {
    id_orbit: 401,
    id_space_station: 10,
    id_star_system: 64,
    star_system_name: "Pyro",
    planet_name: "Pyro I",
    id_planet: 9,
  }),
];
const arm = (id: number, is_armistice: number) => ({ id, is_armistice, jurisdiction_name: null });
const row = (commodity: number, terminalId: number, o: Record<string, unknown>, ageMs = DAY) => ({
  id_commodity: commodity,
  id_terminal: terminalId,
  commodity_name: ["", "", "", "", "", "", "", "", "", "", "Gold", "Laranite", "Cheap", "Silver"][
    commodity
  ],
  terminal_name: TERMINALS.find((t) => t.id === terminalId)?.nickname,
  price_buy: 0,
  price_sell: 0,
  scu_buy: 0,
  scu_sell_stock: 0,
  scu_sell: 0,
  status_buy: 0,
  status_sell: 0,
  date_modified: secs(ageMs),
  ...o,
});
const buy = (c: number, t: number, price: number, scu = 500) =>
  row(c, t, { price_buy: price, scu_buy: scu, status_buy: 4 });
const sell = (c: number, t: number, price: number, status = 3) =>
  row(c, t, { price_sell: price, status_sell: status });
const PRICES = [
  buy(10, 1, 100),
  sell(10, 2, 160),
  buy(11, 2, 50, 200),
  sell(11, 1, 90, 2),
  buy(13, 2, 30, 100),
  sell(13, 4, 50),
  buy(10, 5, 40),
  sell(10, 6, 300),
  buy(11, 6, 20),
  sell(11, 5, 200),
];
const REPORTS: Record<number, Record<number, { b: number; s: number }>> = {
  10: { 1: { b: 5, s: 0 }, 2: { b: 0, s: 3 }, 5: { b: 3, s: 0 }, 6: { b: 0, s: 2 } },
  11: { 2: { b: 3, s: 0 }, 1: { b: 0, s: 4 }, 6: { b: 1, s: 0 }, 5: { b: 0, s: 1 } },
  13: { 2: { b: 2, s: 0 }, 4: { b: 0, s: 2 } },
};

function fake(routes: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  return {
    defaults: { baseURL: "https://recipe.test" },
    get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
      const r = routes[url];
      if (r === undefined) throw new Error(`fake: no route for ${url}`);
      return { data: typeof r === "function" ? await r(config?.params ?? {}) : r };
    }),
  } as unknown as HttpClient;
}
const uex = () =>
  fake({
    "/commodities_prices_all": env(PRICES),
    "/terminals": env(TERMINALS),
    "/space_stations": env([arm(1, 1), arm(9, 0), arm(10, 0)]),
    "/cities": env([arm(1, 1), arm(2, 1)]),
    "/outposts": env([arm(1, 0)]),
    "/orbits_distances": (p: Record<string, unknown>) =>
      env(
        p.id_star_system_origin === 64
          ? [{ id_orbit_origin: 400, id_orbit_destination: 401, distance: "20" }]
          : [
              { id_orbit_origin: 326, id_orbit_destination: 4, distance: "30" },
              { id_orbit_origin: 4, id_orbit_destination: 116, distance: "23" },
              { id_orbit_origin: 326, id_orbit_destination: 116, distance: "60" },
            ],
      ),
    "/commodities_prices": (p: Record<string, unknown>) =>
      env(
        Object.entries(REPORTS[Number(p.id_commodity)] ?? {}).map(([t, r]) => ({
          id_terminal: Number(t),
          id_commodity: Number(p.id_commodity),
          price_buy_users_rows: r.b,
          price_sell_users_rows: r.s,
        })),
      ),
    "/fuel_prices_all": env([{ date_modified: secs(2 * DAY) }]),
    "/commodities": env([{ id: 10, name: "Gold", slug: "gold", code: "GOLD" }]),
    "/vehicles": env([{ name: "Cutlass Black", name_full: "Drake Cutlass Black", scu: 46 }]),
  });
const wiki = () =>
  fake({
    "/vehicles/Cutlass%20Black": {
      data: { quantum: { quantum_speed: 238314300, quantum_spool_time: 6.9 }, cargo_capacity: 46 },
    },
  });

const SHIP: FlownShip = {
  name: "Cutlass Black",
  cargoScu: 46,
  quantumSpeedMs: 238_314_300,
  spoolSeconds: 6.9,
};

const clients = { uexClient: uex(), scwClient: wiki() };

function registry() {
  const e = fake({});
  return createRegistry(
    allTools({
      uexClient: clients.uexClient,
      scwClient: clients.scwClient,
      sctClient: e,
      scmdb: new Scmdb({ raw: e, api: e, repo: "o/r", cacheDir: () => "unused" }),
      gameLog: new GameLog({}),
      fleet: new FleetStore("unused-fleet.json"),
    }),
    {},
    { now: () => NOW, gameVersionFor: async () => "4.10.2" },
  );
}

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

/** What the page does for one click: the request, the card's answer, the message. */
async function card(
  state: Record<string, unknown>,
  ship: FlownShip | null = SHIP,
  objective = "profit_per_hour",
) {
  const clock = { t: 1_000_000 };
  const service = new TradeSuggestService({
    plan: (req) => planTrips({ ...clients, deadlineMs: 20_000 }, req),
    ship: async () => ship,
    resolveOrigin: async (text) => resolveOriginHint({ byTerminal: new Map() }, text),
    applyPlan: () => undefined,
    now: () => clock.t + SUGGEST_MIN_INTERVAL_MS,
  });
  const built = tradeBuildRequest(objective, state, { balance: null, sheetCargo: 46 }) as any;
  expect(built.ok).toBe(true);
  const raw = await service.handle(suggestInputSchema.parse(built.args));
  const answer = tradeSuggestClean(L, raw) as any;
  expect(answer.state).toBe("ok");
  const flags = {
    avoidPyro: state["avoidPyro"],
    armistice: state["armistice"],
    reports: state["reports"],
  };
  const view = {
    objective,
    flags,
    priv: false,
    showBalance: true,
    request: built.args,
    answer,
    ageMs: 0,
    from: "",
  };
  return { built, answer, view, message: tradeAgentMessage(L, answer.options[0], view) };
}

/** The first option of the tool, as the dashboard's option names its figures. */
async function toolTop(args: Record<string, unknown>) {
  const out = await registry().call("uex_plan_trade", args);
  expect(out.isError).toBeUndefined();
  const data = JSON.parse(out.content[0]!.text).data;
  const o = data.options[0];
  return {
    route: [o.legs[0].from.terminal, ...o.legs.map((l: any) => l.to.terminal)].join(" → "),
    profit_per_trip: Math.round(o.trip.profit_per_cycle),
    scu_moved: o.trip.scu_moved,
    profit_per_hour: o.trip.profit_per_hour === null ? null : Math.round(o.trip.profit_per_hour),
    cycle_minutes: Math.max(1, Math.round(o.trip.cycle_seconds / 60)),
    legs: o.legs.map((l: any) => [l.commodity, l.scu, l.buy_price, l.sell_price]),
  };
}
const cardTop = (answer: any) => {
  const o = answer.options[0];
  return {
    route: o.route
      .split(" → ")
      .slice(0, o.mode === "round_trip" || o.mode === "two_leg" ? undefined : 2)
      .join(" → "),
    profit_per_trip: o.profit_per_trip,
    scu_moved: o.scu_moved,
    profit_per_hour: o.profit_per_hour,
    cycle_minutes: o.cycle_minutes,
    legs: o.legs.map((l: any) => [l.commodity, l.scu, l.buy_price, l.sell_price]),
  };
};

describe("Feature: the recipe in the message gives the card's first option, with its figures", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["no option", {}],
    ["a typed budget", { budgetText: "2000" }],
    ["avoid Pyro and reports required", { avoidPyro: true, reports: true }],
    ["armistice zones only", { armistice: true }],
    ["a starting place", { originText: "Area 18" }],
  ];
  it.each(cases)(
    "Given %s, Then the tool called with the recipe returns the card's top option",
    async (_l, state) => {
      const { answer, view } = await card(state);
      const args = tradeRecipeArgs(view);
      // the hold and the flown ship of the card are in the recipe
      expect(args.cargo_scu).toBe(46);
      expect(args.ship_name).toBe("Cutlass Black");
      const top = await toolTop(args);
      const mine = cardTop(answer);
      expect(top.profit_per_trip).toBe(mine.profit_per_trip);
      expect(top.scu_moved).toBe(mine.scu_moved);
      expect(top.profit_per_hour).toBe(mine.profit_per_hour);
      expect(top.cycle_minutes).toBe(mine.cycle_minutes);
      expect(top.legs).toEqual(mine.legs);
      expect(top.route.startsWith(mine.route.split(" → ")[0]!)).toBe(true);
    },
  );

  it("Given the card's message, Then it holds the recipe, the card's figures and the order to reconcile", async () => {
    const { message, view } = await card({ avoidPyro: true, budgetText: "2000" });
    const text = message.replace(/[\u00a0\u202f]/g, " ");
    expect(text).toContain(tradeRecipeText(view));
    expect(text).toContain(
      'uex_plan_trade(objective="profit_per_hour", cargo_scu=46, ship_name="Cutlass Black", budget=2000, avoid_pyro=true, stop_minutes=8, limit=8)',
    );
    expect(text).toContain("Étape 1 :");
    expect(text).toContain(
      "dis explicitement ce qui diffère et pourquoi (stock, âge des prix, hypothèses) avant de donner ton verdict",
    );
    expect(text.length).toBeLessThanOrEqual(2600);
    expect(text).not.toMatch(/[\n`<>{}[\]]/);
  });
});

describe("Feature: the two entry points plan alike (the evidence behind the recipe)", () => {
  it("Given the flown ship's quantum speed WITHOUT its spool-up (what the card used to send), Then the figures differ from ship_name's", async () => {
    // The card passed quantumSpeedMs but not the sheet's spool-up: the planner then used its 10 s default, `ship_name` the sheet's
    // 6.9 s. Same prices, same hold, a different cycle: the agent's number could never match the card's.
    const noSpool = await card({}, { ...SHIP, spoolSeconds: null });
    const withSpool = await card({}, SHIP);
    const tool = await toolTop(tradeRecipeArgs(withSpool.view));
    expect(cardTop(withSpool.answer).profit_per_hour).toBe(tool.profit_per_hour);
    expect(cardTop(noSpool.answer).profit_per_hour).not.toBe(tool.profit_per_hour);
  });

  it("Given a card computed with a typed budget and one with none, Then the recipe carries the budget only for the first", async () => {
    const withBudget = await card({ budgetText: "2000" });
    const none = await card({});
    expect(tradeRecipeArgs(withBudget.view).budget).toBe(2000);
    expect(tradeRecipeArgs(none.view)).not.toHaveProperty("budget");
  });
});

describe("Feature: a budget that is the balance is never written into the recipe", () => {
  it("Given a private budget (the balance), Then no budget is in the message and the agent is told to read it (shown) or to go without (hidden)", async () => {
    // the balance reaches the request only through the page's context: the card is computed plain, then the request made private
    const { answer, built } = await card({});
    const view = (showBalance: boolean) => ({
      objective: "profit_per_hour",
      flags: {},
      priv: true,
      showBalance,
      request: { ...built.args, budget: 987_654_321, budget_private: true },
      answer,
      ageMs: 0,
      from: "",
    });
    for (const shown of [true, false]) {
      const m = tradeAgentMessage(L, answer.options[0], view(shown));
      expect(m).not.toMatch(/987\D?654\D?321/);
      expect(m).not.toMatch(/budget=\d/);
      expect(m).toContain(
        shown ? "lis-le avec sc_live_state" : "mon solde est masqué, rejoue sans budget et dis-le",
      );
    }
  });
});
