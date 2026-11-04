import { describe, expect, it } from "vitest";
import type { TripOption } from "../providers/uex/tripPlanner.js";
import { leg, medicalCase, option } from "./testing/tripOptionFixtures.js";
import {
  assessReliability,
  levelOf,
  markBetterChecked,
  safeAssessReliability,
  trialQuantity,
  RELIABLE_MAX_AGE_DAYS,
  type Reliability,
  type ReliabilityContext,
} from "./routeReliability.js";
import { fmtNum } from "./viewLogic.js";

/**
 * Feature: the reliability block of a route card. Pure rules over synthetic planner options (made-up terminals and prices,
 * nothing real). Amounts are matched as WHOLE figures through the same formatter as the code.
 */

const CTX: ReliabilityContext = {
  speedKnown: true,
  stopMinutes: 8,
  localHopMinutes: 2,
  private: false,
};

const codes = (r: Reliability) => r.reasons.map((x) => x.code);

describe("Feature: the level of the evidence behind the prices", () => {
  const end = (reports: number | null, age: number | null = 1) => ({ reports, age });

  it("Given every price rests on a recent player report, Then the level is 'reported'", () => {
    expect(levelOf([end(3), end(1), end(7), end(2)])).toBe("reported");
  });

  it("Given a reported price older than the limit, Then the level drops to 'partial', and an undated one does too", () => {
    expect(levelOf([end(3), end(3, RELIABLE_MAX_AGE_DAYS)])).toBe("reported");
    expect(levelOf([end(3), end(3, RELIABLE_MAX_AGE_DAYS + 0.1)])).toBe("partial");
    expect(levelOf([end(3), end(3, null)])).toBe("partial");
  });

  it("Given some prices reported and some not (or unknown), Then the level is 'partial'", () => {
    expect(levelOf([end(3), end(0)])).toBe("partial");
    expect(levelOf([end(3), end(null)])).toBe("partial");
  });

  it("Given no price has a player report and UEX counts zero on one, Then the level is 'estimate'", () => {
    expect(levelOf([end(0), end(0)])).toBe("estimate");
    expect(levelOf([end(0), end(null)])).toBe("estimate");
  });

  it("Given no report count could be read at all, Then the level is 'unchecked', never 'estimate' and never 'reported'", () => {
    expect(levelOf([end(null), end(null)])).toBe("unchecked");
  });
});

