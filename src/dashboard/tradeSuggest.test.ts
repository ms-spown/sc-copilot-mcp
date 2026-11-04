/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from "axios";
import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { createTelemetry } from "../providers/telemetry/index.js";
import type { TripOption, TripPlanResult, TripRequest } from "../providers/uex/tripPlanner.js";
import { TripPlanError } from "../providers/uex/tripPlanner.js";
import { createRegistry } from "../tools/registry.js";
import { dashboardTools } from "../tools/dashboard.js";
import {
  failure,
  resolveOriginHint,
  suggestInputSchema,
  SUGGEST_MIN_INTERVAL_MS,
  TradeSuggestService,
  type FlownShip,
  type SuggestAnswer,
} from "./tradeSuggest.js";

/**
 * The server side of the commerce action bar, with a fake planner: validation, bounds, the rate limit, the cache, the
 * ship, the plan that "apply" builds, and the rule that the balance is never in the answer. No network, no UEX.
 */

const SECOND = 1000;

function fakeOption(i: number, over: Partial<TripOption> = {}): TripOption {
  const leg = (c: string, from: string, to: string, buy: number, sell: number, scu: number) => ({
    commodity: c,
    from: {
      terminal: from,
      system: "Stanton",
      planet: "Hurston",
      kind: "city",
      armistice_zone: true,
      jurisdiction: "UEE",
    },
    to: {
      terminal: to,
      system: "Stanton",
      planet: "ArcCorp",
      kind: "city",
      armistice_zone: true,
      jurisdiction: "UEE",
    },
    buy_price: buy,
    sell_price: sell,
    profit_per_scu: sell - buy,
    scu,
    limited_by: "cargo" as const,
    cost: buy * scu,
    profit_for_leg: (sell - buy) * scu,
    destination_demand_scu: null,
    price_updated: { buy: null, sell: null },
    price_age_days: { buy: 1, sell: 2 },
    stale: false,
    report_status: "estimate" as const,
    reports: { origin: 0, destination: 0 },
    is_estimate: true,
    estimated_sides: ["origin" as const, "destination" as const],
  });
  return {
    rank: i + 1,
    mode: "round_trip",
    report_status: "estimate",
    estimate: true,
    summary: "x",
    legs: [
      leg(`Laranite ${i}`, "Port Tressler", "Area18 TDD", 189, 457, 100),
      leg("Medical Supplies", "Area18 TDD", "Port Tressler", 1180, 1412, 50),
    ],
    trip: {
      profit_per_cycle: 38_400,
      profit_per_scu: 256,
      scu_moved: 150,
      peak_investment: 118_000,
      cycle_seconds: 1800,
      cycle_time_estimate: "30 min",
      profit_per_hour: 76_800,
      flights_gm: [10, 10],
      distance_basis: ["orbit", "orbit"],
      stops: 2,
      returns_to_start: true,
    },
    data_age: { oldest_price_age_days: 2, stale: false, undated_prices: false },
    safety: {
      heuristic: true,
      exposure: "lower",
      points: 1,
      factors: ["a surface outpost stop (+1)"],
      caveat: "rule of thumb",
    },
    ...over,
  };
}

function fakeResult(over: Partial<TripPlanResult> = {}): TripPlanResult {
  return {
    objective: "profit_per_hour",
    ship: null,
    cargo_scu_used: 100,
    budget: 987_654_321,
    time_model: {
      quantum_speed_ms: 200_000_000,
      spool_seconds: 10,
      stop_minutes: 8,
      local_hop_minutes: 3,
      estimate: true,
    },
    options: Array.from({ length: 8 }, (_, i) => fakeOption(i)),
    chains: Array.from({ length: 6 }, (_, i) => fakeOption(i, { mode: "two_leg" })),
    lists_note: "",
    report_counts: { reported: 0, estimate: 14, unverified: 0 },
    min_reports_note: "",
    candidates_scored: 300,
    excluded: {},
    assumptions: [],
    notes: [],
    fuel: {
      included: false,
      reason: "",
      fuel_prices_rows: null,
      rows_updated_within_7_days: null,
      median_age_days: null,
    },
    ...over,
  } as TripPlanResult;
}

