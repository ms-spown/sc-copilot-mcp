/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import type { CalibrationSection } from "../providers/sessions/calibration.js";
import { buildCalibration, calibrationForPoll } from "../providers/sessions/calibration.js";
import { NOW as SESSION_NOW, session } from "../providers/sessions/fixtures.testing.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import { figure } from "../testing/replay/audit.js";
import {
  calibrationCompare,
  calibrationExpected,
  calibrationFromLedger,
  calibrationHuge,
  calibrationLine,
  calibrationNextTile,
  calibrationNormalize,
  calibrationPct,
  calibrationPick,
} from "./calibrationPanel.js";
import { boundLedger, buildLedgerPayload, EMPTY_LEDGER } from "./ledger.js";
import {
  ledgerChannelClean,
  ledgerNum,
  ledgerOneOf,
  ledgerStripBalance,
  ledgerText,
} from "./ledgerPanel.js";
import { DashboardService } from "./service.js";
import { fmtAuec } from "./viewLogic.js";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { specsSamples } from "./testing/specsFixtures.js";
import { suggestAnswer } from "./testing/suggestFixtures.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * Feature: the route calibration in the dashboard. The figures are the player's own runs against their plans: an estimate
 * with its number of runs. They are derived from the balance, so they exist only where the balance is shown. Every
 * figure here is invented.
 */

const L = { ledgerNum, ledgerText, ledgerOneOf };
const SECOND = 1000;
/** A right-to-left override, built from its code point (the repository refuses it as a literal). */
const BIDI = String.fromCodePoint(0x202e);
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** Ratios chosen so that they cannot appear by chance anywhere else in an answer. */
const GROSS = 0.737;
const NET = 0.762;
const FEE = 0.137;
/** The mean amounts behind the ratios, made up so that none can appear by chance (each is a whole figure when scanned). */
const GROSS_AVG = 91_337;
const GROSS_PLANNED = 123_941;
const NET_AVG = 94_411;
const NET_PLANNED = 123_901;
const MEANS = [GROSS_AVG, GROSS_PLANNED, NET_AVG, NET_PLANNED];
const WIRE =
  /0\.737|0\.762|0\.137|gross_ratio|net_ratio|fee_rate|"calibration"|gross_avg_auec|net_avg_auec|planned_avg_auec/;

