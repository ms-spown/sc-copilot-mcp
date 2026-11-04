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
      terminal_id: 11,
      system: "Stanton",
      planet: "Hurston",
      kind: "city",
      armistice_zone: true,
      jurisdiction: "UEE",
    },
    to: {
      terminal: to,
      terminal_id: 22,
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
    infos?: any[];
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
    applyPlan: (p, info) => {
      options.applied?.push(p);
      options.infos?.push(info);
    },
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
    expect(parse({ action: "apply", id: "000000000000000000000000000000a0" })).toBe(true);
    expect(parse({ action: "apply", id: "1-o0" })).toBe(false); // the old sequential ids are gone
    expect(
      parse({ action: "apply", id: "000000000000000000000000000000a0", with_balance: true }),
    ).toBe(true);
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
    const ids = [...a.options, ...a.chains].map((o: any) => o.id);
    expect(ids.every((id: string) => /^[a-f0-9]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
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
        "private",
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
    const found = (await ask({ cargo_scu: 100 })) as any;
    const firstId: string = found.options[0].id;
    const answer = await svc.handle(suggestInputSchema.parse({ action: "apply", id: firstId }));
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
    const answer = await svc.handle(
      suggestInputSchema.parse({ action: "apply", id: "ffffffffffffffffffffffffffffffff" }),
    );
    expect(answer).toEqual({ v: 1, state: "error", code: "expired" });
    expect(applied).toEqual([]);
  });
});

describe("Feature: a plan cannot be guessed and does not outlive its answer", () => {
  it("Given a caller that enumerates ids, Then every guess is refused and nothing is applied", async () => {
    const applied: any[] = [];
    const { svc, ask } = service({ applied });
    const found = (await ask({ cargo_scu: 100 })) as any;
    const real = new Set([...found.options, ...found.chains].map((o: any) => o.id));
    const guesses = [
      ...Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(32, "0")),
      ...Array.from(
        { length: 300 },
        (_, i) => `${(i + 1).toString(16)}${"0".repeat(31 - String(i).length)}`,
      ),
    ].filter((g) => /^[a-f0-9]{32}$/.test(g) && !real.has(g));
    for (const id of guesses) {
      const a = await svc.handle(suggestInputSchema.parse({ action: "apply", id }));
      expect(a).toEqual({ v: 1, state: "error", code: "expired" });
    }
    expect(applied).toEqual([]);
  });

  it("Given two searches, Then their ids differ (random, not a counter)", async () => {
    const { ask, clock } = service();
    const one = (await ask({ cargo_scu: 100 })) as any;
    clock.t += 10 * SECOND;
    const two = (await ask({ cargo_scu: 100, avoid_pyro: true })) as any;
    const ids = [...one.options, ...two.options].map((o: any) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Given the cache TTL has passed, Then the ids are refused too", async () => {
    const applied: any[] = [];
    const { svc, ask, clock } = service({ applied });
    const found = (await ask({ cargo_scu: 100 })) as any;
    const id = found.options[0].id;
    clock.t += 119 * SECOND;
    expect((await svc.handle(suggestInputSchema.parse({ action: "apply", id }))).state).toBe(
      "applied",
    );
    clock.t += 2 * SECOND;
    expect(await svc.handle(suggestInputSchema.parse({ action: "apply", id }))).toEqual({
      v: 1,
      state: "error",
      code: "expired",
    });
    expect(applied).toHaveLength(1);
  });
});