const SHIP: FlownShip = { name: "Cutter", cargoScu: 4, quantumSpeedMs: 238_314_300 };

function service(
  options: {
    plan?: (req: TripRequest) => Promise<TripPlanResult>;
    ship?: FlownShip | null;
    now?: { t: number };
    applied?: any[];
  } = {},
) {
  const clock = options.now ?? { t: 1_000_000 };
  const requests: TripRequest[] = [];
  const plan = options.plan ?? (async () => fakeResult());
  const svc = new TradeSuggestService({
    plan: async (req) => {
      requests.push(req);
      return plan(req);
    },
    ship: async () => (options.ship === undefined ? SHIP : options.ship),
    resolveOrigin: async (text) => resolveOriginHint({ byTerminal: new Map() }, text),
    applyPlan: (p) => options.applied?.push(p),
    now: () => clock.t,
  });
  const ask = async (input: Record<string, unknown>): Promise<SuggestAnswer> => {
    const parsed = suggestInputSchema.parse({ action: "search", ...input });
    return svc.handle(parsed);
  };
  return { svc, clock, requests, ask };
}

describe("Feature: the input is validated before anything is asked", () => {
  const parse = (v: unknown) => suggestInputSchema.safeParse(v).success;
  it("Given good and bad inputs, Then only the described ones pass", () => {
    expect(parse({ action: "search" })).toBe(true);
    expect(
      parse({
        action: "search",
        objective: "safety",
        avoid_pyro: true,
        armistice_only: true,
        min_reports: 1,
        round_trip_only: true,
        budget: 250_000,
        budget_private: true,
        cargo_scu: 96,
        origin: "Lorville",
        use_ship: false,
      }),
    ).toBe(true);
    expect(parse({ action: "search", objective: "best" })).toBe(false);
    expect(parse({ action: "search", ship_name: "Hull C" })).toBe(false); // the View never names a ship
    expect(parse({ action: "search", budget: -5 })).toBe(false);
    expect(parse({ action: "search", budget: 1e15 })).toBe(false);
    expect(parse({ action: "search", cargo_scu: 1.5 })).toBe(false);
    expect(parse({ action: "search", cargo_scu: 0 })).toBe(false);
    expect(parse({ action: "search", min_reports: 99 })).toBe(false);
    expect(parse({ action: "search", origin: "x".repeat(81) })).toBe(false);
    expect(parse({ action: "search", avoid_pyro: "yes" })).toBe(false);
    expect(parse({ action: "apply", id: "k-o3" })).toBe(true);
    expect(parse({ action: "apply", id: "../etc" })).toBe(false);
    expect(parse({ action: "apply" })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse(null)).toBe(false);
  });
});

