/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { planResultFor } from "../testing/replay/planner.js";
import {
  TripPlanError,
  type TripPlanResult,
  type TripRequest,
} from "../providers/uex/tripPlanner.js";
import { suggestInputSchema, TradeSuggestService, type SuggestOk } from "./tradeSuggest.js";

/**
 * The server side of "Partir de ma position": which source it takes, that a game-log token never leaves it, what it refuses,
 * and the opening step as the View receives it. A fake planner (no UEX, no network); invented places and goods.
 */

const TOKEN = "Teststar1_Alphaville";
const AT = "2026-11-04T12:00:00.000Z";

const leg = (commodity: string, from: string, to: string, scu: number, perScu: number) => ({
  commodity,
  from: {
    terminal: from,
    system: "Teststar",
    planet: "Testplanet",
    terminal_id: 1,
    armistice_zone: true,
  },
  to: {
    terminal: to,
    system: "Teststar",
    planet: "Testplanet",
    terminal_id: 2,
    armistice_zone: true,
  },
  buy_price: 100,
  sell_price: 100 + perScu,
  profit_per_scu: perScu,
  scu,
  limited_by: "budget" as const,
  cost: 100 * scu,
  profit_for_leg: perScu * scu,
  destination_demand_scu: null,
  price_updated: { buy: null, sell: null },
  price_age_days: { buy: 1, sell: 1 },
  stale: false,
  report_status: "estimate" as const,
  reports: { origin: 0, destination: 0 },
  is_estimate: true,
  estimated_sides: [] as ("origin" | "destination")[],
});

/** A planner answer with one option reached from a position: step 1 of 50 SCU, then the route. */
function fromPosition(): TripPlanResult {
  const base = planResultFor({
    commodity: "B2",
    from: "Beta Port",
    to: "Gamma Base",
    buyPrice: 200,
    sellPrice: 500,
    scu: 100,
  });
  const step1 = leg("A1", "Alphaville", "Beta Port", 50, 50);
  const option = {
    ...base.options[0]!,
    opening: {
      position: "Alphaville",
      at_position: false,
      start_terminal: "Beta Port",
      step1,
      reposition_gm: 10,
      reposition_seconds: 400,
      first_cycle: { profit: 32500, seconds: 3600, profit_per_hour: 32500 },
      without_step1: { profit: 30000, seconds: 3600, profit_per_hour: 30000 },
    },
  };
  return {
    ...base,
    position: { label: "Alphaville", terminals: 2, basis: "exact", planet: "Testplanet" },
    options: [option as never],
  };
}

function setup(
  over: {
    place?: boolean;
    placeAt?: string;
    private?: boolean;
    plan?: (r: TripRequest) => Promise<TripPlanResult>;
  } = {},
) {
  const requests: TripRequest[] = [];
  const clock = { t: Date.parse(AT) + 10 * 60_000 };
  const svc = new TradeSuggestService({
    plan: async (req) => {
      requests.push(req);
      return (over.plan ?? (async () => fromPosition()))(req);
    },
    ship: async () => ({ name: "Test Hauler", cargoScu: 100, quantumSpeedMs: 2e8 }),
    resolveOrigin: async (text) => ({ terminalName: text }),
    applyPlan: () => undefined,
    ...(over.place === false
      ? {}
      : {
          lastPlace: () =>
            over.private
              ? { private: true as const, at: over.placeAt ?? AT }
              : { token: TOKEN, words: "Teststar1 Alphaville", at: over.placeAt ?? AT },
        }),
    now: () => clock.t,
  });
  const ask = (input: Record<string, unknown>) =>
    svc.handle(suggestInputSchema.parse({ action: "search", ...input }));
  return { svc, requests, clock, ask };
}