const group = (over: Record<string, unknown> = {}) => ({
  kind: "commodity",
  commodity: "Laranite",
  buy_terminal: null,
  sell_terminal: null,
  n: 4,
  confidence: "medium",
  reasons: [],
  gross_ratio: GROSS,
  gross_median: 0.74,
  gross_min: 0.65,
  gross_max: 0.83,
  gross_avg_auec: GROSS_AVG,
  gross_planned_avg_auec: GROSS_PLANNED,
  high_variance: false,
  net_ratio: NET,
  net_n: 4,
  net_avg_auec: NET_AVG,
  net_planned_avg_auec: NET_PLANNED,
  net_confidence: "medium",
  fee_rate: FEE,
  fee_n: 4,
  fee_measured: 4,
  last_run_at: "2026-11-03T18:00:00.000Z",
  last_run_age_days: 1,
  quantity_adjusted: 0,
  quantity_unknown: 0,
  unknown_version: 0,
  linked_by_prices: 4,
  excluded: { old: 0, other_patch: 0, quantity: 0, beyond_last: 0 },
  ...over,
});
const route = group({ kind: "route", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD" });
const gold = group({
  commodity: "Gold",
  goods_unverified: true,
  n: 2,
  confidence: "low",
  reasons: ["few_runs"],
  net_n: 0,
  net_ratio: null,
});
const SECTION: CalibrationSection = {
  v: 1,
  patch_line: "4.10",
  groups: [group(), gold, route] as never,
};

describe("Feature: the section is rebuilt field by field in the View", () => {
  it("Given a hostile section, Then unknown fields, long text, bad numbers and thin groups are dropped", () => {
    const n = calibrationNormalize(L, {
      v: 1,
      patch_line: "4.10<script>alert(1)</script>".padEnd(40, "x"),
      evil: "x",
      groups: [
        { ...group(), commodity: ("Laranite" + BIDI).padEnd(200, "z"), evil: { a: 1 }, n: 1e12 },
        { ...group(), n: 1 }, // one run: never a figure
        { ...group(), gross_ratio: "0.9" }, // a string is not a number
        { ...group(), gross_ratio: 9e99 },
        { ...group(), confidence: "certain" },
        "nope",
        null,
      ],
    });
    expect(n.patch_line.length).toBeLessThanOrEqual(12);
    // kept: the long one, the huge ratio and the unknown confidence; dropped: one run, a string, junk
    expect(n.groups).toHaveLength(3);
    expect(n.groups[0].commodity.length).toBeLessThanOrEqual(60);
    expect(n.groups[0].commodity).not.toContain(BIDI);
    expect(n.groups[0].n).toBeLessThanOrEqual(999);
    expect(n.groups[0]).not.toHaveProperty("evil");
    expect(n.groups[1].gross_ratio).toBe(100); // clamped, finite
    expect(n.groups[2].confidence).toBe("low");
    expect(calibrationNormalize(L, { v: 2, groups: [] })).toBeNull();
    expect(calibrationNormalize(L, null)).toBeNull();
    expect(calibrationFromLedger(L, { calibration: SECTION })!.groups).toHaveLength(3);
    expect(calibrationFromLedger(L, {})).toBeNull();
  });

  it("Given more groups than the View keeps, Then the surplus is dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) => group({ commodity: `Goods ${i}` }));
    expect(calibrationNormalize(L, { v: 1, groups: many })!.groups).toHaveLength(14);
  });
});

describe("Feature: the line under a suggestion is quiet, honest and tied to its own goods", () => {
  const calib = calibrationNormalize(L, SECTION)!;

  it("Given a route with four runs, Then the line gives n, the realised share, the fee rate and the confidence, as an estimate", () => {
    const line = calibrationLine(calib, "Laranite", "Port Tressler", "Area18 TDD");
    expect(NBSP_FREE(line.text)).toBe(
      "D’après tes 4 trajets sur cette route : tu réalises ≈ 74 % du prévu (frais ≈ 14 %).",
    );
    expect(line.more).toContain("la marge brute");
    expect(line.tag).toBe("estimé · 4 trajets · confiance moyenne");
    expect(line.scope).toBe("route");
  });

  it("Given another route of the same goods, Then the goods' own group answers and the line says 'de cette marchandise'", () => {
    const line = calibrationLine(calib, "laranite", "Lorville CBD", "Area18 TDD");
    expect(line.scope).toBe("commodity");
    expect(line.text).toContain("D’après tes 4 trajets de cette marchandise");
  });

  it("Given two runs, Then the line says that few runs only give an indication", () => {
    const line = calibrationLine(calib, "Gold", "Everus Harbor", "Seraphim Station");
    // the plan was tied to these runs by their prices: they only resemble it, and the line says the goods are unverified
    expect(NBSP_FREE(line.text)).toContain(
      "D’après tes 2 trajets similaires (marchandise non vérifiée)",
    );
    expect(line.more).toContain("lien par prix");
    expect(line.hint).toMatch(/plafonnée à « moyenne »/);
    expect(line.text).toContain("Peu de trajets : indicatif seulement.");
    // a low confidence stays in the visible words
    expect(line.tag).toBe("estimé · 2 trajets · confiance faible");
  });

  it("Given wild results, Then the range is shown", () => {
    const wild = calibrationNormalize(L, {
      v: 1,
      groups: [
        group({ high_variance: true, gross_min: 0.2, gross_max: 1.1, confidence: "low", n: 5 }),
      ],
    })!;
    const line = calibrationLine(wild, "Laranite", null, null);
    expect(NBSP_FREE(line.text)).toContain("Résultats très variables (de 20 % à 110 %).");
  });

  it("Given goods with no group, a prefix of a name, another goods or no data, Then nothing is said and nothing is borrowed", () => {
    expect(calibrationLine(calib, "Agricium", null, null)).toBeNull();
    expect(calibrationLine(calib, "Lara", null, null)).toBeNull();
    expect(calibrationLine(calib, "Laranite Ore", null, null)).toBeNull();
    expect(calibrationLine(calib, "", null, null)).toBeNull();
    expect(calibrationLine(null, "Laranite", null, null)).toBeNull();
    expect(calibrationPick({ groups: [] }, "Laranite", null, null)).toBeNull();
  });
});

describe("Feature: the calibrated expectation and the tile 'Si tu refais ce trajet'", () => {
  const calib = calibrationNormalize(L, SECTION)!;
  const plan = {
    commodity: "Laranite",
    buy_terminal: "Port Tressler",
    sell_terminal: "Area18 TDD",
    scu: 696,
    sell_unit_price: 457,
  };

  it("Given the net ratio of four runs, Then the tile is the planned profit times it, an estimate with n and the confidence", () => {
    const tile = calibrationNextTile(calib, plan, { planned_profit: 180_000 });
    expect(tile.auec).toBe(Math.round(180_000 * NET));
    expect(tile.tag).toBe("estimé · 4 trajets · confiance moyenne");
    expect(tile.hint).toContain("Confiance moyenne.");
    expect(NBSP_FREE(tile.sub)).toBe("prévu × 76 % (net typique de tes 4 trajets sur cette route)");
    expect(tile.basis).toBe("net_ratio");
  });

  it("Given two runs without a net ratio, Then the gross ratio less the usual fees on the plan's turnover is used, and said", () => {
    const only = calibrationNormalize(L, {
      v: 1,
      groups: [group({ net_ratio: null, net_n: 0, n: 3, fee_n: 3, confidence: "low" })],
    })!;
    const tile = calibrationNextTile(
      only,
      { ...plan, buy_terminal: "", sell_terminal: "" },
      {
        planned_profit: 180_000,
      },
    );
    // 180 000 x 0.737 minus 0.137 x (457 x 696)
    expect(tile.auec).toBe(Math.round(180_000 * GROSS - FEE * 457 * 696));
    expect(NBSP_FREE(tile.sub)).toBe(
      "prévu × 74 % (marge brute typique de tes 3 trajets sur cette marchandise), moins les frais habituels (14 % du chiffre d’affaires du plan) · peu de trajets : indicatif seulement",
    );
    expect(tile.tag).toBe("estimé · 3 trajets · confiance faible");
    // no turnover for the plan: nothing is invented
    expect(
      calibrationNextTile(only, { commodity: "Laranite" }, { planned_profit: 180_000 }),
    ).toBeNull();
  });

  it("Given no plan figure, another goods or fewer than two runs, Then the tile keeps the card's own figure (null here)", () => {
    expect(calibrationNextTile(calib, plan, { planned_profit: null })).toBeNull();
    expect(
      calibrationNextTile(calib, { ...plan, commodity: "Agricium" }, { planned_profit: 1 }),
    ).toBeNull();
    expect(calibrationNextTile(calib, null, { planned_profit: 1 })).toBeNull();
    expect(calibrationExpected(null, 100)).toBeNull();
  });

  it("Given two runs, Then the tile gives no coefficient (the same 3-run minimum as the route cards); given three, Then it does", () => {
    const two = calibrationNormalize(L, {
      v: 1,
      groups: [group({ n: 2, net_n: 2, fee_n: 2, confidence: "low" })],
    })!;
    expect(calibrationNextTile(two, plan, { planned_profit: 180_000 })).toBeNull();
    const three = calibrationNormalize(L, {
      v: 1,
      groups: [group({ n: 3, net_n: 3, fee_n: 3, confidence: "low", net_confidence: "low" })],
    })!;
    const tile = calibrationNextTile(three, plan, { planned_profit: 180_000 });
    expect(tile.auec).toBe(Math.round(180_000 * NET));
    expect(tile.tag).toBe("estimé · 3 trajets · confiance faible");
    // the card and the tile agree: the same group gives a figure to both, or to neither
    const leg = {
      commodity: "Laranite",
      from: "Port Tressler",
      to: "Area18 TDD",
      buy_price: 189,
      sell_price: 457,
      profit_per_scu: 258,
      scu: 696,
    };
    for (const c of [two, three]) {
      const card = calibrationCompare({ ...L, fmtAuec }, c, {
        legs: [leg],
        profit_per_trip: 180_000,
        profit_per_hour: null,
        cycle_minutes: null,
      });
      const t = calibrationNextTile(c, plan, {
        planned_profit: Math.round(leg.profit_per_scu * leg.scu),
      });
      expect(
        card.apply !== "" && card.mode === "ratio" && !card.apply.startsWith("Pas assez"),
      ).toBe(t !== null);
    }
  });

  it("Given three runs but a net on two only and fees on two, Then the tile gives nothing (no figure rests on fewer than three runs); with fees on three it falls back to the gross ratio less fees", () => {
    const thin = calibrationNormalize(L, {
      v: 1,
      groups: [group({ n: 5, net_n: 2, fee_n: 2 })],
    })!;
    expect(calibrationNextTile(thin, plan, { planned_profit: 180_000 })).toBeNull();
    const fees = calibrationNormalize(L, {
      v: 1,
      groups: [group({ n: 5, net_n: 2, fee_n: 3 })],
    })!;
    expect(calibrationNextTile(fees, plan, { planned_profit: 180_000 }).basis).toBe(
      "gross_ratio_minus_fees",
    );
  });

  it("Given a ratio above 500 %, Then the tile gives no value (as the cards)", () => {
    const huge = calibrationNormalize(L, {
      v: 1,
      groups: [group({ gross_ratio: 666, net_ratio: 650 })],
    })!;
    expect(calibrationNextTile(huge, plan, { planned_profit: 180_000 })).toBeNull();
  });
});

describe("Feature: the three values of a route card (calibrationCompare)", () => {
  const LF = { ...L, fmtAuec };
  const leg = (over: Record<string, unknown> = {}) => ({
    commodity: "Laranite",
    from: "Port Tressler",
    to: "Area18 TDD",
    buy_price: 189,
    sell_price: 457,
    profit_per_scu: 268,
    scu: 696,
    ...over,
  });
  const option = (legs: unknown[], over: Record<string, unknown> = {}) => ({
    legs,
    profit_per_trip: 214_368,
    profit_per_hour: 279_610,
    cycle_minutes: 46,
    ...over,
  });
  const calibOf = (...g: Record<string, unknown>[]) =>
    calibrationNormalize(L, { v: 1, groups: g.map((x) => group(x)) })!;
  const cmp = (c: unknown, o: unknown) => calibrationCompare(LF, c, o);

  it("Given four runs, Then the estimate, the measured mean and the ratio are side by side, in the ratio of the tile", () => {
    const m = cmp(calibOf({}), option([leg()], { profit_per_trip: 186_528 }));
    expect(m.mode).toBe("ratio");
    expect(NBSP_FREE(m.estValue)).toBe("≈ +186 528");
    expect(NBSP_FREE(m.estSub)).toBe("≈ +279 610 aUEC par heure");
    expect(m.measLabel).toBe("Mesuré · 4 trajets");
    expect(NBSP_FREE(m.measValue)).toBe("≈ +94 411");
    expect(NBSP_FREE(m.measSub)).toBe(
      "de cette marchandise · résultat net · prévu alors ≈ +123 901 aUEC",
    );
    expect(NBSP_FREE(m.ratioValue)).toBe("76 %");
    expect(m.fill).toBe(38);
    // the mean over the mean is the ratio (here 94 411 / 123 901 = 0.762)
    expect(NET_AVG / NET_PLANNED).toBeCloseTo(NET, 3);
    // the very figure of the tile "Si tu refais ce trajet", for the same plan
    const tile = calibrationNextTile(
      calibOf({}),
      { commodity: "Laranite", scu: 696, sell_unit_price: 457 },
      { planned_profit: 186_528 },
    );
    const trip = NBSP_FREE(fmtAuec(tile.auec, true));
    const hour = NBSP_FREE(fmtAuec(Math.round((tile.auec / 46) * 60), true));
    expect(NBSP_FREE(m.apply)).toBe(
      `Si tu refais ce trajet ≈ ${trip} aUEC (prévu ≈ +186 528 × 76 %), soit ≈ ${hour} aUEC par heure.`,
    );
    expect(m.tag).toBe(tile.tag);
  });

  it("Given fewer than three runs, Then only their number comes back: no ratio, no applied figure, no tag, no bar", () => {
    for (const n of [2]) {
      const m = cmp(calibOf({ n, net_n: n }), option([leg()]));
      expect(m.mode).toBe("count");
      expect(m.measValue).toBe(`${n} trajets`);
      expect(m.measSub).toContain("pas assez pour un ratio (3 trajets minimum)");
      expect(m).toMatchObject({
        ratioValue: "",
        apply: "",
        tag: "",
        hint: "",
        caution: "",
        fill: -1,
      });
      const { reading: _reading, ...visible } = m; // the fold names the 50 % and 200 % ceiling, nothing else
      void _reading;
      expect(JSON.stringify(visible)).not.toMatch(/%|Si tu refais/);
      // the planner's estimate is still given
      expect(NBSP_FREE(m.estValue)).toBe("≈ +214 368");
    }
  });

  it("Given three runs but a net on two only, Then the gross ratio less the usual fees is used and the net is not", () => {
    const m = cmp(
      calibOf({ n: 3, net_n: 2, fee_n: 3, gross_ratio: 0.9, fee_rate: 0.05 }),
      option([leg({ commodity: "Laranite", sell_price: 1599, profit_per_scu: 119, scu: 500 })]),
    );
    expect(m.mode).toBe("ratio");
    expect(m.measLabel).toBe("Mesuré · 3 trajets");
    expect(m.measSub).toContain("marge brute, avant frais");
    expect(m.ratioSub).toContain("sur la marge brute");
    expect(NBSP_FREE(m.apply)).toContain("≈ +13 575 aUEC");
    // 59 500 x 90 % less 5 % of (1599 x 500): the sentence writes the real decomposition, with the fees taken off
    expect(NBSP_FREE(m.apply)).toContain(
      "(prévu ≈ +59 500 × 90 %, moins les frais habituels ≈ 39 975 aUEC, à 5 % du chiffre d’affaires prévu)",
    );
    expect(NBSP_FREE(m.apply)).not.toContain("déjà déduits");
    expect(m.tag).toBe("estimé · 3 trajets · confiance faible");
  });

  it("Given fewer than three runs with fees known, Then no net is worked out: the gross ratio is shown and nothing is applied", () => {
    const m = cmp(calibOf({ n: 5, net_n: 2, fee_n: 2 }), option([leg()]));
    expect(m.mode).toBe("ratio");
    expect(NBSP_FREE(m.ratioValue)).toBe("74 %");
    expect(m.measLabel).toBe("Mesuré · 5 trajets");
    expect(m.apply).toBe(
      "Pas assez de trajets avec frais connus pour chiffrer le net (3 minimum) : aucun chiffre appliqué.",
    );
    expect(NBSP_FREE(m.apply)).not.toMatch(/\+\d/);
  });

  it("Given a card of two legs, Then the ratio is applied to the first leg alone and never to the round-trip total or the hour", () => {
    const m = cmp(calibOf({}), option([leg(), leg({ commodity: "Medical Supplies", scu: 120 })]));
    const apply = NBSP_FREE(m.apply);
    expect(apply).toBe(
      "Si tu refais le 1er tronçon (Laranite) ≈ +142 134 aUEC (prévu ≈ +186 528 × 76 %). Pas de chiffre pour l’aller-retour entier.",
    );
    expect(m.estUnit).toBe("aUEC pour les 2 tronçons");
    expect(JSON.stringify(m)).not.toMatch(figure(Math.round(214_368 * NET)));
    expect(apply).not.toContain("par heure");
    expect(m.reading).toContain("pas un chiffre pour l’aller-retour");
  });

  it("Given a one-leg card with no known duration, Then the trip is applied and no hourly figure is made up", () => {
    const m = cmp(
      calibOf({}),
      option([leg()], { profit_per_hour: null, cycle_minutes: null, profit_per_trip: 186_528 }),
    );
    expect(NBSP_FREE(m.apply)).toBe(
      "Si tu refais ce trajet ≈ +142 134 aUEC (prévu ≈ +186 528 × 76 %).",
    );
    expect(m.estSub).toBe("durée inconnue : pas de gain par heure");
  });

  it("Given a leg that loses money, a huge ratio or a missing mean, Then nothing is applied and nothing is made up", () => {
    const loss = cmp(calibOf({}), option([leg({ profit_per_scu: -5 })]));
    expect(loss.apply).toBe("");
    // no net is worked out for a leg with no profit: the gross ratio is what is left to show
    expect(NBSP_FREE(loss.ratioValue)).toBe("74 %");
    const huge = cmp(calibOf({ gross_ratio: 666, net_ratio: 650 }), option([leg()]));
    expect(huge.ratioValue).toBe("écart très élevé");
    expect(huge.fill).toBe(-1);
    expect(huge.apply).toBe("");
    // a server that sends no mean: the number of runs only, the ratio stays
    const old = cmp(calibOf({ net_avg_auec: null, net_planned_avg_auec: null }), option([leg()]));
    expect(old.measValue).toBe("4 trajets");
    expect(old.measSub).not.toContain("prévu alors");
    expect(NBSP_FREE(old.ratioValue)).toBe("76 %");
  });

  it("Given the gross-less-fees basis, Then the sentence writes the real decomposition (planned 100 000, 90 %, fees 5 % of 500 000 = 65 000, not 'prévu × 90 %')", () => {
    const m = cmp(
      calibOf({ n: 5, net_n: 0, net_ratio: null, gross_ratio: 0.9, fee_rate: 0.05, fee_n: 5 }),
      option([leg({ profit_per_scu: 100, scu: 1000, sell_price: 500 })], { cycle_minutes: null }),
    );
    expect(NBSP_FREE(m.apply)).toBe(
      "Si tu refais ce trajet ≈ +65 000 aUEC (prévu ≈ +100 000 × 90 %, moins les frais habituels ≈ 25 000 aUEC, à 5 % du chiffre d’affaires prévu).",
    );
    // the net basis has no fees to take off and says nothing of them
    const net = cmp(calibOf({}), option([leg()]));
    expect(NBSP_FREE(net.apply)).not.toContain("frais habituels");
  });

  it("Given eight runs, a net on two and fees on three, Then the measured cell counts the eight runs the gross mean is over, and the tag the three behind the fees", () => {
    const m = cmp(calibOf({ n: 8, net_n: 2, fee_n: 3, confidence: "medium" }), option([leg()]));
    expect(m.measLabel).toBe("Mesuré · 8 trajets");
    expect(m.measSub).toContain("marge brute, avant frais");
    expect(NBSP_FREE(m.measValue)).toBe("≈ +91 337");
    expect(m.tag).toBe("estimé · 3 trajets · confiance faible");
    // on the net basis the cell counts the net's runs
    const net = cmp(calibOf({ n: 8, net_n: 5, fee_n: 3 }), option([leg()]));
    expect(net.measLabel).toBe("Mesuré · 5 trajets");
    expect(NBSP_FREE(net.measValue)).toBe("≈ +94 411");
  });

  it("Given a ratio that is not above zero or is above 500 %, Then it reads 'écart très élevé', with no bar and no applied value; the minus sign is U+2212", () => {
    const minus = String.fromCharCode(0x2212);
    const nbsp = String.fromCharCode(0xa0);
    for (const bad of [0, -0.3, 5.01, 6]) expect(calibrationHuge(bad)).toBe(true);
    for (const ok of [0.01, 0.5, 1, 5]) expect(calibrationHuge(ok)).toBe(false);
    expect(calibrationPct(-0.2)).toBe(minus + "20" + nbsp + "%");
    expect(calibrationPct(0.74)).toBe("74" + nbsp + "%");
    for (const ratio of [-0.4, 0, 6]) {
      const m = cmp(calibOf({ gross_ratio: ratio, net_ratio: ratio }), option([leg()]));
      expect(m.ratioValue).toBe("écart très élevé");
      expect(m.fill).toBe(-1);
      expect(m.apply).not.toMatch(/\+\d/);
      // the tile and the tools do not lean on it either
      expect(
        calibrationExpected(
          calibOf({ gross_ratio: ratio, net_ratio: ratio }).groups[0],
          100_000,
          300_000,
        ),
      ).toBeNull();
    }
    // a range that dips below zero is written with the one minus sign, never a hyphen
    const wild = cmp(
      calibOf({ high_variance: true, gross_min: -0.2, gross_max: 1.1, confidence: "low" }),
      option([leg()]),
    );
    expect(wild.caution).toContain(minus + "20" + nbsp + "%");
    expect(wild.caution).not.toMatch(/-\d/);
  });

  it("Given a card of two legs, Then the measured cell and the ratio say '1er tronçon' beside the total they sit next to; a one-leg card does not", () => {
    const two = cmp(calibOf({}), option([leg(), leg({ commodity: "Medical Supplies", scu: 120 })]));
    expect(two.measSub.startsWith("1er tronçon (Laranite) · de cette marchandise")).toBe(true);
    expect(two.ratioSub.startsWith("1er tronçon (Laranite) · sur le net")).toBe(true);
    expect(two.estUnit).toBe("aUEC pour les 2 tronçons");
    const count = cmp(calibOf({ n: 2 }), option([leg(), leg()]));
    expect(count.measSub.startsWith("1er tronçon (Laranite) · ")).toBe(true);
    const one = cmp(calibOf({}), option([leg()]));
    expect(JSON.stringify([one.measSub, one.ratioSub, one.apply])).not.toContain("tronçon");
  });

  it("Given nothing can be applied, Then the sentence gives the one reason that is true", () => {
    // too few runs with fees (and a net on fewer than three)
    const few = cmp(calibOf({ n: 5, net_n: 2, fee_n: 2 }), option([leg()]));
    expect(few.apply).toBe(
      "Pas assez de trajets avec frais connus pour chiffrer le net (3 minimum) : aucun chiffre appliqué.",
    );
    // a net so far from the plan that it is not used, and fees on too few runs to replace it
    const hugeNet = cmp(calibOf({ n: 5, net_n: 3, net_ratio: 6, fee_n: 2 }), option([leg()]));
    expect(hugeNet.apply).toBe(
      "Le net de tes trajets s’écarte trop du prévu (écart très élevé) : aucun chiffre appliqué.",
    );
    // fees known on enough runs but no planned turnover to take them from
    const noTurnover = cmp(
      calibOf({ n: 5, net_n: 0, net_ratio: null, fee_n: 3 }),
      option([leg({ sell_price: 0 })]),
    );
    expect(noTurnover.apply).toBe(
      "Chiffre d’affaires prévu inconnu : les frais habituels ne peuvent pas être déduits, aucun chiffre appliqué.",
    );
    for (const m of [few, hugeNet, noTurnover]) expect(m.apply).not.toMatch(/\+\d/);
  });

  it("Given no group for the goods of the first leg, or no calibration, or no leg, Then nothing", () => {
    expect(cmp(calibOf({}), option([leg({ commodity: "Agricium" })]))).toBeNull();
    expect(cmp(calibOf({}), option([leg({ commodity: "Lara" })]))).toBeNull();
    expect(cmp(null, option([leg()]))).toBeNull();
    expect(cmp(calibOf({}), option([]))).toBeNull();
    expect(cmp(calibOf({}), null)).toBeNull();
  });

  it("Given any group, Then the fold always says the ratio is censored, and the price link when the goods are unverified", () => {
    const plain = cmp(calibOf({}), option([leg()]));
    expect(plain.reading).toContain(
      "rattaché à son plan par la ressemblance des prix ne l’est que si sa marge unitaire est entre la moitié et le double de celle du plan",
    );
    expect(plain.reading).toContain("(un lien par le nom n’a pas cette borne)");
    expect(plain.reading).not.toContain("par construction");
    expect(plain.reading).not.toContain("lien par prix");
    const unverified = cmp(
      calibOf({ goods_unverified: true, confidence_capped: true }),
      option([leg()]),
    );
    expect(unverified.reading).toContain("lien par prix");
    expect(unverified.reading).toContain("Confiance plafonnée à « moyenne »");
    expect(unverified.measSub).toContain("similaires (marchandise non vérifiée)");
    expect(unverified.hint).toContain("plafonnée");
  });

  it("Given a hostile section, Then the means are whole, finite and bounded, and never invented", () => {
    const n = calibrationNormalize(L, {
      v: 1,
      groups: [
        {
          ...group(),
          gross_avg_auec: 9e99,
          gross_planned_avg_auec: "12",
          net_avg_auec: -9e99,
          net_planned_avg_auec: 1234.56,
        },
        { ...group(), gross_avg_auec: undefined, net_avg_auec: null },
      ],
    })!;
    expect(n.groups[0]).toMatchObject({
      gross_avg_auec: 1e12,
      gross_planned_avg_auec: null,
      net_avg_auec: -1e12,
      net_planned_avg_auec: 1235,
    });
    expect(n.groups[1]).toMatchObject({ gross_avg_auec: null, net_avg_auec: null });
  });
});

describe("Feature: the section is in the ledger only for a caller allowed the balance", () => {
  const input = (includeBalance: boolean, calibration?: CalibrationSection) => ({
    base: EMPTY_LEDGER,
    history: [],
    includeBalance,
    nowMs: SESSION_NOW,
    ...(calibration ? { calibration } : {}),
  });

  it("Given the balance is asked, Then the section is carried; given it is not, Then it is not, whatever the caller passed", () => {
    expect(buildLedgerPayload(input(true, SECTION)).calibration).toEqual(SECTION);
    const plain = buildLedgerPayload(input(false, SECTION));
    expect(plain).not.toHaveProperty("calibration");
    expect(JSON.stringify(plain)).not.toMatch(WIRE);
    // the answer built without the balance is the same whatever the calibration holds (so is its hash)
    const other = { ...SECTION, groups: [group({ gross_ratio: 0.511 })] as never };
    expect(JSON.stringify(buildLedgerPayload(input(false, other)))).toBe(JSON.stringify(plain));
    expect(JSON.stringify(buildLedgerPayload(input(false)))).toBe(JSON.stringify(plain));
  });

  it("Given a section with no group, Then the key is left out", () => {
    expect(buildLedgerPayload(input(true, { ...SECTION, groups: [] }))).not.toHaveProperty(
      "calibration",
    );
  });

  it("Given a payload over its budget, Then the calibration is the first thing cut", () => {
    const payload = buildLedgerPayload(input(true, SECTION));
    const cut = boundLedger(payload, 200);
    expect(cut).not.toHaveProperty("calibration");
    expect(cut.truncated).toContain("calibration dropped");
  });

  it("Given a section from real sessions, Then it is small enough for the ledger's budget", () => {
    const trips = Array.from({ length: 30 }, (_, i) => ({
      key: `00000000000000${i.toString(16).padStart(2, "0")}`,
      kind: "trade" as const,
      source: "trade_journal" as const,
      started_at: new Date(SESSION_NOW - (i + 1) * 3_600_000 - 600_000).toISOString(),
      ended_at: new Date(SESSION_NOW - (i + 1) * 3_600_000).toISOString(),
      label: null,
      commodity: `Goods ${i % 14}`,
      buy_terminal: null,
      sell_terminal: null,
      scu: 100,
      cost_auec: 1,
      revenue_auec: 80_001,
      fees_auec: 100,
      gross_margin_auec: 80_000,
      net_auec: 79_900,
      net_kind: "balance_delta" as const,
      planned_profit_auec: 100_000,
      planned_scu: 100,
      plan_buy_terminal: `Terminal ${i % 14} with a long name of sixty characters or so ....`,
      plan_sell_terminal: `Destination ${i % 14} with a long name of sixty characters ....`,
      plan_link: "prices" as const,
      unexplained_auec: null,
      net_doubtful: null,
      fees_method: "mesure" as const,
    }));
    const poll = calibrationForPoll(
      buildCalibration(
        [
          session(1, {
            trips: [
              ...trips,
              ...trips.map((t) => ({
                ...t,
                key: `${t.key.slice(0, 14)}ff`,
                started_at: new Date(Date.parse(t.started_at) - 1000).toISOString(),
                ended_at: new Date(Date.parse(t.ended_at) - 1000).toISOString(),
              })),
            ],
          }),
        ],
        { nowMs: SESSION_NOW },
      ),
    );
    expect(poll.groups.length).toBeGreaterThan(0);
    expect(JSON.stringify(poll).length).toBeLessThan(8000);
  });

  it("Given the Views' channel, Then the sender's strip and the receiver's clean both remove the section", () => {
    const rich: any = { ...buildLedgerPayload(input(true, SECTION)) };
    expect(JSON.stringify(rich)).toMatch(WIRE);
    expect(JSON.stringify(ledgerStripBalance(rich))).not.toMatch(WIRE);
    expect(JSON.stringify(ledgerChannelClean(rich))).not.toMatch(WIRE);
    // a hostile sender that puts it under another name still gets nothing through the field-by-field rebuild
    const sneaky = ledgerChannelClean({ ...rich, calibrations: SECTION, trade: undefined });
    expect(JSON.stringify(sneaky)).not.toMatch(WIRE);
  });
});

describe("Feature: the poll carries the section only to a View that asked for the balance", () => {
  const stub = () =>
    ({
      enabled: true,
      status: vi.fn(async () => ({ state: "live", cause: "x", frames_received: 1 })),
      snapshot: vi.fn(async () => null),
      events: vi.fn(async () => ({ events: [], last_seq: 0 })),
      resetUecDelta: vi.fn(async () => undefined),
      balanceHistory: vi.fn(async () => []),
      stop: vi.fn(async () => undefined),
    }) as unknown as Telemetry;

  const rig = (section: CalibrationSection = SECTION) => {
    const calibrationSection = vi.fn(async () => section);
    const sessions = {
      enabled: true,
      bar: async () => ({
        v: 1,
        status: "ok",
        notice: null,
        gap_hours: 3,
        current: null,
        stale: false,
      }),
      calibrationSection,
    } as unknown as SessionManager;
    const service = new DashboardService(
      stub(),
      () => SESSION_NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    );
    return { service, calibrationSection };
  };

  it("Given the balance is not asked, Then the section is not even computed and nothing of it is in the answer", async () => {
    const { service, calibrationSection } = rig();
    const poll = await service.poll({ includeBalance: false });
    expect(calibrationSection).not.toHaveBeenCalled();
    expect(JSON.stringify(poll)).not.toMatch(WIRE);
  });

  it("Given the balance is asked, Then the section is in the ledger, and the two hashes differ while the plain answer never changes", async () => {
    const { service } = rig();
    const rich = await service.poll({ includeBalance: true });
    expect((rich.ledger as any).calibration.groups).toHaveLength(3);
    const plain = await service.poll({ includeBalance: false });
    // the same service with another calibration: the plain answer and its hash are unchanged
    const { service: other } = rig({
      ...SECTION,
      groups: [group({ gross_ratio: 0.511 })] as never,
    });
    const plain2 = await other.poll({ includeBalance: false });
    expect(plain2.hash!.ledger).toBe(plain.hash!.ledger);
    expect(rich.hash!.ledger).not.toBe(plain.hash!.ledger);
    // a View that holds the hash of the rich answer but did not ask for the balance gets the plain one again
    const tailored = await service.poll({
      includeBalance: false,
      have: { ledger: rich.hash!.ledger },
    });
    expect(JSON.stringify(tailored)).not.toMatch(WIRE);
  });

  it("Given the calibration fails, Then the poll still answers without it", async () => {
    const calibrationSection = vi.fn(async () => {
      throw new Error("boom");
    });
    const service = new DashboardService(
      stub(),
      () => SESSION_NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        bar: async () => undefined,
        calibrationSection,
      } as unknown as SessionManager,
    );
    const poll = await service.poll({ includeBalance: true });
    expect(JSON.stringify(poll)).not.toMatch(WIRE);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The assembled page
// ---------------------------------------------------------------------------------------------------------------

const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  scu: 696,
  expected_profit_auec: 180_000,
  buy_unit_price: 189,
  sell_unit_price: 457,
};

async function page(
  opts: {
    always?: boolean;
    plan?: boolean;
    section?: CalibrationSection;
    suggest?: (args: any) => unknown | Promise<unknown>;
  } = {},
) {
  const scenario = new Scenario();
  scenario.specs = specsSamples(scenario.now).ready;
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) => {
    const base = tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    // `always`: a hostile or buggy server that sends the section even to a View that did not ask for the balance
    return include || opts.always
      ? ({ ...base, calibration: opts.section ?? SECTION } as any)
      : base;
  };
  const w = await startPage({ scenario, ...(opts.suggest ? { suggest: opts.suggest } : {}) });
  if (opts.plan) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
    });
  }
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(215 * SECOND);
  return w;
}
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));
const shown = (w: PageWorld, label: string): FakeNode[] =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent === label && isShown(n));

