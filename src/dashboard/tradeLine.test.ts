/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { buildTradeSection } from "./tradeRun.js";
import {
  AGRICIUM_GUID,
  cargoBuyLine,
  journalTransactions,
  tradeHistory,
  tradeLines,
} from "./testing/tradeScenario.js";
import {
  tradeAgo,
  tradeAgoLong,
  tradeElapsed,
  tradeInlineText,
  tradeRouteText,
  tradePlanAttached,
  tradeRunIdle,
  tradeShopContradicts,
} from "./tradePanel.js";
import { ledgerTradeNormalize } from "./ledgerPanel.js";
import { movementsDetailText } from "./movementsPanel.js";
import * as L from "./viewLogic.js";

/**
 * The compact line of a run under way: what the journal gives (SCU, time since the first purchase) and, apart and
 * labelled, what the plan says. Each element only if its data exists; no id of the journal is ever shown. The target
 * price is the plan's market price, not the balance: it stays when the balance is hidden (a plan built from the balance is
 * dropped by the page before it gets here). A plan that something contradicts is left out, and so is any claim of a trip
 * under way for an old run or a game that is not in a server session. The phrases are exact, non-breaking spaces included.
 */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = BASE + 400_000;
const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  est_trip_minutes: 25,
  sell_unit_price: 457,
  expected_profit_auec: 180_000,
};
const BUYS = tradeLines(BASE).slice(0, 2);
const SELL_ONE = tradeLines(BASE).slice(0, 3);
const section = (lines: string[], include = true): any =>
  ledgerTradeNormalize(
    JSON.parse(
      JSON.stringify(
        buildTradeSection({
          transactions: journalTransactions(lines, BASE + 3_600_000),
          history: tradeHistory(BASE, NOW),
          includeBalance: include,
          nowMs: NOW,
        }),
      ),
    ),
  );
// The first purchase is 20 s into the story: two minutes and ten seconds before this clock.
const AT = BASE + 20_000 + 130_000;
const NB = "\u00a0";