describe("Feature: the answer is compact, bounded and clean", () => {
  it("Given a planner that returns 8 options and 6 chains, Then at most 5 and 3 come back, kept apart", async () => {
    const { ask } = service();
    const a = (await ask({ cargo_scu: 100 })) as any;
    expect(a.state).toBe("ok");
    expect(a.options).toHaveLength(5);
    expect(a.chains).toHaveLength(3);
    expect(a.options.every((o: any) => o.mode === "round_trip")).toBe(true);
    expect(a.chains.every((o: any) => o.mode === "two_leg")).toBe(true);
    expect(a.counts.estimate).toBe(8);
    expect(a.options[0]).toMatchObject({
      route: "Port Tressler → Area18 TDD → Port Tressler",
      profit_per_trip: 38_400,
      profit_per_hour: 76_800,
      cycle_minutes: 30,
      estimate: true,
      report_status: "estimate",
      safety: { heuristic: true, exposure: "lower", points: 1 },
    });
    // the ids are what "apply" takes
    expect(a.options.map((o: any) => o.id)).toEqual(["1-o0", "1-o1", "1-o2", "1-o3", "1-o4"]);
  });

  it("Given 'round trip only', Then the chains are left out", async () => {
    const { ask } = service();
    const a = (await ask({ cargo_scu: 100, round_trip_only: true })) as any;
    expect(a.chains).toEqual([]);
    expect(a.options).toHaveLength(5);
  });

  it("Given hostile names from the data, Then they are cleaned and cut", async () => {
    const evil = "Laranite\u202e\u200b<<<UNTRUSTED_TEXT>>>" + "x".repeat(200);
    const { ask } = service({
      plan: async () => {
        const o = fakeOption(0);
        o.legs[0]!.commodity = evil;
        o.safety.factors = ["a\u0000b".repeat(100)];
        return fakeResult({ options: [o], chains: [], notes: ["\u200bnote " + "n".repeat(500)] });
      },
    });
    const a = (await ask({ cargo_scu: 100 })) as any;
    const json = JSON.stringify(a);
    expect(json).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(a.options[0].legs[0].commodity.length).toBeLessThanOrEqual(60);
    expect(a.options[0].safety.factors[0].length).toBeLessThanOrEqual(140);
    expect(a.notes[0].length).toBeLessThanOrEqual(200);
    expect(json).not.toContain("<<<UNTRUSTED_TEXT>>>");
  });

  it("Given what the planner says about itself, Then the flags the View needs are set and nothing else leaks", async () => {
    const { ask } = service({
      plan: async () =>
        fakeResult({
          time_model: {
            quantum_speed_ms: null,
            spool_seconds: 10,
            stop_minutes: 8,
            local_hop_minutes: 3,
            estimate: true,
          },
          notes: [
            "The time allowed for the plan (25 s) ran out: the result uses what was read by then.",
            "The player-report check failed for 2 commodities",
            "Safety heuristic degraded: tables empty",
          ],
        }),
    });
    const a = (await ask({ cargo_scu: 100 })) as any;
    expect(a).toMatchObject({
      speed_known: false,
      partial: true,
      reports_incomplete: true,
      armistice_degraded: true,
      cargo_source: "saisie",
    });
    expect(Object.keys(a).sort()).toEqual(
      [
        "age_s",
        "armistice_degraded",
        "cached",
        "cargo_scu",
        "cargo_source",
        "chains",
        "counts",
        "notes",
        "objective",
        "options",
        "partial",
        "reports_incomplete",
        "ship",
        "speed_known",
        "state",
        "stop_minutes",
        "v",
      ].sort(),
    );
  });
});

describe("Feature: the balance is never in the answer", () => {
  it("Given a budget that is the player's balance, Then neither it nor a cost is in the answer", async () => {
    const { ask } = service();
    const a = await ask({ cargo_scu: 100, budget: 987_654_321, budget_private: true });
    const json = JSON.stringify(a);
    expect(json).not.toContain("987654321");
    expect(json).not.toContain("budget");
    expect(json).not.toContain('"cost"');
  });

  it("Given a budget the player typed, Then the answer still does not echo it, and the cost is there", async () => {
    const { ask } = service();
    const a = (await ask({ cargo_scu: 100, budget: 987_654_321 })) as any;
    expect(JSON.stringify(a)).not.toContain("987654321");
    expect(a.options[0].cost).toBe(118_000);
  });

  it("Given a budget, Then it reaches the planner (and only there)", async () => {
    const { ask, requests } = service();
    await ask({ cargo_scu: 100, budget: 500_000 });
    expect(requests[0]!.budget).toBe(500_000);
  });
});