/** The shown cards of the action bar (results, chains and "Et ensuite ?"). */
const cardsOf = (w: PageWorld): FakeNode[] =>
  findAll(w.root, (n) => n.tag === "article" && n.className === "ta-card" && isShown(n));
/** The card whose route is exactly this text (its first leg, so the goods, is told apart from its neighbours). */
const cardOf = (w: PageWorld, route: string): string => {
  const card = cardsOf(w).find((c) => findAll(c, (n) => n.tag === "h4")[0]?.textContent === route);
  if (!card) throw new Error(`no card for ${route}`);
  return NBSP_FREE(visibleText(card));
};
/** Every word a node holds, hidden nodes and attributes and style variables included (the page keeps nothing it hid). */
const everything = (w: PageWorld): string => {
  const parts: string[] = [];
  const visit = (n: FakeNode) => {
    for (const [k, v] of Object.entries(n.attrs)) parts.push(`${k}=${v}`);
    for (const [k, v] of Object.entries(n.style.props)) parts.push(`${k}:${v}`);
    for (const c of n.children) visit(c);
  };
  visit(w.root);
  return NBSP_FREE(w.root.textContent) + "\n" + NBSP_FREE(parts.join("\n"));
};

/**
 * An amount as the page writes it (thousands separated by a space, a no-break space or nothing), as a whole figure: not a part
 * of a longer number, not a decimal fraction (a clock in milliseconds has already fooled this kind of scan twice).
 */