describe("Feature: the position comes from the server's own journal or from a typed place", () => {
  it("Given the journal source, Then the planner gets the server's token, and the answer carries words and a time, never the token", async () => {
    const { ask, requests } = setup();
    const a = (await ask({ position: "journal" })) as SuggestOk;
    expect(requests[0]!.position).toEqual({ token: TOKEN });
    expect(requests[0]!.origin).toBeUndefined();
    expect(a.position).toEqual({
      label: "Alphaville",
      source: "journal",
      at: AT,
      planet: "Testplanet",
    });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(JSON.stringify(a)).not.toContain("Teststar1");
  });

  it("Given a typed place, Then the planner gets that text and the answer says it was typed", async () => {
    const { ask, requests } = setup({ place: false });
    const a = (await ask({ position_text: "  Alphaville  " })) as SuggestOk;
    expect(requests[0]!.position).toEqual({ text: "Alphaville" });
    expect(a.position).toEqual({
      label: "Alphaville",
      source: "saisie",
      at: null,
      planet: "Testplanet",
    });
  });

  it("Given the journal has no usable place, Then the answer is position_unknown, at no cost: the planner is not asked and no slot is used", async () => {
    const { ask, requests } = setup({ place: false });
    expect(await ask({ position: "journal" })).toEqual({
      v: 1,
      state: "error",
      code: "position_unknown",
    });
    expect(requests).toEqual([]);
    // The next search is not throttled by the refused one.
    const next = await ask({});
    expect(next.state).toBe("ok");
  });

  it("Given a position with an origin or with two positions, Then it is refused before anything is asked", async () => {
    const { ask, requests } = setup();
    for (const input of [
      { position: "journal", origin: "Lorville" },
      { position_text: "Alphaville", origin: "Lorville" },
      { position: "journal", position_text: "Alphaville" },
    ]) {
      expect(await ask(input)).toMatchObject({ state: "error", code: "other" });
    }
    expect(requests).toEqual([]);
  });

  it("Given a place the planner cannot name, Then the answer is position_unresolved with the planner's sentence", async () => {
    const { ask } = setup({
      plan: async () => {
        throw new TripPlanError("Position: UEX knows no place that matches it.");
      },
    });
    expect(await ask({ position_text: "Nowhereville" })).toEqual({
      v: 1,
      state: "error",
      code: "position_unresolved",
      detail: "UEX knows no place that matches it.",
    });
  });
});

describe("Feature: the server does not use a place the page would not", () => {
  const unknown = { v: 1, state: "error", code: "position_unknown" };

  it("Given a place named just inside or outside two hours, Then the limit is the page's", async () => {
    const t = Date.parse(AT);
    // The clock stands 10 minutes after AT: a place named 1 h 50 min before the clock is in, 2 h 10 min is out.
    const inside = setup({ placeAt: new Date(t - 100 * 60_000).toISOString() });
    expect((await inside.ask({ position: "journal" })).state).toBe("ok");
    const outside = setup({ placeAt: new Date(t - 111 * 60_000).toISOString() });
    expect(await outside.ask({ position: "journal" })).toEqual(unknown);
    expect(outside.requests).toEqual([]);
  });

  it("Given a time in the future (a clock out of step), Then it is not used", async () => {
    const future = setup({ placeAt: new Date(Date.parse(AT) + 3_600_000).toISOString() });
    expect(await future.ask({ position: "journal" })).toEqual(unknown);
  });

  it("Given the newest place is private, Then there is no position: the server never reaches back to an older one", async () => {
    const priv = setup({ private: true });
    expect(await priv.ask({ position: "journal" })).toEqual(unknown);
    expect(priv.requests).toEqual([]);
  });
});