describe("Feature: each signal on its own gives one reason, with its source", () => {
  it("Given nothing worrying, Then a reported single-leg route has a level, no reason, and still the limits sentence", () => {
    const r = assessReliability(option([leg()], {}, { flights_gm: [30, 30] }), CTX);
    expect(r.level).toBe("reported");
    expect(r.label).toBe("Relevée par des joueurs");
    expect(r.reasons).toEqual([]);
    expect(r.limits).toContain("temps de chargement");
    expect(r.limits).toContain("carburant");
    expect(r.limits).toContain("taille des pads");
    expect(r.limits).toContain("piraterie");
    expect(r.why).toBe("relevée par des joueurs");
  });

  it("Given a price with no player report, Then 'no_reports' says how many prices and that they are UEX estimates", () => {
    const r = assessReliability(
      option([leg({ reports: { origin: 0, destination: 0 }, report_status: "estimate" })]),
      CTX,
    );
    expect(r.level).toBe("estimate");
    expect(codes(r)).toEqual(["no_reports"]);
    expect(r.reasons[0].text).toContain(`0 relevé joueur sur cette route`);
    expect(r.reasons[0].text).toContain(`les ${fmtNum(2)} prix sont des estimations UEX`);
    expect(r.reasons[0].source).toContain("UEX");
    expect(r.why).toBe("aucun relevé joueur");
  });

  it("Given one of two prices without a report, Then the level is 'partial' and the reason counts it", () => {
    const r = assessReliability(
      option([leg({ reports: { origin: 5, destination: 0 }, report_status: "estimate" })]),
      CTX,
    );
    expect(r.level).toBe("partial");
    expect(r.reasons[0].text).toContain(`${fmtNum(1)} prix sur ${fmtNum(2)} sans relevé joueur`);
  });

  it("Given a price that never moved in UEX's range and has no report, Then the reason says it looks carried over, with the price", () => {
    const r = assessReliability(
      option([
        leg(
          { reports: { origin: 0, destination: 3 }, buy_price: 3376, report_status: "estimate" },
          { buy_range: { low: 3376, high: 3376 } },
        ),
      ]),
      CTX,
    );
    const text = r.reasons[0].text;
    expect(text).toContain("n’a jamais varié");
    expect(text).toContain(`achat ${fmtNum(3376)}`);
    expect(text).toContain("valeur reportée");
  });

  it("Given a flat price WITH a player report, Then it is not called carried over", () => {
    const r = assessReliability(option([leg({}, { buy_range: { low: 1000, high: 1000 } })]), CTX);
    expect(codes(r)).toEqual([]);
  });

  it("Given a sell price at the top of a real range, Then 'sell_ceiling' names the price and the range", () => {
    const r = assessReliability(
      option([leg({ sell_price: 5500 }, { sell_range: { low: 4800, high: 5500 } })]),
      CTX,
    );
    expect(codes(r)).toEqual(["sell_ceiling"]);
    const t = r.reasons[0].text;
    expect(t).toContain(fmtNum(5500));
    expect(t).toContain(`${fmtNum(4800)} à ${fmtNum(5500)}`);
    expect(t).not.toContain("terminaux sur");
    expect(r.reasons[0].source).toContain("fourchette");
    expect(r.reasons[0].source).toContain("prix relevé il y a");
  });

  it("Given several terminals at exactly that price, Then the reason says how many of how many", () => {
    const r = assessReliability(
      option([
        leg(
          { sell_price: 5500 },
          { sell_range: { low: 4800, high: 5500 }, sell_peers: { same_price: 6, priced: 8 } },
        ),
      ]),
      CTX,
    );
    expect(r.reasons[0].text).toContain(
      `${fmtNum(6)} terminaux sur ${fmtNum(8)} affichent exactement ce prix`,
    );
  });

  it("Given a sell price below the top, or a range that never moved, Then there is no ceiling reason", () => {
    expect(
      codes(
        assessReliability(
          option([leg({ sell_price: 5000 }, { sell_range: { low: 4800, high: 5500 } })]),
          CTX,
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        assessReliability(
          option([leg({ sell_price: 5500 }, { sell_range: { low: 5500, high: 5500 } })]),
          CTX,
        ),
      ),
    ).toEqual([]);
  });

  it("Given a plan limited by the stock, Then 'whole_stock' says the price rises as the stock drops and that it is not modelled", () => {
    const r = assessReliability(option([leg({ limited_by: "stock", scu: 597 })]), CTX);
    expect(codes(r)).toEqual(["whole_stock"]);
    expect(r.reasons[0].text).toContain(`tout le stock affiché (${fmtNum(597)}\u00a0SCU)`);
    expect(r.reasons[0].text).toContain("le prix monte quand le stock baisse");
    expect(r.reasons[0].text).toContain("pas modélisé");
  });

  it("Given a plan limited by the hold or the budget, Then there is no whole-stock reason", () => {
    expect(codes(assessReliability(option([leg({ limited_by: "cargo" })]), CTX))).toEqual([]);
    expect(codes(assessReliability(option([leg({ limited_by: "budget" })]), CTX))).toEqual([]);
  });

  it("Given a buyer at 72-85 % of its inventory, Then 'sale_pressure' quotes UEX's own warning and percentage", () => {
    const r = assessReliability(
      option([leg({}, { sell_inventory: { code: 6, fill: "72-85%" } })]),
      CTX,
    );
    expect(codes(r)).toEqual(["sale_pressure"]);
    expect(r.reasons[0].text).toContain("72 à 85%");
    expect(r.reasons[0].text).toContain("UEX prévient que le prix baisse vite");
  });

  it("Given a buyer at a lower inventory level, Then there is no sale-pressure reason", () => {
    expect(
      codes(
        assessReliability(option([leg({}, { sell_inventory: { code: 4, fill: "44-57%" } })]), CTX),
      ),
    ).toEqual([]);
  });

  it("Given a plan that sells more than the terminal asks for, Then the reason gives both quantities", () => {
    const r = assessReliability(option([leg({ destination_demand_scu: 120, scu: 200 })]), CTX);
    expect(codes(r)).toEqual(["sale_pressure"]);
    expect(r.reasons[0].text).toContain(`${fmtNum(200)}\u00a0SCU`);
    expect(r.reasons[0].text).toContain(`${fmtNum(120)}\u00a0SCU`);
  });

  it("Given a thin margin, Then the reason gives the share and the amount tied up, and leaves the amount out for a private plan", () => {
    const thin = leg({ buy_price: 2000, sell_price: 2150, profit_per_scu: 150, cost: 1_600_000 });
    const shown = assessReliability(option([thin]), CTX);
    expect(codes(shown)).toEqual(["sale_pressure"]);
    expect(shown.reasons[0].text).toContain(`${fmtNum(7.5, 1)}\u00a0% du prix d’achat`);
    expect(shown.reasons[0].text).toContain(`${fmtNum(1_600_000)}\u00a0aUEC immobilisés`);
    const hidden = assessReliability(option([thin]), { ...CTX, private: true });
    expect(hidden.reasons[0].text).toContain("7,5");
    expect(hidden.reasons[0].text).not.toContain(fmtNum(1_600_000));
    expect(hidden.reasons[0].text).not.toContain("immobilisés");
  });

  it("Given a margin of exactly ten percent, Then it is not thin", () => {
    expect(
      codes(assessReliability(option([leg({ buy_price: 1000, profit_per_scu: 100 })]), CTX)),
    ).toEqual([]);
  });

  it("Given two terminals UEX puts in the same orbit on different bodies, Then 'same_orbit' says the flight is a local hop", () => {
    const r = assessReliability(
      option([leg()], {}, { flights_gm: [0, 0], cycle_seconds: 20 * 60 }),
      CTX,
    );
    expect(codes(r)).toEqual(["same_orbit"]);
    const t = r.reasons[0].text;
    expect(t).toContain("même orbite (0\u00a0Gm)");
    expect(t).toContain("deux corps différents");
    expect(t).toContain(`saut local de ${fmtNum(2)}\u00a0min`);
    expect(t).toContain(`cycle estimé (${fmtNum(20)}\u00a0min)`);
    expect(t).toContain(`arrêts de ${fmtNum(8)}\u00a0min`);
  });

  it("Given the same orbit AND the same body, Then the reason does not claim different bodies", () => {
    const here = leg();
    here.to.body = here.from.body;
    const r = assessReliability(option([here], {}, { flights_gm: [0, 0] }), CTX);
    expect(codes(r)).toEqual(["same_orbit"]);
    expect(r.reasons[0].text).not.toContain("deux corps différents");
  });

  it("Given a real flight, Then there is no same-orbit reason", () => {
    expect(codes(assessReliability(option([leg()], {}, { flights_gm: [12, 12] }), CTX))).toEqual(
      [],
    );
  });

  it("Given prices two days old or more, Then 'old_prices' gives each age; given fresher prices, Then nothing", () => {
    const r = assessReliability(option([leg({ price_age_days: { buy: 2.9, sell: 0.9 } })]), CTX);
    expect(codes(r)).toEqual(["old_prices"]);
    expect(r.reasons[0].text).toContain(`achat relevé il y a ${fmtNum(2.9, 1)}\u00a0j`);
    expect(r.reasons[0].text).not.toContain("vente relevé");
    expect(
      codes(assessReliability(option([leg({ price_age_days: { buy: 1.9, sell: 0.9 } })]), CTX)),
    ).toEqual([]);
  });

  it("Given no quantum speed and a flight longer than a hop, Then the reason says long flights have no duration", () => {
    const r = assessReliability(
      option([leg()], {}, { cycle_seconds: null, profit_per_hour: null }),
      { ...CTX, speedKnown: false },
    );
    expect(codes(r)).toEqual(["no_quantum_speed"]);
    expect(r.reasons[0].text).toContain("vitesse quantique");
  });

  it("Given no quantum speed but only local hops, Then the missing speed is not blamed", () => {
    const r = assessReliability(option([leg()], {}, { flights_gm: [0, 0] }), {
      ...CTX,
      speedKnown: false,
    });
    expect(codes(r)).toEqual(["same_orbit"]);
  });

  it("Given a commodity no terminal has a report for, Then the reason gives the number of terminals", () => {
    const r = assessReliability(
      option([leg({}, { commodity_reports: { reported: 0, terminals: 41 } })]),
      CTX,
    );
    expect(codes(r)).toEqual(["commodity_unreported"]);
    expect(r.reasons[0].text).toContain(`${fmtNum(41)} terminaux`);
  });

  it("Given a commodity with only a few terminals, or some reports, Then nothing is said", () => {
    expect(
      codes(
        assessReliability(
          option([leg({}, { commodity_reports: { reported: 0, terminals: 4 } })]),
          CTX,
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        assessReliability(
          option([leg({}, { commodity_reports: { reported: 2, terminals: 41 } })]),
          CTX,
        ),
      ),
    ).toEqual([]);
  });

  it("Given a leg whose market facts were not read, Then no market reason appears and the level is untouched", () => {
    const r = assessReliability(option([leg({ limited_by: "cargo" }, null)]), CTX);
    expect(r.reasons).toEqual([]);
    expect(r.level).toBe("reported");
  });

  it("Given report counts that could not be checked, Then the level is 'unchecked' and says so, with no estimate claim", () => {
    const r = assessReliability(
      option([leg({ reports: { origin: null, destination: null }, report_status: "unverified" })]),
      CTX,
    );
    expect(r.level).toBe("unchecked");
    expect(codes(r)).toEqual(["unchecked"]);
    expect(r.reasons[0].text).not.toContain("estimations UEX");
    expect(r.evidence_rank).toBe(0);
  });
});

describe("Feature: the reasons are bounded and ordered", () => {
  it("Given the Medical Supplies case (the agent's findings), Then the level is 'estimate' and five reasons come first, most decisive first", () => {
    const r = assessReliability(medicalCase(), { ...CTX, speedKnown: false });
    expect(r.level).toBe("estimate");
    expect(r.label).toBe("Estimation non vérifiée");
    expect(codes(r)).toEqual([
      "no_reports",
      "sell_ceiling",
      "whole_stock",
      "same_orbit",
      "sale_pressure",
    ]);
    // what did not fit is named, not dropped
    expect(r.others).toEqual(["prix anciens", "marchandise jamais relevée"]);
    const text = r.reasons.map((x) => x.text).join(" ");
    expect(text).toContain(`0 relevé joueur sur cette route`);
    expect(text).toContain(`achat aller ${fmtNum(3376)}`);
    expect(text).toContain(`${fmtNum(6)} terminaux sur ${fmtNum(8)}`);
    expect(text).toContain(`tout le stock affiché (${fmtNum(597)}\u00a0SCU)`);
    expect(text).toContain("deux corps différents");
    expect(text).toContain("72 à 85%");
    expect(text).toContain(`${fmtNum(7.5, 1)}\u00a0% du prix d’achat`);
    expect(r.why).toBe("aucun relevé joueur");
    // the second leg's sentence is the "Retour" one
    expect(r.reasons[4].text.startsWith("Retour : ")).toBe(true);
    // never a guarantee
    expect(JSON.stringify(r)).not.toMatch(/sûr|garanti|certain/i);
  });

  it("Given every signal at once, Then at most five reasons are returned", () => {
    const l = leg(
      {
        limited_by: "stock",
        reports: { origin: 0, destination: 0 },
        price_age_days: { buy: 5, sell: 5 },
        destination_demand_scu: 10,
      },
      {
        sell_range: { low: 1, high: 1500 },
        sell_inventory: { code: 6, fill: "72-85%" },
        commodity_reports: { reported: 0, terminals: 30 },
      },
    );
    const r = assessReliability(option([l], {}, { flights_gm: [0, 0] }), {
      ...CTX,
      speedKnown: false,
    });
    expect(r.reasons.length).toBeLessThanOrEqual(5);
    expect(r.reasons.length + r.others.length).toBeGreaterThan(5);
  });

  it("Given the same option twice, Then the answer is identical (pure)", () => {
    const o = medicalCase();
    expect(assessReliability(o, CTX)).toEqual(assessReliability(o, CTX));
  });
});

describe("Feature: the prudent first run", () => {
  it("Given a hold bigger than the bounds, Then the test is a quarter of it, between 100 and 150 SCU", () => {
    expect(trialQuantity(597)).toBe(150);
    expect(trialQuantity(696)).toBe(150);
    expect(trialQuantity(500)).toBe(125);
    expect(trialQuantity(400)).toBe(100);
    expect(trialQuantity(200)).toBe(100);
  });

  it("Given a small plan, Then the test never exceeds it", () => {
    expect(trialQuantity(96)).toBe(96);
    expect(trialQuantity(100)).toBe(100);
    expect(trialQuantity(32)).toBe(32);
    expect(trialQuantity(1)).toBe(1);
  });

  it("Given a big plan, Then the test is sized from the same per-SCU margin and says to check, measure and scale up later", () => {
    const r = assessReliability(
      option([leg({ scu: 597, profit_per_scu: 2124, buy_price: 3376 })]),
      CTX,
    );
    const t = r.trial!;
    expect(t.scu).toEqual([150]);
    expect(t.whole).toBe(false);
    expect(t.profit).toBe(150 * 2124);
    expect(t.cost).toBe(150 * 3376);
    const text = t.lines.join(" ");
    expect(text).toContain(`${fmtNum(150)}\u00a0SCU au lieu de ${fmtNum(597)}\u00a0SCU`);
    expect(text).toContain(fmtNum(150 * 2124));
    expect(text).toContain("estimation");
    expect(text).toContain("prix et le stock réels");
    expect(text).toContain("prix de vente réel");
    expect(text).toContain("durée réelle du cycle");
    expect(text).toContain("augmente la quantité seulement ensuite");
  });

  it("Given two legs, Then each leg gets its own test quantity", () => {
    const r = assessReliability(
      option([leg({ scu: 597, profit_per_scu: 100 }), leg({ scu: 80, profit_per_scu: 10 })]),
      CTX,
    );
    expect(r.trial!.scu).toEqual([150, 80]);
    expect(r.trial!.profit).toBe(150 * 100 + 80 * 10);
  });

  it("Given a plan already small, Then the test is the whole plan and says so", () => {
    const r = assessReliability(option([leg({ scu: 64 })]), CTX);
    expect(r.trial!.whole).toBe(true);
    expect(r.trial!.lines[0]).toContain("déjà petit");
  });

  it("Given a plan sized from the balance, Then the outlay is left out of the answer and of its sentences", () => {
    const r = assessReliability(option([leg({ scu: 597, buy_price: 3376 })]), {
      ...CTX,
      private: true,
    });
    expect(r.trial!.cost).toBeUndefined();
    expect(r.trial!.lines.join(" ")).not.toContain(fmtNum(150 * 3376));
  });

  it("Given a leg without a usable quantity, Then there is no test run", () => {
    expect(assessReliability(option([leg({ scu: 0 })]), CTX).trial).toBeNull();
  });
});

describe("Feature: better-evidenced options are marked, never reordered", () => {
  const rel = (rank: 0 | 1 | 2 | 3): { reliability: Reliability } => ({
    reliability: { ...assessReliability(option([leg()]), CTX), evidence_rank: rank },
  });

  it("Given a later option better evidenced than the first, Then only it is marked", () => {
    const list = [rel(1), rel(3), rel(1), rel(2)];
    const order = list.slice();
    markBetterChecked(list);
    expect(list.map((o) => o.reliability.better_than_first === true)).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(list).toEqual(order);
  });

  it("Given a first option that is already the best evidenced, Then nothing is marked", () => {
    const list = [rel(3), rel(3), rel(1)];
    markBetterChecked(list);
    expect(list.some((o) => o.reliability.better_than_first)).toBe(false);
  });

  it("Given an empty list or options with no reliability, Then it does nothing and does not throw", () => {
    expect(() => markBetterChecked([])).not.toThrow();
    expect(() => markBetterChecked([{}, {}])).not.toThrow();
  });
});

describe("Feature: the block never takes a card down", () => {
  it("Given an option the rules cannot read, Then the safe version answers 'unchecked' with no reason and no test", () => {
    const r = safeAssessReliability({ legs: [{}] } as unknown as TripOption, CTX);
    expect(r.level).toBe("unchecked");
    expect(r.reasons).toEqual([]);
    expect(r.trial).toBeNull();
  });
});