describe("Feature: UEX is never hammered", () => {
  it("Given the same question twice, Then the second is served from memory with no planner run", async () => {
    const { ask, requests, clock } = service();
    await ask({ cargo_scu: 100 });
    clock.t += 2 * SECOND;
    const second = (await ask({ cargo_scu: 100 })) as any;
    expect(requests).toHaveLength(1);
    expect(second).toMatchObject({ state: "ok", cached: true, age_s: 2 });
    expect(second.options).toHaveLength(5);
  });

  it("Given a different question inside the interval, Then 'retry in N s' is answered as a state, not an error", async () => {
    const { ask, requests, clock } = service();
    await ask({ cargo_scu: 100 });
    clock.t += 3 * SECOND;
    const second = await ask({ cargo_scu: 100, avoid_pyro: true });
    expect(second).toEqual({ v: 1, state: "throttled", retry_after_s: 5 });
    expect(requests).toHaveLength(1);
    clock.t += 5 * SECOND;
    expect((await ask({ cargo_scu: 100, avoid_pyro: true })).state).toBe("ok");
    expect(requests).toHaveLength(2);
  });

  it("Given the interval is the documented one", () => {
    expect(SUGGEST_MIN_INTERVAL_MS).toBe(8000);
  });

  it("Given the cache entry is old, Then the planner runs again", async () => {
    const { ask, requests, clock } = service();
    await ask({ cargo_scu: 100 });
    clock.t += 121 * SECOND;
    await ask({ cargo_scu: 100 });
    expect(requests).toHaveLength(2);
  });

  it("Given N identical calls at once, Then one planner run answers them all", async () => {
    let release: (r: TripPlanResult) => void = () => undefined;
    const { ask, requests } = service({
      plan: () => new Promise<TripPlanResult>((resolve) => (release = resolve)),
    });
    const all = Promise.all([1, 2, 3, 4].map(() => ask({ cargo_scu: 100 })));
    await new Promise((r) => setImmediate(r));
    release(fakeResult());
    const answers = await all;
    expect(requests).toHaveLength(1);
    expect(answers.every((a) => a.state === "ok")).toBe(true);
  });

  it("Given a different call while one is running, Then it waits its turn", async () => {
    let release: (r: TripPlanResult) => void = () => undefined;
    const { ask, requests } = service({
      plan: () => new Promise<TripPlanResult>((resolve) => (release = resolve)),
    });
    const first = ask({ cargo_scu: 100 });
    await new Promise((r) => setImmediate(r));
    const second = await ask({ cargo_scu: 100, armistice_only: true });
    expect(second.state).toBe("throttled");
    release(fakeResult());
    await first;
    expect(requests).toHaveLength(1);
  });

  it("Given a failure, Then it counts toward the interval and is not cached", async () => {
    let fail = true;
    const { ask, requests, clock } = service({
      plan: async () => {
        if (fail) throw new Error("boom");
        return fakeResult();
      },
    });
    expect((await ask({ cargo_scu: 100 })).state).toBe("error");
    fail = false;
    clock.t += 1 * SECOND;
    expect((await ask({ cargo_scu: 100 })).state).toBe("throttled");
    clock.t += 8 * SECOND;
    expect((await ask({ cargo_scu: 100 })).state).toBe("ok");
    expect(requests).toHaveLength(2);
  });

  it("Given no hold size is known, Then nothing is asked and the interval is not used up", async () => {
    const { ask, requests } = service({ ship: null });
    expect(await ask({})).toEqual({ v: 1, state: "error", code: "no_cargo" });
    expect(requests).toHaveLength(0);
    expect((await ask({ cargo_scu: 50 })).state).toBe("ok");
  });
});