describe("Feature: the question and the cache", () => {
  it("Given the same position twice, Then the second answer comes from the memory; another place is another question", async () => {
    const { ask, requests, clock } = setup();
    await ask({ position: "journal" });
    clock.t += 60_000;
    const again = (await ask({ position: "journal" })) as SuggestOk;
    expect(again.cached).toBe(true);
    expect(requests).toHaveLength(1);
    clock.t += 60_000;
    // A plain search (no position) is not the answer of a search from a position.
    const plain = (await ask({})) as SuggestOk;
    expect(plain.cached).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.position).toBeUndefined();
  });

  it("Given the schema, Then the journal source is a flag and nothing else (a token cannot be sent), the text is bounded", () => {
    expect(suggestInputSchema.safeParse({ action: "search", position: "journal" }).success).toBe(
      true,
    );
    expect(suggestInputSchema.safeParse({ action: "search", position: TOKEN }).success).toBe(false);
    expect(
      suggestInputSchema.safeParse({ action: "search", position_text: "x".repeat(81) }).success,
    ).toBe(false);
    expect(suggestInputSchema.safeParse({ action: "search", position_text: "   " }).success).toBe(
      false,
    );
  });
});

describe("Feature: the opening step as the View receives it", () => {
  it("Given an option from a position, Then it carries step 1, the flight and both first-cycle figures, in whole numbers and minutes", async () => {
    const { ask } = setup();
    const a = (await ask({ position: "journal" })) as SuggestOk;
    const o = a.options[0]!;
    expect(o.opening).toMatchObject({
      position: "Alphaville",
      at_position: false,
      start: "Beta Port",
      reposition_minutes: 7,
      first_cycle: { profit: 32500, minutes: 60, per_hour: 32500 },
      without_step1: { profit: 30000, minutes: 60, per_hour: 30000 },
    });
    expect(o.opening!.step1).toMatchObject({
      commodity: "A1",
      from: "Alphaville",
      to: "Beta Port",
      scu: 50,
    });
    // The route itself is unchanged in meaning: its legs are the profitable route.
    expect(o.legs[0]).toMatchObject({ commodity: "B2", from: "Beta Port" });
  });

  it("Given a zero-second flight, Then it is 0 minutes, never 'about one minute'; a short one is at least one", async () => {
    const zero = setup({
      plan: async () => {
        const r = fromPosition();
        (r.options[0] as any).opening.reposition_seconds = 0;
        return r;
      },
    });
    const a = (await zero.ask({ position: "journal" })) as SuggestOk;
    expect(a.options[0]!.opening!.reposition_minutes).toBe(0);
    const short = setup({
      plan: async () => {
        const r = fromPosition();
        (r.options[0] as any).opening.reposition_seconds = 20;
        return r;
      },
    });
    expect(
      ((await short.ask({ position: "journal" })) as SuggestOk).options[0]!.opening!
        .reposition_minutes,
    ).toBe(1);
  });

  it("Given a budget that is the player's balance, Then step 1 hides what limited it and the cost is left out", async () => {
    const { ask } = setup();
    const a = (await ask({ position: "journal", budget: 5000, budget_private: true })) as SuggestOk;
    const o = a.options[0]!;
    expect(o.opening!.step1!.limited_by).toBe("hidden");
    expect(o.cost).toBeUndefined();
    expect(a.private).toBe(true);
  });

  it("Given 'apply', Then the plan is the route and its note names step 1", async () => {
    let applied: any = null;
    const svc = new TradeSuggestService({
      plan: async () => fromPosition(),
      ship: async () => ({ name: "Test Hauler", cargoScu: 100, quantumSpeedMs: 2e8 }),
      resolveOrigin: async (text) => ({ terminalName: text }),
      applyPlan: (p) => {
        applied = p;
      },
      lastPlace: () => ({ token: TOKEN, words: "x", at: AT }),
      now: () => Date.parse(AT) + 10 * 60_000,
    });
    const ok = (await svc.handle(
      suggestInputSchema.parse({ action: "search", position: "journal" }),
    )) as SuggestOk;
    await svc.handle(suggestInputSchema.parse({ action: "apply", id: ok.options[0]!.id }));
    expect(applied.commodity).toBe("B2");
    expect(applied.buy_terminal).toBe("Beta Port");
    expect(applied.note).toContain("Avant : A1 vers Beta Port");
    // The plan remembers its step-1 goods, so the opening run is its preface and not a use of it.
    expect(applied.preamble).toBe("A1");
  });
});