describe("Feature: a plan built from the balance stays private", () => {
  const budgetLimited = async () => {
    const o = fakeOption(0);
    o.legs[0]!.limited_by = "budget";
    o.legs[1]!.limited_by = "stock";
    return fakeResult({ options: [o], chains: [fakeOption(1, { mode: "two_leg" })] });
  };

  it("Given a private budget, Then no leg says it is limited by the budget, and the answer says it is private", async () => {
    const { ask } = service({ plan: budgetLimited });
    const a = (await ask({ cargo_scu: 100, budget: 1_234_561, budget_private: true })) as any;
    expect(a.private).toBe(true);
    expect(a.options[0].legs[0].limited_by).toBe("hidden");
    expect(a.options[0].legs[1].limited_by).toBe("stock");
    expect(JSON.stringify(a)).not.toContain('"budget"');
    expect(JSON.stringify(a)).not.toContain("1234561");
  });

  it("Given a typed budget, Then the legs say it (it is the player's own number, not the balance)", async () => {
    const { ask } = service({ plan: budgetLimited });
    const a = (await ask({ cargo_scu: 100, budget: 500_000 })) as any;
    expect(a.private).toBe(false);
    expect(a.options[0].legs[0].limited_by).toBe("budget");
  });

  it("Given a private plan is applied, Then the answer and the application say it is private, and whether the balance is shown", async () => {
    const infos: any[] = [];
    const { svc, ask } = service({ plan: budgetLimited, infos });
    const found = (await ask({ cargo_scu: 100, budget: 1_234_561, budget_private: true })) as any;
    const id = found.options[0].id;
    const hidden = (await svc.handle(suggestInputSchema.parse({ action: "apply", id }))) as any;
    expect(hidden).toMatchObject({ state: "applied", private: true });
    const shown = (await svc.handle(
      suggestInputSchema.parse({ action: "apply", id, with_balance: true }),
    )) as any;
    expect(shown.private).toBe(true);
    expect(infos).toEqual([
      { private: true, withBalance: false, ids: { buy: 11, sell: 22 } },
      { private: true, withBalance: true, ids: { buy: 11, sell: 22 } },
    ]);
  });

  it("Given a plan from a typed budget, Then it is not private", async () => {
    const infos: any[] = [];
    const { svc, ask } = service({ infos });
    const found = (await ask({ cargo_scu: 100, budget: 500_000 })) as any;
    const a = (await svc.handle(
      suggestInputSchema.parse({ action: "apply", id: found.options[0].id }),
    )) as any;
    expect(a.private).toBe(false);
    expect(infos[0]).toEqual({ private: false, withBalance: false, ids: { buy: 11, sell: 22 } });
  });
});

describe("Feature: where the hold comes from is said right", () => {
  it("Given no typed hold, Then it is the ship's; a typed one equal to the ship's is still the ship's; another is typed", async () => {
    const { ask, clock } = service();
    expect(((await ask({})) as any).cargo_source).toBe("fiche");
    clock.t += 10 * SECOND;
    expect(((await ask({ cargo_scu: 4 })) as any).cargo_source).toBe("fiche");
    clock.t += 10 * SECOND;
    expect(((await ask({ cargo_scu: 96 })) as any).cargo_source).toBe("saisie");
  });
});

describe("Feature: a slow planner cannot pile up runs", () => {
  it("Given a run in progress for a long time, Then a different question waits even after the interval", async () => {
    let release: (r: TripPlanResult) => void = () => undefined;
    const { ask, requests, clock } = service({
      plan: () => new Promise<TripPlanResult>((resolve) => (release = resolve)),
    });
    const first = ask({ cargo_scu: 100 });
    await new Promise((r) => setImmediate(r));
    clock.t += 24 * SECOND;
    const second = await ask({ cargo_scu: 100, budget: 1_000_000 });
    const third = await ask({ cargo_scu: 100, budget: 2_000_000 });
    expect(second).toMatchObject({ state: "throttled" });
    expect(third).toMatchObject({ state: "throttled" });
    expect(requests).toHaveLength(1);
    release(fakeResult());
    await first;
  });
});

