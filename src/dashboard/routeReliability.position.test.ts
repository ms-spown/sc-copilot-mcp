import { describe, expect, it } from "vitest";
import {
  forModelTool,
  type LegView,
  type TripOption,
  type TripPlanResult,
} from "../providers/uex/tripPlanner.js";
import { leg, option } from "./testing/tripOptionFixtures.js";
import { assessReliability, type ReliabilityContext } from "./routeReliability.js";
import { fmtNum } from "./viewLogic.js";

/**
 * The reliability block of a card reached from a position ("Partir de ma position"): the opening trade (step 1) is a leg of its
 * own. Its prices are evidence like the route's (level, reasons, ages), it is named "Étape 1" so it is never mixed with the route,
 * and the test run is the ROUTE's. Made-up options; amounts are whole figures through the code's own formatter.
 */

const CTX: ReliabilityContext = {
  speedKnown: true,
  stopMinutes: 8,
  localHopMinutes: 2,
  private: false,
};

const withStep = (route: LegView[], step: LegView, over: Partial<TripOption> = {}): TripOption => {
  const o = option(route, over, { flights_gm: [30, 30] });
  o.opening = {
    position: "Alphaville",
    at_position: false,
    start_terminal: route[0]!.from.terminal,
    step1: step,
    reposition_gm: 10,
    reposition_seconds: 400,
    first_cycle: { profit: 105_000, seconds: 2400, profit_per_hour: 157_500 },
    without_step1: { profit: 100_000, seconds: 2400, profit_per_hour: 150_000 },
  };
  return o;
};

describe("Feature: step 1's prices are evidence of the card", () => {
  it("Given a reported route and a step 1 with no player report, Then the level is partial and the count includes the step's two prices", () => {
    const o = withStep(
      [leg()],
      leg({
        commodity: "Opening",
        reports: { origin: 0, destination: 0 },
        report_status: "estimate",
      }),
    );
    const r = assessReliability(o, CTX);
    expect(r.level).toBe("partial");
    expect(r.reasons[0]!.code).toBe("no_reports");
    expect(r.reasons[0]!.text).toContain(`${fmtNum(2)} prix sur ${fmtNum(4)} sans relevé joueur`);
    expect(r.why).toBe("relevés partiels");
  });

  it("Given a reported route and a reported step 1, Then it stays 'reported' and says nothing more", () => {
    const r = assessReliability(withStep([leg()], leg({ commodity: "Opening" })), CTX);
    expect(r.level).toBe("reported");
    expect(r.reasons).toEqual([]);
  });

  it("Given an unreported route and a reported step 1, Then the level is partial too (the same rule over all the prices)", () => {
    const o = withStep(
      [leg({ reports: { origin: 0, destination: 0 }, report_status: "estimate" })],
      leg({ commodity: "Opening" }),
    );
    expect(assessReliability(o, CTX).level).toBe("partial");
  });

  it("Given a step 1 that takes the whole stock, Then the reason is named 'Étape 1', and the route's own is named 'Route'", () => {
    const o = withStep(
      [leg({ limited_by: "stock" })],
      leg({ commodity: "Opening", limited_by: "stock", scu: 80 }),
    );
    const r = assessReliability(o, CTX);
    const stock = r.reasons.find((x) => x.code === "whole_stock")!;
    expect(stock.text).toContain(`Route : le plan achète tout le stock affiché (${fmtNum(200)}`);
    expect(stock.text).toContain(`Étape 1 : le plan achète tout le stock affiché (${fmtNum(80)}`);
  });

  it("Given an old step 1 price, Then 'prix anciens' names the step, not a leg of the route", () => {
    const o = withStep(
      [leg(), leg({ commodity: "Back" })],
      leg({ commodity: "Opening", price_age_days: { buy: 2.5, sell: 0.4 } }),
    );
    const old = assessReliability(o, CTX).reasons.find((x) => x.code === "old_prices")!;
    expect(old.text).toContain(`achat étape 1 mis à jour il y a ${fmtNum(2.5, 1)}`);
    expect(old.text).not.toContain("achat retour");
  });

  it("Given no step 1 (or an empty flight), Then nothing changes: the same wording as before, no 'Route' prefix", () => {
    const plain = option([leg({ limited_by: "stock" })], {}, { flights_gm: [30, 30] });
    const text = assessReliability(plain, CTX).reasons.find((x) => x.code === "whole_stock")!.text;
    expect(text.startsWith("le plan achète tout le stock")).toBe(true);
    const empty = withStep([leg({ limited_by: "stock" })], leg());
    empty.opening!.step1 = null;
    const t2 = assessReliability(empty, CTX).reasons.find((x) => x.code === "whole_stock")!.text;
    expect(t2.startsWith("le plan achète tout le stock")).toBe(true);
    expect(assessReliability(empty, CTX).trial!.lines.join(" ")).not.toContain(
      "Ce test porte sur la route",
    );
  });
});

describe("Feature: the test run is the route's; step 1 stays a separate leg", () => {
  it("Given a step 1, Then the test quantities are the route's legs only, and the card says step 1 is apart", () => {
    const o = withStep([leg({ scu: 400 })], leg({ commodity: "Opening", scu: 90 }));
    const t = assessReliability(o, CTX).trial!;
    expect(t.scu).toEqual([100]);
    expect(t.profit).toBe(100 * 500);
    const text = t.lines.join(" ");
    expect(text).toContain(`Premier trajet de test : ${fmtNum(100)}`);
    expect(text).toContain("Ce test porte sur la route. L’étape 1 reste un trajet à part");
    // The step's own quantity is not in the test.
    expect(text).not.toContain(fmtNum(90) + "\u00a0SCU");
  });

  it("Given a budget that is the balance, Then no outlay is written, with a step 1 as without", () => {
    const o = withStep([leg()], leg({ commodity: "Opening" }));
    expect(assessReliability(o, { ...CTX, private: true }).trial).not.toHaveProperty("cost");
  });
});

describe("Feature: the model tool never gets the market facts or bodies, step 1 included", () => {
  it("Given an option with market and body everywhere, Then forModelTool leaves neither on the legs nor on the opening step", () => {
    const o = withStep([leg(), leg({ commodity: "Back" })], leg({ commodity: "Opening" }));
    const result = { options: [o], chains: [] } as unknown as TripPlanResult;
    const text = JSON.stringify(forModelTool(result));
    expect(text).not.toContain('"market"');
    expect(text).not.toContain('"body"');
    // And the original is untouched (the dashboard keeps them).
    expect(JSON.stringify(result)).toContain('"market"');
    expect(JSON.stringify(result)).toContain('"body"');
    // Everything else of the step survives.
    expect(forModelTool(result).options[0]!.opening!.step1!.commodity).toBe("Opening");
  });
});