const amount = (n: number): RegExp =>
  new RegExp(`(?<![0-9.])${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\\D?")}(?![0-9])`);
const FIGURES = [
  ...MEANS,
  131_377, // Agricium measured net mean
  135_731, // Agricium measured gross mean
  148_623, // Agricium planned net mean
  148_667, // Agricium planned gross mean
  142_134, // Laranite applied to the first leg
  134_368, // Agricium applied to the trip
  212_160, // Agricium applied to the hour
  13_575, // Quartz applied to the trip
  15_663, // Quartz applied to the hour
];
/** Everything in a dump of the page that is the player's own runs: the words, the amounts, the ratios, the raw wire. */
function leaks(all: string): string[] {
  const found: string[] = [];
  const words =
    /Mesuré · \d|Si tu refais le 1er|Si tu refais ce trajet ≈|trajets minimum|tu réalises|D’après tes|confiance (faible|moyenne|élevée)|estimé · \d|prévu alors|par trajet, en moyenne/;
  // each hit comes with the words around it, to tell a leak from a coincidence
  const around = (m: RegExpExecArray) =>
    all.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
  const w = words.exec(all);
  if (w) found.push(around(w));
  for (const n of FIGURES) {
    const m = amount(n).exec(all);
    if (m) found.push(around(m));
  }
  const wire = WIRE.exec(all);
  if (wire) found.push(around(wire));
  return found;
}

