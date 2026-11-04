import { describe, expect, it } from "vitest";
import type { TripPlanResult } from "../providers/uex/tripPlanner.js";
import { medicalCase, leg, option } from "./testing/tripOptionFixtures.js";
import {
  TradeSuggestService,
  resolveOriginHint,
  suggestInputSchema,
  type SuggestOk,
} from "./tradeSuggest.js";
import { fmtNum } from "./viewLogic.js";

/**
 * Feature: every option the dashboard tool returns carries a reliability block, computed on the server from the planner's own
 * data, marked "better evidenced" when a later option beats the first, and without the outlay when the budget is the balance.
 */

function result(options: ReturnType<typeof option>[], speed: number | null = null): TripPlanResult {
  return {
    objective: "profit_per_hour",
    ship: null,
    cargo_scu_used: 600,
    budget: null,
    time_model: {
      quantum_speed_ms: speed,
      spool_seconds: 10,
      stop_minutes: 8,
      local_hop_minutes: 2,
      estimate: true,
    },
    options,
    chains: [],
    lists_note: "",
    report_counts: { reported: 0, estimate: 1, unverified: 0 },
    min_reports_note: "",
    candidates_scored: 3,
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
  } as TripPlanResult;
}

function ask(res: TripPlanResult, input: Record<string, unknown> = {}) {
  const svc = new TradeSuggestService({
    plan: async () => res,
    ship: async () => null,
    resolveOrigin: async (t) => resolveOriginHint({ byTerminal: new Map() }, t),
    applyPlan: () => undefined,
    now: () => 1_000_000,
    minIntervalMs: 0,
  });
  return svc.handle(
    suggestInputSchema.parse({ action: "search", cargo_scu: 600, use_ship: false, ...input }),
  ) as Promise<SuggestOk>;
}

describe("Feature: the answer of the search carries the reliability block", () => {
  it("Given the Medical Supplies case, Then the option says 'estimate', lists its reasons and a prudent first run", async () => {
    const ok = await ask(result([medicalCase()]));
    expect(ok.state).toBe("ok");
    const rel = ok.options[0].reliability;
    expect(rel.level).toBe("estimate");
    expect(rel.label).toBe("Estimation non vérifiée");
    expect(rel.reasons.map((r) => r.code)).toEqual([
      "no_reports",
      "sell_ceiling",
      "whole_stock",
      "same_orbit",
      "sale_pressure",
    ]);
    expect(rel.reasons.every((r) => r.source.length > 0)).toBe(true);
    expect(rel.trial?.scu).toEqual([150, 150]);
    expect(rel.trial?.profit).toBe(150 * 2124 + 150 * 60);
    // the cycle of the case is 2 stops and 2 local hops: no quantum speed is needed and none is claimed
    expect(JSON.stringify(rel)).not.toContain("vitesse quantique");
  });

  it("Given a quantum speed that is unknown and a real flight, Then the card says the long flight has no duration", async () => {
    const o = option([leg()], {}, { cycle_seconds: null, profit_per_hour: null });
    const ok = await ask(result([o], null));
    expect(ok.options[0].reliability.reasons.map((r) => r.code)).toContain("no_quantum_speed");
    const known = await ask(result([option([leg()])], 238_314_300), { cargo_scu: 601 });
    expect(known.options[0].reliability.reasons.map((r) => r.code)).not.toContain(
      "no_quantum_speed",
    );
  });

  it("Given a later option better evidenced than the first, Then it is marked and the order is the planner's", async () => {
    const estimate = medicalCase();
    const reported = option([leg()]);
    const ok = await ask(result([estimate, reported]));
    expect(ok.options.map((o) => o.reliability.level)).toEqual(["estimate", "reported"]);
    expect(ok.options.map((o) => o.reliability.better_than_first === true)).toEqual([false, true]);
    expect(ok.options[0].route).toContain("Outpost One");
  });

  it("Given a budget that is the player's balance, Then no outlay appears in the block, in numbers or in words", async () => {
    const o = medicalCase();
    const priv = await ask(result([o]), { budget: 3_000_000, budget_private: true });
    const rel = priv.options[0].reliability;
    expect(rel.trial?.cost).toBeUndefined();
    const all = JSON.stringify(rel);
    expect(all).not.toContain(fmtNum(1_600_000));
    expect(all).not.toContain("immobilisés");
    expect(priv.options[0].cost).toBeUndefined();
    // the market facts are not balance-derived and are still there
    expect(rel.reasons.map((r) => r.code)).toContain("sell_ceiling");
    const open = await ask(result([medicalCase()]), { cargo_scu: 601 });
    expect(open.options[0].reliability.trial?.cost).toBe(150 * 3376);
    expect(JSON.stringify(open.options[0].reliability)).toContain(fmtNum(1_600_000));
  });

  it("Given an option the rules cannot read, Then the card still comes, at the lowest level", async () => {
    const odd = { ...option([leg()]), legs: [{ ...leg(), reports: undefined }] };
    const ok = await ask(result([odd as unknown as ReturnType<typeof option>]));
    expect(ok.options).toHaveLength(1);
    expect(ok.options[0].reliability.level).toBe("unchecked");
  });
});
