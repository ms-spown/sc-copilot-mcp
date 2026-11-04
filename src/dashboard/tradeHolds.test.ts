/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  tradeAgoText,
  tradeBuildRequest,
  tradeCleanHolds,
  tradeHoldChoices,
  tradeHoldLabel,
  tradeHoldSourceText,
  tradeHoldSourceWords,
  tradeSuggestClean,
} from "./tradeActions.js";
import * as L from "./viewLogic.js";

/**
 * The hold of the commerce form: which sizes are offered, which one is the default and where it comes from. Pure
 * functions, invented ships and runs. Every source alone, the conflicts between them, and nothing known.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW - ms).toISOString();
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const run = (scu: number | null, ago: number) => ({
  id: at(ago + HOUR),
  stage: "complete",
  ended_at: at(ago),
  scu_bought: scu,
});
const known = (scu: number, trips: number, ago: number | null, ship: string | null = null) => ({
  scu,
  trips,
  lastAt: ago === null ? null : NOW - ago,
  ship,
  basis: ship ? "taille" : null,
});
const choose = (over: any = {}) => tradeHoldChoices({ now: NOW, ...over });

describe("Feature: the default hold, source by source", () => {
  it("Given nothing is known, Then there is no list and no default (nothing is made up)", () => {
    const m = choose();
    expect(m.items).toEqual([]);
    expect(m.deflt).toBeNull();
    expect(tradeHoldSourceText(L, m.deflt)).toBe("");
  });

  it("Given only a flown ship, Then its hold is the default, named, and not marked as a run", () => {
    const m = choose({ flown: { scu: 4608, name: "Testco Barge" } });
    expect(m.deflt).toMatchObject({ scu: 4608, source: "vaisseau", ship: "Testco Barge" });
    expect(NBSP_FREE(tradeHoldLabel(L, m.items[0], NOW))).toBe(
      "Testco Barge · 4 608 SCU · vaisseau en vol",
    );
    expect(tradeHoldSourceText(L, m.deflt)).toContain("fiche du wiki");
  });

  it("Given only the journal's last run, Then it is the default, said to be a quantity moved", () => {
    const m = choose({ runs: [run(696, 2 * DAY)] });
    expect(m.deflt).toMatchObject({ scu: 696, source: "dernier_trajet" });
    expect(NBSP_FREE(tradeHoldLabel(L, m.items[0], NOW))).toBe(
      "696 SCU · dernier trajet il y a 2 j",
    );
    const sentence = NBSP_FREE(tradeHoldSourceText(L, m.deflt));
    expect(sentence).toContain("D’après ton dernier trajet : 696 SCU transportés");
    expect(sentence).toContain("peut être inférieure à ta soute");
  });

  it("Given only saved runs, Then the newest is the default while it is fresh", () => {
    const m = choose({ known: [known(120, 3, DAY), known(696, 1, 2 * DAY)] });
    expect(m.deflt).toMatchObject({ scu: 120, source: "dernier_trajet" });
  });

  it("Given saved runs all older than three days, Then the size used most is the default, as a habit", () => {
    const m = choose({
      known: [known(696, 1, 4 * DAY), known(120, 3, 5 * DAY), known(40, 2, 9 * DAY)],
    });
    expect(m.deflt).toMatchObject({ scu: 120, source: "habituelle", trips: 3, of: 6 });
    const sentence = NBSP_FREE(tradeHoldSourceText(L, m.deflt));
    expect(sentence).toContain("120 SCU, 3 sur 6");
    expect(sentence).toContain("pas forcément ta soute pleine");
  });

  it("Given a tie between old sizes, Then the newest of them wins", () => {
    const m = choose({ known: [known(10, 2, 6 * DAY), known(20, 2, 4 * DAY)] });
    expect(m.deflt).toMatchObject({ scu: 20, source: "habituelle" });
  });

  it("Given only one fleet ship with a hold, Then it is a weak default and says so", () => {
    const m = choose({
      known: [{ scu: 3200, trips: 0, lastAt: null, ship: "Testco Eps Barge", basis: "flotte" }],
    });
    expect(m.deflt).toMatchObject({ scu: 3200, source: "flotte", ship: "Testco Eps Barge" });
    expect(tradeHoldSourceText(L, m.deflt)).toContain("rien n’indique que tu l’utilises");
  });

  it("Given two fleet holds and no run, Then both are listed and neither is chosen for the player", () => {
    const m = choose({
      known: [
        { scu: 3200, trips: 0, lastAt: null, ship: "A", basis: "flotte" },
        { scu: 100, trips: 0, lastAt: null, ship: "B", basis: "flotte" },
      ],
    });
    expect(m.items.map((i: any) => i.scu)).toEqual([3200, 100]);
    expect(m.deflt).toBeNull();
  });
});

describe("Feature: the sources in conflict", () => {
  it("Given a flown ship and a last run, Then the flown ship wins and the run stays in the list", () => {
    const m = choose({
      flown: { scu: 4608, name: "Testco Barge" },
      runs: [run(696, HOUR)],
    });
    expect(m.deflt).toMatchObject({ scu: 4608, source: "vaisseau" });
    expect(m.items.map((i: any) => i.scu)).toEqual([4608, 696]);
  });

  it("Given the same size from the ship and from a run, Then one entry carries both facts", () => {
    const m = choose({ flown: { scu: 696, name: "Testco Alpha Hauler" }, runs: [run(696, HOUR)] });
    expect(m.items).toHaveLength(1);
    expect(NBSP_FREE(tradeHoldLabel(L, m.items[0], NOW))).toBe(
      "Testco Alpha Hauler · 696 SCU · vaisseau en vol · dernier trajet il y a 1 h",
    );
  });

  it("Given a fresh journal run and a different, older saved habit, Then the last run wins", () => {
    const m = choose({ runs: [run(300, 2 * HOUR)], known: [known(696, 5, 6 * DAY)] });
    expect(m.deflt).toMatchObject({ scu: 300, source: "dernier_trajet" });
    expect(m.items.map((i: any) => i.scu).sort()).toEqual([300, 696]);
  });

  it("Given a journal run that is also a saved one, Then its trips are not added up twice", () => {
    const m = choose({
      runs: [run(696, 3 * HOUR), run(696, 5 * HOUR)],
      known: [known(696, 2, 3 * HOUR)],
    });
    expect(m.items[0].trips).toBe(2);
  });

  it("Given a size the player chose that no source knows, Then it stays in the list, marked as his choice", () => {
    const m = choose({ runs: [run(696, HOUR)], picked: 250 });
    expect(m.items.map((i: any) => i.scu).sort((a: number, b: number) => a - b)).toEqual([
      250, 696,
    ]);
    const mine = m.items.filter((i: any) => i.scu === 250)[0];
    expect(NBSP_FREE(tradeHoldLabel(L, mine, NOW))).toBe("250 SCU · ton choix");
    // The default is untouched by a choice (the choice is applied by the request, not here).
    expect(m.deflt).toMatchObject({ scu: 696 });
  });

  it("Given runs without a usable quantity, Then they are ignored", () => {
    const m = choose({ runs: [run(null, HOUR), run(0, HOUR), run(0.2, HOUR)] });
    expect(m.items).toEqual([]);
    expect(m.deflt).toBeNull();
  });

  it("Given a ship name next to a size, Then the label says whose size it is, not that it was used", () => {
    const m = choose({ known: [known(696, 1, 2 * DAY, "Testco Alpha Hauler")] });
    expect(NBSP_FREE(tradeHoldLabel(L, m.items[0], NOW))).toBe(
      "696 SCU · taille du Testco Alpha Hauler · dernier trajet il y a 2 j",
    );
  });
});

describe("Feature: the request takes the default, and what the player picked wins", () => {
  const st = (over: any = {}) => ({
    budgetText: "",
    budgetBalance: false,
    cargoText: "",
    originText: "",
    ...over,
  });
  const built = (state: any, ctx: any) =>
    tradeBuildRequest("profit_per_hour", st(state), ctx) as any;

  it("Given a default from a run, Then the hold is sent and its source is the run's (never 'saisie')", () => {
    const r = built({}, { defaultHold: { scu: 696, source: "dernier_trajet" } });
    expect(r.args.cargo_scu).toBe(696);
    expect(r.cargoSource).toBe("dernier_trajet");
  });

  it("Given a default from the habit or the fleet, Then the same, with their own sources", () => {
    expect(built({}, { defaultHold: { scu: 120, source: "habituelle" } }).cargoSource).toBe(
      "habituelle",
    );
    expect(built({}, { defaultHold: { scu: 3200, source: "flotte" } }).args.cargo_scu).toBe(3200);
  });

  it("Given the flown ship's hold as the default, Then no hold is sent: the server uses the ship's and says so", () => {
    const r = built({}, { defaultHold: { scu: 4608, source: "vaisseau" } });
    expect(r.args.cargo_scu).toBeUndefined();
    expect(r.cargoSource).toBe("fiche");
  });

  it("Given a size chosen in the list, Then it wins over the flown ship and every default", () => {
    const r = built(
      { cargoTyped: true, cargoText: "250", cargoPicked: "liste" },
      { defaultHold: { scu: 4608, source: "vaisseau" }, sheetCargo: 4608 },
    );
    expect(r.args.cargo_scu).toBe(250);
    expect(r.cargoSource).toBe("liste");
  });

  it("Given a size typed under 'Autre taille', Then it wins, and is called typed", () => {
    const r = built(
      { cargoTyped: true, cargoText: " 96 ", cargoPicked: "autre" },
      { defaultHold: { scu: 696, source: "dernier_trajet" } },
    );
    expect(r.args.cargo_scu).toBe(96);
    expect(r.cargoSource).toBe("saisie");
  });

  it("Given 'Autre taille' still empty, Then there is no request and no silent fallback to the default", () => {
    const r = built(
      { cargoTyped: true, cargoText: "", cargoPicked: "autre" },
      { defaultHold: { scu: 696, source: "dernier_trajet" } },
    );
    expect(r).toEqual({ ok: false, reason: "cargo_empty" });
  });

  it("Given a bad typed size, Then it is refused as before", () => {
    for (const bad of ["0", "-3", "1.5", "abc", "1234567"]) {
      expect(
        built(
          { cargoTyped: true, cargoText: bad, cargoPicked: "autre" },
          { defaultHold: { scu: 696, source: "dernier_trajet" } },
        ).reason,
        bad,
      ).toBe("cargo");
    }
  });

  it("Given no default and no sheet, Then the request is still built and the server decides (it may know the ship)", () => {
    const r = built({}, { sheetCargo: null, defaultHold: null });
    expect(r.ok).toBe(true);
    expect(r.cargoSource).toBe("inconnue");
    expect(r.args.cargo_scu).toBeUndefined();
  });

  it("Given a caller with only the ship sheet (no default), Then it behaves as before", () => {
    const r = built({}, { sheetCargo: 66 });
    expect(r.args.cargo_scu).toBeUndefined();
    expect(r.cargoSource).toBe("fiche");
  });
});

describe("Feature: what the server lists is re-validated, and ages are worded coarsely", () => {
  it("Given a hostile list, Then only whole sizes in range with cleaned names survive, at most twelve", () => {
    const rows: any[] = [
      { scu: 696.4, trips: 2.2, last_at: at(DAY), ship: "Alpha\u202e Hauler", basis: "taille" },
      { scu: 0 },
      { scu: -5 },
      { scu: "696" },
      { scu: 1e9 },
      null,
      "x",
      { scu: 50, trips: -3, last_at: "never", ship: null, basis: "flotte" },
      { scu: 60, ship: "Beta", basis: "evil" },
      ...Array.from({ length: 30 }, (_, i) => ({ scu: 100 + i })),
    ];
    const out = tradeCleanHolds(rows);
    expect(out).toHaveLength(12);
    expect(out[0]).toEqual({
      scu: 696,
      trips: 2,
      lastAt: NOW - DAY,
      ship: "Alpha Hauler",
      basis: "taille",
    });
    // A basis without a ship, an unknown basis, a bad date, a negative count: all dropped to nothing.
    expect(out[1]).toEqual({ scu: 50, trips: 0, lastAt: null, ship: null, basis: null });
    expect(out[2]).toMatchObject({ scu: 60, ship: "Beta", basis: null });
    expect(tradeCleanHolds("nope")).toEqual([]);
  });

  it("Given the tool's answer, Then the holds state is read, and a malformed one is not an 'ok'", () => {
    const a = tradeSuggestClean(L, { v: 1, state: "holds", holds: [{ scu: 40 }] }) as any;
    expect(a.state).toBe("holds");
    expect(a.holds).toHaveLength(1);
    expect(tradeSuggestClean(L, { v: 2, state: "holds", holds: [] })).toBeNull();
  });

  it("Given instants, Then the age is in hours or days, never minutes (the list must not change every minute)", () => {
    const words = (ms: number) => NBSP_FREE(tradeAgoText(NOW - ms, NOW));
    expect(words(5 * 60_000)).toBe("il y a moins d’une heure");
    expect(words(3 * HOUR)).toBe("il y a 3 h");
    expect(words(30 * HOUR)).toBe("hier");
    expect(words(12 * DAY)).toBe("il y a 12 j");
    expect(words(200 * DAY)).toBe("il y a 6 mois");
    expect(tradeAgoText(null, NOW)).toBe("");
    expect(tradeAgoText(NOW + 3 * DAY, NOW)).toBe("");
  });

  it("Given each source, Then the note under the results names it", () => {
    expect(tradeHoldSourceWords("fiche", "Testco Barge")).toBe("fiche du vaisseau, Testco Barge");
    expect(tradeHoldSourceWords("dernier_trajet", null)).toBe("d’après ton dernier trajet");
    expect(tradeHoldSourceWords("habituelle", null)).toContain("plus fréquente");
    expect(tradeHoldSourceWords("flotte", null)).toContain("liste");
    expect(tradeHoldSourceWords("liste", null)).toContain("choisie");
    expect(tradeHoldSourceWords("saisie", null)).toBe("saisie");
  });
});