/** The words of every block, hidden ones included: once emptied they hold no digit at all (the fixed labels have none). */
const blockWords = (w: PageWorld): string =>
  findAll(w.root, (n) => n.className === "ta-calib")
    .map((n) => n.textContent)
    .join("\n");

// Made-up groups for the cards of the made-up planner (suggestFixtures.ts): one per case worth a sentence.
const CARD_SECTION: CalibrationSection = {
  v: 1,
  patch_line: "4.10",
  groups: [
    // Laranite on the route of the 2-leg card: four runs, net basis
    group({ kind: "route", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD" }),
    // Agricium (a one-leg card): eight runs, a net ratio of 0.884
    group({
      commodity: "Agricium",
      n: 8,
      net_n: 8,
      gross_ratio: 0.913,
      net_ratio: 0.884,
      gross_avg_auec: 135_731,
      gross_planned_avg_auec: 148_667,
      net_avg_auec: 131_377,
      net_planned_avg_auec: 148_623,
    }),
    // Gold: two runs, unverified goods: the number of runs and nothing else
    group({
      commodity: "Gold",
      n: 2,
      confidence: "low",
      goods_unverified: true,
      net_n: 0,
      net_ratio: null,
      net_avg_auec: null,
      net_planned_avg_auec: null,
    }),
    // Quartz: three runs, a net on two only: the gross ratio less the usual fees (5 %), applied to the first leg
    group({
      commodity: "Quartz",
      n: 3,
      confidence: "low",
      gross_ratio: 0.9,
      net_n: 2,
      net_ratio: 0.88,
      fee_rate: 0.05,
      fee_n: 3,
    }),
    // Scrap: a ratio so far from 1 that it is worded, not printed
    group({
      commodity: "Scrap",
      n: 3,
      confidence: "low",
      gross_ratio: 666,
      net_ratio: 650,
      net_n: 3,
    }),
  ] as never,
};

describe("Feature: estimated, measured and ratio side by side on a route card, in the assembled page", () => {
  it("Given the balance is shown, When routes are searched, Then a card of a known route shows the estimate, the measured mean and the ratio with what it gives", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const card = cardOf(w, "Port Tressler → Area18 TDD → Port Tressler");
    // (a) the planner's figure, labelled as an estimate, per trip (both legs) and per hour
    expect(card).toContain("ESTIMATION");
    expect(card).toContain("≈ +214 368");
    expect(card).toContain("aUEC pour les 2 tronçons");
    expect(card).toContain("≈ +279 610 aUEC par heure");
    // (b) what the player's own runs averaged, with how many and what they were planned at
    expect(card).toContain("Mesuré · 4 trajets");
    expect(card).toContain("≈ +94 411");
    expect(card).toContain("aUEC par trajet, en moyenne");
    expect(card).toContain("sur cette route · résultat net · prévu alors ≈ +123 901 aUEC");
    // (c) the ratio of the tile, what it gives on the FIRST leg only, and its confidence
    expect(card).toContain("76 %");
    expect(card).toContain("sur le net · réalisé ÷ prévu");
    expect(card).toContain(
      "Si tu refais le 1er tronçon (Laranite) ≈ +142 134 aUEC (prévu ≈ +186 528 × 76 %). Pas de chiffre pour l’aller-retour entier.",
    );
    expect(card).toContain("estimé · 4 trajets · confiance moyenne");
    // the round-trip total is never multiplied by a ratio measured on one leg, and no hourly figure is applied to it
    expect(card).not.toMatch(figure(Math.round(214_368 * NET)));
    expect(card).not.toContain("soit");
    // the old sentence is merged into the block, not repeated
    expect(card).not.toContain("tu réalises");
    expect(card).not.toContain("D’après tes");
    // the fold is there and says what the ceiling is
    expect(card).toContain("Comment lire ça");
    expect(card).toContain("le ratio de ces trajets reste entre ≈ 50 % et ≈ 200 %");
    expect(card).toContain("(un lien par le nom n’a pas cette borne)");
    expect(card).toContain("ce n’est pas le mesuré divisé par l’estimation d’aujourd’hui");
    expect(card).toContain("pas un chiffre pour l’aller-retour");
  });

  it("Given a card of one leg, Then the ratio is applied to the trip and to the hour (the applied trip over the estimated cycle)", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const card = cardOf(w, "Lorville CBD → Area18 TDD → Lorville CBD");
    expect(card).toContain("Mesuré · 8 trajets");
    expect(card).toContain("≈ +131 377");
    expect(card).toContain("de cette marchandise · résultat net · prévu alors ≈ +148 623 aUEC");
    expect(card).toContain("88 %");
    // 152 000 x 0.884 = 134 368; over 38 minutes, 212 160 an hour
    expect(card).toContain(
      "Si tu refais ce trajet ≈ +134 368 aUEC (prévu ≈ +152 000 × 88 %), soit ≈ +212 160 aUEC par heure.",
    );
    expect(card).toContain("estimé · 8 trajets · confiance moyenne");
  });

  it("Given two runs only, Then the card gives their number and no ratio, no applied figure, no confidence tag", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const card = cardOf(w, "Everus Harbor → Seraphim Station → Everus Harbor");
    expect(card).toContain("ESTIMATION");
    expect(card).toContain("Mesuré");
    expect(card).toContain("2 trajets");
    expect(card).toContain(
      "1er tronçon (Gold) · similaires (marchandise non vérifiée) · pas assez pour un ratio (3 trajets minimum)",
    );
    expect(card).not.toContain("Réalisé ÷ prévu");
    // no ratio of any kind (the fold only names the 50 %, 200 % and 500 % bounds)
    expect(card.replace(/≈ 50 % et ≈ 200 %|500 %/g, "")).not.toMatch(/\d\s?%/);
    expect(card).not.toContain("Si tu refais");
    expect(card).not.toContain("estimé ·");
    expect(card).not.toContain(" aUEC par trajet, en moyenne");
  });

  it("Given three runs with a net on two only, Then the gross ratio less the usual fees is used, and said", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const card = cardOf(w, "Magnus Gateway → Area18 TDD → Magnus Gateway");
    expect(card).toContain("Mesuré · 3 trajets");
    expect(card).toContain("marge brute, avant frais");
    expect(card).toContain("90 %");
    // 59 500 x 0.9 less 5 % of 1599 x 500 = 13 575; over 52 minutes, 15 663 an hour
    expect(card).toContain(
      "Si tu refais ce trajet ≈ +13 575 aUEC (prévu ≈ +59 500 × 90 %, moins les frais habituels ≈ 39 975 aUEC, à 5 % du chiffre d’affaires prévu), soit ≈ +15 663 aUEC par heure.",
    );
    // the decomposition is true: 59 500 x 90 % - 39 975 = 13 575 (it is not "prévu × 90 %" alone)
    expect(Math.round(59_500 * 0.9) - 39_975).toBe(13_575);
    expect(card).toContain("estimé · 3 trajets · confiance faible");
    expect(card).toContain("Peu de trajets : indicatif seulement.");
  });

  it("Given a ratio so far from 1 that it rests on a tiny plan, Then the card says so and applies nothing", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const card = cardOf(w, "Everus Harbor → Port Tressler → Everus Harbor");
    expect(card).toContain("écart très élevé");
    expect(card).not.toMatch(/666|65\s?000/);
    expect(card).not.toContain("Si tu refais");
  });

  it("Given a card, Then the bar is decoration, the tips are reachable by keyboard and nothing in the block is a live region", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const blocks = findAll(w.root, (n) => n.className === "ta-calib" && isShown(n));
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) {
      expect(findAll(b, (n) => "aria-live" in n.attrs || n.attrs["role"] === "status")).toEqual([]);
      for (const bar of findAll(b, (n) => n.className === "ta-cmp-bar"))
        expect(bar.attrs["aria-hidden"]).toBe("true");
      // the fold is a native details/summary (keyboard: Enter or Space)
      expect(
        findAll(b, (n) => n.tag === "details" && n.className === "ta-calib-more"),
      ).toHaveLength(1);
      expect(findAll(b, (n) => n.tag === "summary").map((n) => n.textContent)).toEqual([
        "Comment lire ça",
      ]);
      // the estimate tag explains itself through the one tip mechanism and is in the tab order
      const est = findAll(b, (n) => n.className === "tr-tag" && n.textContent === "ESTIMATION")[0]!;
      expect(est.attrs["tabindex"]).toBe("0");
      expect(est.attrs["data-tip"]).toContain("prix UEX");
    }
  });

  it("Given the balance is hidden, Then there is no block, even when the server sent the section anyway", async () => {
    const w = await page({ always: true, section: CARD_SECTION });
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const t = text(w);
    expect(t).toContain("Port Tressler");
    // the block is hidden and EMPTY: nothing the balance made is in the page, hidden nodes and attributes included
    expect(findAll(w.root, (n) => n.className === "ta-calib" && isShown(n))).toEqual([]);
    expect(leaks(everything(w))).toEqual([]);
    expect(blockWords(w)).not.toMatch(/\d/);
    // and no node shows a bar
    for (const f of findAll(w.root, (n) => n.className === "ta-cmp-fill"))
      expect(f.style.props["--fill"] ?? "0%").toBe("0%");
  });

  it("Given the block was shown and the balance is hidden again, Then every figure of it leaves the page, hidden nodes and attributes included", async () => {
    const w = await page({ section: CARD_SECTION });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const shownNow = everything(w);
    // the check can see them while they are there
    expect(leaks(shownNow).length).toBeGreaterThan(8);
    expect(shownNow).toMatch(amount(NET_AVG));
    expect(shownNow).toContain("Mesuré · 4 trajets");
    expect(shownNow).toMatch(/--fill:38%/);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(findAll(w.root, (n) => n.className === "ta-calib" && isShown(n))).toEqual([]);
    expect(leaks(everything(w))).toEqual([]);
    expect(blockWords(w)).not.toMatch(/\d/);
    for (const f of findAll(w.root, (n) => n.className === "ta-cmp-fill"))
      expect(f.style.props["--fill"] ?? "0%").toBe("0%");
    // the tags of the emptied block have no tip and are out of the tab order
    for (const b of findAll(w.root, (n) => n.className === "ta-calib"))
      for (const t of findAll(b, (n) => n.className === "tr-tag")) {
        expect(t.attrs["data-tip"] ?? "").toBe("");
        expect(t.attrs["tabindex"] ?? "-1").toBe("-1");
      }
  });

  it("Given cards filled and then no longer used (results hidden while a search runs, then fewer cards), Then the block of every one is emptied, hidden nodes included, before the balance is even hidden", async () => {
    let mode: "ok" | "hold" = "ok";
    let release: () => void = () => {};
    const w = await page({
      section: CARD_SECTION,
      suggest: (args: any) => {
        if (args.action !== "search" || mode === "ok") return suggestAnswer(args);
        return new Promise((resolve) => {
          release = () => resolve(suggestAnswer(args, { variant: "empty" }));
        });
      },
    });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    expect(leaks(everything(w)).length).toBeGreaterThan(8);
    // a new search is running: the results are not shown, and nothing of the runs stays in them
    mode = "hold";
    findButton(w.root, "Plus rapide").click();
    await w.advance(300);
    expect(findAll(w.root, (n) => n.className === "ta-calib" && isShown(n))).toEqual([]);
    expect(leaks(everything(w))).toEqual([]);
    expect(blockWords(w)).not.toMatch(/\d/);
    // the answer has no route: every card is unused
    release();
    await w.advance(300);
    expect(cardsOf(w)).toEqual([]);
    expect(leaks(everything(w))).toEqual([]);
    expect(blockWords(w)).not.toMatch(/\d/);
    // and hiding the balance afterwards leaves nothing either
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(leaks(everything(w))).toEqual([]);
    expect(blockWords(w)).not.toMatch(/\d/);
  });

  it("Given a bubble open on a confidence tag, When the balance is hidden again, Then the tag loses its tip and the bubble closes", async () => {
    const w = await page();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const tags = findAll(w.root, (n) => n.className === "tr-tag" && !!n.attrs["data-tip"]);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0]!.attrs["tabindex"]).toBe("0");
    for (const fn of w.doc.body.listeners["focusin"] ?? []) fn({ target: tags[0] });
    const bubble = findAll(w.root, (n) => n.className === "tip")[0]!;
    expect(isShown(bubble)).toBe(true);
    expect(bubble.textContent).toBe(tags[0]!.attrs["data-tip"]);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    // the hidden tags are not in the tab order and say nothing
    for (const t of tags) {
      expect(t.attrs["data-tip"] ?? "").toBe("");
      expect(t.attrs["tabindex"] ?? "-1").toBe("-1");
    }
    expect(isShown(bubble)).toBe(false);
  });

  it("Given the line is shown, Then it is in no message to the agent, no context update and no message on the channel", async () => {
    const w = await page();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    expect(text(w)).toContain("Mesuré · 4 trajets");
    shown(w, "Demander à l’agent")[0]!.click();
    await w.advance(2 * SECOND);
    expect(w.host.log.messages.length).toBeGreaterThan(0);
    const unwanted =
      /Mesuré|Si tu refais|d’après tes \d+ trajets|tu réalises|marge brute|74 %|76 %|14 %|0\.737/i;
    for (const m of w.host.log.messages) {
      const clean = NBSP_FREE(m);
      expect(clean).not.toMatch(unwanted);
      expect(clean).not.toContain("ESTIMATION");
      for (const n of [...MEANS, 142_134]) expect(clean).not.toMatch(figure(n));
    }
    for (const c of w.host.log.contexts) {
      expect(NBSP_FREE(c)).not.toMatch(unwanted);
      for (const n of [...MEANS, 142_134]) expect(c).not.toMatch(figure(n));
    }
    for (const posted of w.bus!.log) {
      expect(JSON.stringify(posted.data)).not.toMatch(WIRE);
      for (const n of MEANS) expect(JSON.stringify(posted.data)).not.toMatch(figure(n));
    }
  });
});