describe("Feature: a suggestion for a completed run is computed once, whoever asks", () => {
  it("Given the same run id twice, Then the second (a View mounted again) gets 'done' and no planner run", async () => {
    const { ask, requests, clock } = service();
    const a = await ask({
      cargo_scu: 100,
      origin: "Area18 TDD",
      next_run: "2026-11-04T11:40:00.000Z",
    });
    expect(a.state).toBe("ok");
    clock.t += 30 * SECOND;
    const b = await ask({
      cargo_scu: 100,
      origin: "Area18 TDD",
      next_run: "2026-11-04T11:40:00.000Z",
    });
    expect(b).toEqual({ v: 1, state: "error", code: "done" });
    expect(requests).toHaveLength(1);
    // another run is another suggestion
    const c = await ask({
      cargo_scu: 100,
      origin: "Area18 TDD",
      next_run: "2026-11-04T12:40:00.000Z",
    });
    expect(c.state).toBe("ok");
  });

  it("Given a throttled or impossible call, Then the run is not marked (the View may try again)", async () => {
    const { ask, clock } = service({ ship: null });
    expect((await ask({ next_run: "r1" })).state).toBe("error"); // no hold
    expect((await ask({ cargo_scu: 5, next_run: "r1" })).state).toBe("ok");
    clock.t += 1 * SECOND;
    expect((await ask({ cargo_scu: 6, next_run: "r2" })).state).toBe("throttled");
    clock.t += 9 * SECOND;
    expect((await ask({ cargo_scu: 6, next_run: "r2" })).state).toBe("ok");
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
  /** The View's own calls: a client that declared the UI extension (an app-only tool is refused to any other). */
  const asView = (r: ReturnType<typeof createRegistry>) => ({
    ...r,
    call: (name: string, args: unknown) => r.call(name, args, { ui: true }),
  });
  const build = (enabled: boolean, plan = vi.fn(async () => fakeResult())) => {
    const tools = dashboardTools(
      { telemetry: telemetry(enabled), uexClient: empty, scwClient: empty },
      { plan, now: () => 5_000_000 },
    );
    return { registry: asView(createRegistry(tools)), plan };
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
    const registry = asView(createRegistry(tools));
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

  it("Given a plan built from the balance, Then the saved session gets it only while the balance is shown", async () => {
    const setPlan = vi.fn();
    const tools = dashboardTools(
      {
        telemetry: telemetry(true),
        uexClient: empty,
        scwClient: empty,
        sessions: { setPlan } as any,
      },
      { plan: vi.fn(async () => fakeResult()), now: () => 5_000_000, minIntervalMs: 0 },
    );
    const registry = asView(createRegistry(tools));
    const search = async (extra: Record<string, unknown>) =>
      (
        (await registry.call("sc_trade_suggest", {
          action: "search",
          cargo_scu: 100,
          use_ship: false,
          ...extra,
        })) as any
      ).structuredContent;
    const priv = await search({ budget: 1_234_561, budget_private: true });
    const apply = async (id: string, extra: Record<string, unknown> = {}) =>
      (await registry.call("sc_trade_suggest", { action: "apply", id, ...extra })) as any;
    expect((await apply(priv.options[0].id)).structuredContent.private).toBe(true);
    expect(setPlan).not.toHaveBeenCalled();
    await apply(priv.options[1].id, { with_balance: true });
    expect(setPlan).toHaveBeenCalledTimes(1);
    const plain = await search({ budget: 500_000 });
    await apply(plain.options[0].id);
    expect(setPlan).toHaveBeenCalledTimes(2);
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

describe("Feature: the cache cannot be used to guess a private budget (audit leftover)", () => {
  const priv = (budget: number) => ({ cargo_scu: 100, budget, budget_private: true });

  it("Given a private answer in the cache, Then a caller without the private flag never gets it, even with the same budget", async () => {
    const { ask, requests, clock } = service();
    await ask(priv(1_234_561));
    clock.t += SUGGEST_MIN_INTERVAL_MS + SECOND;
    const typed = (await ask({ cargo_scu: 100, budget: 1_234_561 })) as any;
    expect(requests).toHaveLength(2); // a fresh run, not the private entry
    expect(typed).toMatchObject({ state: "ok", cached: false, private: false });
    expect(typed.options[0].cost).toBeDefined();
  });

  it("Given a private lookup, Then another one inside the interval is refused whatever the cache holds (one guess per interval)", async () => {
    const { ask, requests, clock } = service();
    await ask(priv(1_234_561));
    clock.t += 2 * SECOND;
    // The exact same private request would be a cache hit: it is answered as throttled, so a hit is not observable.
    expect(await ask(priv(1_234_561))).toMatchObject({ state: "throttled" });
    expect(await ask(priv(7_654_321))).toMatchObject({ state: "throttled" });
    expect(requests).toHaveLength(1);
    // After the interval the legitimate caller gets its cached answer again.
    clock.t += SUGGEST_MIN_INTERVAL_MS;
    expect(await ask(priv(1_234_561))).toMatchObject({ state: "ok", cached: true });
    expect(requests).toHaveLength(1);
  });

  it("Given the general throttle refuses a private request, Then it still used the private slot", async () => {
    const { ask, requests, clock } = service();
    await ask({ cargo_scu: 100, avoid_pyro: true }); // a run at t0: the general throttle is on
    clock.t += 3 * SECOND;
    expect(await ask(priv(1_234_561))).toMatchObject({ state: "throttled" }); // refused, slot taken
    clock.t += 6 * SECOND; // 9 s after the run: the general throttle is open, the private slot is not
    expect(await ask(priv(7_654_321))).toMatchObject({ state: "throttled" });
    expect(requests).toHaveLength(1);
    clock.t += 3 * SECOND; // 9 s after the slot was taken: open
    expect(await ask(priv(7_654_321))).toMatchObject({ state: "ok", cached: false });
  });

  it("Given a typed budget, Then the cache stays free of the private limit", async () => {
    const { ask, requests, clock } = service();
    await ask({ cargo_scu: 100, budget: 500_000 });
    clock.t += 2 * SECOND;
    expect(await ask({ cargo_scu: 100, budget: 500_000 })).toMatchObject({ cached: true });
    expect(requests).toHaveLength(1);
  });
});