describe("Feature: the ship comes from the server, never from the View", () => {
  it("Given a flown ship and no typed hold, Then the ship's hold and quantum speed go to the planner", async () => {
    const { ask, requests } = service();
    const a = (await ask({})) as any;
    expect(requests[0]).toMatchObject({ cargoScu: 4, quantumSpeedMs: 238_314_300 });
    expect(a).toMatchObject({ cargo_scu: 4, cargo_source: "fiche", ship: "Cutter" });
  });

  it("Given a typed hold, Then it wins over the ship's, and the speed is still the ship's", async () => {
    const { ask, requests } = service();
    await ask({ cargo_scu: 696 });
    expect(requests[0]).toMatchObject({ cargoScu: 696, quantumSpeedMs: 238_314_300 });
  });

  it("Given use_ship false, Then the ship is ignored", async () => {
    const { ask, requests } = service();
    await ask({ cargo_scu: 10, use_ship: false });
    expect(requests[0]!.quantumSpeedMs).toBeUndefined();
  });

  it("Given the origin text, Then it is resolved to a planet, a system or a terminal", async () => {
    const places = {
      byTerminal: new Map<number, any>([
        [1, { planetName: "Hurston", systemName: "Stanton" }],
        [2, { planetName: "ArcCorp", systemName: "Stanton" }],
      ]),
    };
    expect(resolveOriginHint(places as any, "hurston")).toEqual({ planetName: "Hurston" });
    expect(resolveOriginHint(places as any, " Stanton ")).toEqual({ systemName: "Stanton" });
    expect(resolveOriginHint(places as any, "Area18 TDD")).toEqual({ terminalName: "Area18 TDD" });
    const { ask, requests } = service();
    await ask({ cargo_scu: 10, origin: "Area18 TDD" });
    expect(requests[0]!.origin).toEqual({ terminalName: "Area18 TDD" });
  });

  it("Given the flags, Then the planner receives them", async () => {
    const { ask, requests } = service();
    await ask({
      cargo_scu: 10,
      objective: "safety",
      avoid_pyro: true,
      armistice_only: true,
      min_reports: 1,
    });
    expect(requests[0]).toMatchObject({
      objective: "safety",
      avoidPyro: true,
      armisticeOnly: true,
      minReports: 1,
      cargoScu: 10,
    });
  });
});

describe("Feature: apply as plan, by id", () => {
  it("Given an option, When applied, Then the plan is the outbound leg, cleaned, and stored on the dashboard", async () => {
    const applied: any[] = [];
    const { svc, ask } = service({ applied });
    await ask({ cargo_scu: 100 });
    const answer = await svc.handle(suggestInputSchema.parse({ action: "apply", id: "1-o0" }));
    expect(answer.state).toBe("applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      commodity: "Laranite 0",
      buy_terminal: "Port Tressler",
      sell_terminal: "Area18 TDD",
      scu: 100,
      expected_profit_auec: 26_800,
      buy_unit_price: 189,
      sell_unit_price: 457,
      est_trip_minutes: 30,
      note: "Retour : Medical Supplies",
    });
    expect(applied[0].safety_note).toContain("Heuristique");
  });

  it("Given an unknown id, Then nothing is applied", async () => {
    const applied: any[] = [];
    const { svc } = service({ applied });
    const answer = await svc.handle(suggestInputSchema.parse({ action: "apply", id: "9-o0" }));
    expect(answer).toEqual({ v: 1, state: "error", code: "expired" });
    expect(applied).toEqual([]);
  });
});

describe("Feature: failures are states with a code", () => {
  it("Given the planner's errors, Then they map to codes and only a bad name keeps a detail", () => {
    expect(
      failure(new TripPlanError("Give ship_name or cargo_scu: a plan needs a hold size.")),
    ).toMatchObject({
      code: "no_cargo",
    });
    expect(failure(new TripPlanError('No UEX terminal matches "Zorglub".'))).toMatchObject({
      code: "bad_origin",
      detail: 'No UEX terminal matches "Zorglub".',
    });
    expect(failure(new TripPlanError("armistice_only cannot be applied: x."))).toMatchObject({
      code: "armistice_unavailable",
    });
    expect(
      failure(new TripPlanError("UEX returned no prices (commodities_prices_all is empty).")),
    ).toMatchObject({ code: "upstream" });
    expect(failure(new TripPlanError("something else"))).toMatchObject({ code: "other" });
    expect(failure(new Error("boom"))).toEqual({ v: 1, state: "error", code: "other" });
    const http = new axios.AxiosError("x", "ERR", undefined, undefined, { status: 429 } as any);
    expect(failure(http)).toEqual({ v: 1, state: "error", code: "upstream", detail: "HTTP 429" });
  });
});