describe("Feature: the tile 'Si tu refais ce trajet' prefers the player's own runs", () => {
  it("Given the balance is shown and a plan of a known route, Then the tile is the calibrated estimate with its sample size", async () => {
    const w = await page({ plan: true });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = text(w);
    // 180 000 x 0.762
    expect(t).toMatch(
      /Si tu refais ce trajet\s*estimé · 4 trajets · confiance moyenne\s*≈ \+137 160 aUEC/,
    );
    expect(t).toContain("prévu × 76 % (net typique de tes 4 trajets sur cette route)");
    expect(t).not.toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });

  it("Given the balance is hidden, Then the tile shows no calibrated figure at all", async () => {
    const w = await page({ plan: true, always: true });
    const t = text(w);
    expect(t).not.toContain("137 160");
    expect(t).not.toContain("net typique de tes");
  });

  it("Given a plan of goods with no group, Then the card keeps its own figure", async () => {
    const w = await page({ plan: true });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          view: "sc_live_dashboard",
          plan: { ...PLAN, commodity: "Agricium", buy_terminal: "A", sell_terminal: "B" },
        },
      },
    });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).not.toContain("net typique de tes");
    expect(text(w)).toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });

  const runsSection = (n: number): CalibrationSection => ({
    v: 1,
    patch_line: "4.10",
    groups: [
      group({
        kind: "route",
        buy_terminal: "Port Tressler",
        sell_terminal: "Area18 TDD",
        n,
        net_n: n,
        fee_n: n,
        confidence: "low",
        net_confidence: "low",
      }),
    ] as never,
  });

  it("Given two runs of the route and the balance shown, Then the tile keeps the card's own figure, like the route cards (3 runs minimum)", async () => {
    const w = await page({ plan: true, section: runsSection(2) });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).not.toContain("net typique de tes");
    expect(text(w)).not.toContain("137 160");
    expect(text(w)).toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });

  it("Given three runs of the route and the balance shown, Then the tile is calibrated; hidden, Then it is not, whatever the server sent", async () => {
    const shownPage = await page({ plan: true, section: runsSection(3) });
    findButton(shownPage.root, "Afficher le solde").click();
    await shownPage.advance(3 * SECOND);
    expect(text(shownPage)).toMatch(
      /Si tu refais ce trajet\s*estimé · 3 trajets · confiance faible\s*≈ \+137 160 aUEC/,
    );
    expect(text(shownPage)).toContain(
      "prévu × 76 % (net typique de tes 3 trajets sur cette route)",
    );
    for (const n of [2, 3]) {
      const hidden = await page({ plan: true, always: true, section: runsSection(n) });
      const t = text(hidden);
      expect(t).not.toContain("net typique de tes");
      expect(t).not.toContain("137 160");
      expect(t).not.toMatch(/estimé · \d trajets/);
    }
  });
});