describe("Feature: the compact line of a run under way", () => {
  it("Given a purchase and no plan, Then the line says the goods are unknown, the SCU and how long ago it began", () => {
    const line = tradeInlineText(L, section(BUYS), true, undefined, AT);
    expect(line).toBe(
      `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
    expect(line).not.toMatch(/[0-9a-f]{8}/);
    expect(line).not.toContain("u00a0");
  });

  it("Given the plan and the balance shown, Then the plan's goods, route, estimate and target price come in their own labelled group", () => {
    const line = tradeInlineText(L, section(BUYS), true, PLAN, AT);
    expect(line).toBe(
      `Trajet en cours · 696${NB}SCU achetés · en route depuis 2${NB}min · d’après ton plan : Laranite, Port Tressler → Area18 TDD, estimé 25${NB}min, vente visée 457/SCU`,
    );
    expect(line).not.toMatch(/[0-9a-f]{8}/);
    expect(line).not.toContain("u00a0");
  });

  it("Given the balance hidden, Then the line is the same: the target price is the plan's market price, not an amount of the player", () => {
    const line = tradeInlineText(L, section(BUYS, false), false, PLAN, AT);
    expect(line).toBe(tradeInlineText(L, section(BUYS, true), true, PLAN, AT));
    expect(line).toContain("vente visée 457/SCU");
    // no figure of the run itself: the run's amounts are not in the section without the balance
    expect(JSON.stringify(section(BUYS, false))).not.toMatch(/131\D?504|"money":\{/);
  });

  it("Given a plan with only some data, Then only that data appears, and no plan group when it holds nothing", () => {
    expect(tradeInlineText(L, section(BUYS), true, { sell_terminal: "Area18 TDD" }, AT)).toBe(
      `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés · en route depuis 2${NB}min · d’après ton plan : Area18 TDD`,
    );
    expect(tradeInlineText(L, section(BUYS), true, { scu: 696 }, AT)).toBe(
      `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
  });

  it("Given a clock before the first purchase or no clock, Then no duration is said, never a negative or invented one", () => {
    const early = `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés`;
    expect(tradeInlineText(L, section(BUYS), true, undefined, BASE)).toBe(early);
    expect(tradeInlineText(L, section(BUYS), true)).toBe(early);
    expect(tradeInlineText(L, section(BUYS), true, undefined, BASE + 30_000)).toBe(
      `${early} · en route depuis moins d’1${NB}min`,
    );
  });

  it("Given part of it sold, Then the line says how much, and the time since the first purchase", () => {
    const line = tradeInlineText(L, section(SELL_ONE), true, PLAN, BASE + 20_000 + 36 * 60_000);
    expect(line).toBe(
      `Trajet en cours · 640 / 696${NB}SCU vendus · premier achat il y a 36${NB}min · d’après ton plan : Laranite, Port Tressler → Area18 TDD, estimé 25${NB}min, vente visée 457/SCU`,
    );
  });

  it("Given a plan for other goods than the run's (a run whose goods are named), Then the plan is not attached", () => {
    const named = section(BUYS);
    named.runs[0].commodity = "Agricium";
    expect(tradeInlineText(L, named, true, PLAN, AT)).toBe(
      `Trajet en cours · Agricium · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
    expect(tradeInlineText(L, named, true, { ...PLAN, commodity: "agricium ore" }, AT)).toContain(
      "d’après ton plan : Port Tressler → Area18 TDD",
    );
  });

  it("Given a run cut by a destroyed ship, Then it says so, with no id of the journal", () => {
    const lost = section(BUYS);
    lost.ship_losses = [{ run_id: lost.runs[0].id }];
    expect(tradeInlineText(L, lost, true, PLAN, AT)).toBe(
      "Trajet interrompu · marchandise inconnue · vaisseau détruit",
    );
  });

  it("Given a run still open, Then the time is the one since the first purchase, not the span of the purchases", () => {
    const open = section(BUYS);
    // The two purchases are 2 s apart: that is what `duration_ms` holds, and it is not how long the run has lasted.
    expect(open.runs[0].duration_ms).toBe(2_000);
    expect(tradeElapsed(open.runs[0], AT)).toBe(130_000);
    expect(tradeElapsed(open.runs[0], BASE)).toBeNull();
    expect(tradeAgo(130_000)).toBe(`2${NB}min`);
    expect(tradeAgo(3_900_000)).toBe(`1${NB}h${NB}05${NB}min`);
    expect(tradeAgo(-1)).toBeNull();
  });

  it("Given the journal's shop tokens, Then they are shown as words, never as class names", () => {
    expect(L.shopWords("SCShop_Cargo_Tressler")).toBe("Tressler");
    expect(L.shopWords("Port Tressler")).toBe("Port Tressler");
    expect(L.shopWords("SCShop_Cargo")).toBe("");
    expect(L.shopWords(null)).toBe("");
    const route = tradeRouteText(L, null, section(SELL_ONE).runs[0]);
    expect(route).toBe("marchandise inconnue · Tressler → Area18");
    expect(route).not.toContain("SCShop");
  });
});

describe("Feature: no id of the journal in the balance movements", () => {
  it("Given a movement that names a good by its id and a shop by its class name, Then both are shown as words", () => {
    const detail = movementsDetailText(
      {
        ref: "5c2e9a41",
        shop: "SCShop_Cargo_Tressler",
        category: "explained_by_transaction",
        confidence: "matched",
        hints: [],
      },
      L,
    );
    expect(detail).toBe("marchandise inconnue · Tressler");
    expect(detail).not.toMatch(/[0-9a-f]{8}|SCShop/);
  });
});

describe("Feature: the line does not claim a trip that nothing supports", () => {
  const HOUR = 3_600_000;
  const first = BASE + 20_000;

  it("Given a first purchase more than 3 hours old, Then it is a run left behind: when it was, and no trip under way, no plan", () => {
    const line = tradeInlineText(L, section(BUYS), true, PLAN, first + 5 * HOUR + 600_000, {
      conn: "online",
      planAt: BASE,
    });
    expect(line).toBe(
      `Trajet non terminé · marchandise inconnue · 696${NB}SCU achetés · premier achat il y a 5${NB}h`,
    );
    expect(line).not.toMatch(/en route|plan|Laranite|457/);
    // days from 48 hours
    expect(
      tradeInlineText(L, section(BUYS), true, PLAN, first + 3 * 24 * HOUR + HOUR, {
        conn: "online",
      }),
    ).toBe(
      `Trajet non terminé · marchandise inconnue · 696${NB}SCU achetés · premier achat il y a 3${NB}j`,
    );
    // exactly 3 hours is still under way; just over is not
    expect(tradeRunIdle(section(BUYS).runs[0], first + 3 * HOUR, "online")).toBe(false);
    expect(tradeRunIdle(section(BUYS).runs[0], first + 3 * HOUR + 1, "online")).toBe(true);
    expect(tradeAgoLong(47 * HOUR)).toBe(`47${NB}h`);
    expect(tradeAgoLong(48 * HOUR)).toBe(`2${NB}j`);
  });

  it("Given the game closed, in the menus or disconnected, Then no trip under way and no plan, even for a fresh purchase", () => {
    for (const conn of ["closed", "menu", "disconnected"]) {
      expect(tradeInlineText(L, section(BUYS), true, PLAN, AT, { conn, planAt: BASE })).toBe(
        `Trajet non terminé · marchandise inconnue · 696${NB}SCU achetés · premier achat il y a 2${NB}min`,
      );
    }
    // online, or a connection nobody read: the normal line
    for (const conn of ["online", "unknown", null, undefined]) {
      expect(tradeInlineText(L, section(BUYS), true, undefined, AT, { conn })).toContain(
        "en route depuis 2",
      );
    }
  });

  it("Given a plan whose buying place has no word of the journal's shop, Then the plan is left out", () => {
    // the journal's buying shop is SCShop_Cargo_Tressler
    const other = { ...PLAN, buy_terminal: "Lorville Hub" };
    expect(tradeInlineText(L, section(BUYS), true, other, AT, { conn: "online" })).toBe(
      `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
    // a plan whose place carries the shop's word is attached; accents and case do not matter
    const accent = { ...PLAN, buy_terminal: "Port TRESSLER" };
    expect(tradeInlineText(L, section(BUYS), true, accent, AT, { conn: "online" })).toContain(
      "d’après ton plan : Laranite, Port TRESSLER → Area18 TDD",
    );
    // the selling place too, once something is sold (journal's selling shop: SCShop_Cargo_Area18)
    const wrongSell = { ...PLAN, sell_terminal: "Orison Market" };
    expect(
      tradeInlineText(L, section(SELL_ONE), true, wrongSell, first + 600_000, { conn: "online" }),
    ).not.toContain("d’après ton plan");
    // a shop that is only prefixes has nothing to compare: the plan is kept
    expect(L.shopWords("SCShop_Cargo")).toBe("");
  });

  it("Given a plan this View received after the first purchase, Then it is not attached, and the line says why", () => {
    const line = tradeInlineText(L, section(BUYS), true, PLAN, AT, {
      conn: "online",
      planAt: first + 60_000,
    });
    expect(line).toBe(
      `Trajet en cours · marchandise inconnue · 696${NB}SCU achetés · en route depuis 2${NB}min · plan reçu après le premier achat, non rattaché`,
    );
    expect(line).not.toMatch(/Laranite|457/);
    // received before the purchase: attached; not dated: attached as it is
    expect(
      tradeInlineText(L, section(BUYS), true, PLAN, AT, { conn: "online", planAt: first - 1000 }),
    ).toContain("d’après ton plan : Laranite");
    expect(tradeInlineText(L, section(BUYS), true, PLAN, AT, { conn: "online" })).toContain(
      "d’après ton plan : Laranite",
    );
  });
});

describe("Feature: the goods named by the server", () => {
  it("Given a resolved name, Then the line says it, with or without a plan, and the plan of other goods is left out", () => {
    const named = section(BUYS);
    named.runs[0].commodity_name = "Laranite";
    expect(tradeInlineText(L, named, true, undefined, AT)).toBe(
      `Trajet en cours · Laranite · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
    expect(tradeInlineText(L, named, true, PLAN, AT)).toBe(
      `Trajet en cours · Laranite · 696${NB}SCU achetés · en route depuis 2${NB}min · d’après ton plan : Port Tressler → Area18 TDD, estimé 25${NB}min, vente visée 457/SCU`,
    );
    expect(tradeInlineText(L, named, true, { ...PLAN, commodity: "Agricium" }, AT)).toBe(
      `Trajet en cours · Laranite · 696${NB}SCU achetés · en route depuis 2${NB}min`,
    );
    expect(tradeRouteText(L, null, named.runs[0])).toContain("Laranite");
  });
});

describe("Feature: a plan is spent by the first run that begins after it", () => {
  // run 1: bought at 20 s, sold at 200 s (Laranite); run 2: bought at 300 s (another good, same buying shop)
  const TWO = [...tradeLines(BASE), cargoBuyLine(BASE, 300, 60_000, 300, AGRICIUM_GUID)];
  const first = BASE + 20_000;
  const second = BASE + 300_000;
  const at = second + 130_000;

  it("Given the plan arrived before both runs, Then the second run does not take it, and says why", () => {
    const sec = section(TWO);
    expect(sec.runs.map((r: any) => r.stage)).toEqual(["open", "complete"]);
    const line = tradeInlineText(L, sec, true, PLAN, at, { conn: "online", planAt: BASE });
    expect(line).toBe(
      `Trajet en cours · marchandise inconnue · 300${NB}SCU achetés · en route depuis 2${NB}min · plan déjà utilisé par un trajet précédent, non rattaché`,
    );
    expect(line).not.toMatch(/Laranite|457/);
  });

  it("Given the plan arrived between the two runs, Then the second run is the first after it and takes it", () => {
    const line = tradeInlineText(L, section(TWO), true, PLAN, at, {
      conn: "online",
      planAt: first + 60_000,
    });
    expect(line).toContain("d’après ton plan : Laranite, Port Tressler → Area18 TDD");
  });

  it("Given the plan arrived after the second run began, Then it is not attached", () => {
    expect(
      tradeInlineText(L, section(TWO), true, PLAN, at, { conn: "online", planAt: second + 1000 }),
    ).toContain("plan reçu après le premier achat, non rattaché");
  });
});

describe("Feature: a word every place has proves nothing", () => {
  it("Given generic words in common, Then the plan still contradicts the shop; a specific word keeps it", () => {
    // "Port" is shared, the specific words differ: contradiction
    expect(tradeShopContradicts(L, "Port Olisar", "SCShop_Port_Tressler")).toBe(true);
    expect(tradeShopContradicts(L, "Port Tressler", "SCShop_Port_Tressler")).toBe(false);
    // nothing specific in the shop: not compared, so no contradiction
    expect(tradeShopContradicts(L, "Lorville Hub", "SCShop_Cargo_Hub")).toBe(false);
    expect(tradeShopContradicts(L, "Lorville Hub", "SCShop_Cargo_Admin_Centre")).toBe(false);
    // a missing side is not compared
    expect(tradeShopContradicts(L, "", "SCShop_Cargo_Tressler")).toBe(false);
    expect(tradeShopContradicts(L, "Port Tressler", null)).toBe(false);
  });

  it("Given accents and case, Then they do not make a contradiction (combining marks are removed by an escaped range)", () => {
    expect(tradeShopContradicts(L, "Café Étoilé Hub", "SCShop_Cafe_ETOILE")).toBe(false);
    expect(tradeShopContradicts(L, "Cafe Etoile", "SCShop_Café_Étoile")).toBe(false);
    expect(tradeShopContradicts(L, "Orison", "SCShop_Café_Étoile")).toBe(true);
  });
});

describe("Feature: the full-screen header follows the same rule as the compact line", () => {
  it("Given a named run and a plan for the same goods, Then the run's own name comes first in the route", () => {
    const named = section(BUYS);
    named.runs[0].commodity_name = "Laranite Ore";
    expect(tradeRouteText(L, { ...PLAN, commodity: "Laranite" }, named.runs[0])).toBe(
      "Laranite Ore · Port Tressler → Area18 TDD",
    );
  });

  it("Given the plan is not this run's, Then the attachment says no, with the note when it is a matter of time", () => {
    const run = section(BUYS).runs[0];
    expect(tradePlanAttached(L, PLAN, run, BASE, [run]).ok).toBe(true);
    expect(tradePlanAttached(L, PLAN, run, BASE + 60_000, [run])).toEqual({
      ok: false,
      note: "plan reçu après le premier achat, non rattaché",
    });
    expect(
      tradePlanAttached(L, { ...PLAN, buy_terminal: "Lorville Hub" }, run, BASE, [run]),
    ).toEqual({ ok: false, note: "" });
    // no plan, no run: nothing to attach / the plan alone stands
    expect(tradePlanAttached(L, null, run, BASE, [run]).ok).toBe(false);
    expect(tradePlanAttached(L, PLAN, null, BASE, []).ok).toBe(true);
  });
});