describe("Feature: the tool, as the registry lists and runs it", () => {
  const empty = { defaults: {}, get: async () => ({ data: {} }) } as unknown as HttpClient;
  const telemetry = (enabled: boolean) => ({ ...createTelemetry({ enabled: false }), enabled });
  const build = (enabled: boolean, plan = vi.fn(async () => fakeResult())) => {
    const tools = dashboardTools(
      { telemetry: telemetry(enabled), uexClient: empty, scwClient: empty },
      { plan, now: () => 5_000_000 },
    );
    return { registry: createRegistry(tools), plan };
  };

  it("Given telemetry on, Then it is listed to a client with Views only, as an app-only tool", () => {
    const { registry } = build(true);
    expect(registry.list({ ui: false }).map((t) => t.name)).not.toContain("sc_trade_suggest");
    const listed = registry.list({ ui: true }).find((t) => t.name === "sc_trade_suggest")!;
    expect(listed).toBeDefined();
    expect((listed as any)._meta.ui.visibility).toEqual(["app"]);
    expect(listed.description).toMatch(/not for the model/);
    const off = build(false).registry;
    expect(off.list({ ui: true }).map((t) => t.name)).not.toContain("sc_trade_suggest");
  });

  it("Given a search, Then the text is fixed and the data is in structuredContent, without the balance", async () => {
    const { registry, plan } = build(true);
    const r: any = await registry.call("sc_trade_suggest", {
      action: "search",
      cargo_scu: 100,
      budget: 987_654_321,
      budget_private: true,
      use_ship: false,
    });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.state).toBe("ok");
    expect(JSON.stringify(r)).not.toContain("987654321");
    expect(r.content[0].text).toContain("trade suggestion: ok");
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("Given an option is applied, Then the plan reaches the saved session too (it marks the trip that follows)", async () => {
    const setPlan = vi.fn();
    const tools = dashboardTools(
      {
        telemetry: telemetry(true),
        uexClient: empty,
        scwClient: empty,
        sessions: { setPlan } as any,
      },
      { plan: vi.fn(async () => fakeResult()), now: () => 5_000_000 },
    );
    const registry = createRegistry(tools);
    const found: any = await registry.call("sc_trade_suggest", {
      action: "search",
      cargo_scu: 100,
      use_ship: false,
    });
    const id = found.structuredContent.options[0].id;
    const applied: any = await registry.call("sc_trade_suggest", { action: "apply", id });
    expect(applied.structuredContent.state).toBe("applied");
    expect(setPlan).toHaveBeenCalledTimes(1);
    expect(setPlan.mock.calls[0]![0]).toMatchObject({ commodity: "Laranite 0", scu: 100 });
  });

  it("Given an invalid input, Then it is an error result and the planner is not asked", async () => {
    const { registry, plan } = build(true);
    const r: any = await registry.call("sc_trade_suggest", { action: "search", budget: "lots" });
    expect(r.isError).toBe(true);
    expect(plan).not.toHaveBeenCalled();
  });

  it("Given a planner that throws, Then the result is a state, not an exception", async () => {
    const { registry } = build(
      true,
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const r: any = await registry.call("sc_trade_suggest", {
      action: "search",
      cargo_scu: 5,
      use_ship: false,
    });
    expect(r.structuredContent).toEqual({ v: 1, state: "error", code: "other" });
  });

  it("Given telemetry off, Then a direct call is refused and the planner is not asked", async () => {
    const { registry, plan } = build(false);
    const r: any = await registry.call("sc_trade_suggest", { action: "search", cargo_scu: 5 });
    expect(r.isError).toBe(true);
    expect(plan).not.toHaveBeenCalled();
  });
});
