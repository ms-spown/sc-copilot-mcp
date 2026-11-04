/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { suggestAnswer } from "./testing/suggestFixtures.js";
import {
  tradeAgentMessage,
  tradeAgoFine,
  tradeBuildRequest,
  tradeCardModel,
  tradeCleanOpening,
  tradeErrorText,
  tradeInputProblem,
  tradeKnownPlaces,
  tradeOpeningModel,
  tradeRecipeArgs,
  tradePositionChoice,
  tradePositionText,
  tradeSuggestClean,
} from "./tradeActions.js";
import { tradePlanAttached } from "./tradePanel.js";
import { buildTradeSection } from "./tradeRun.js";
import {
  AGRICIUM_GUID,
  LARANITE_GUID,
  cargoBuyLine,
  cargoSellLine,
  journalTransactions,
} from "./testing/tradeScenario.js";
import * as L from "./viewLogic.js";

/**
 * "Partir de ma position", the part that runs in the page: which place the search would start from and how it is worded,
 * the request, the re-validation of what the server answers, and the card lines. Invented places and figures; amounts are
 * whole figures.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const at = (ago: number) => new Date(NOW - ago).toISOString();
const lastPlace = (ago: number) => ({ words: "Stanton1 Lorville", at: at(ago) });
const run = (stage: string, ago: number) => ({
  id: at(ago + HOUR),
  stage,
  started_at: at(ago + HOUR),
  ended_at: at(ago),
});
/** The plan was received long before the run began, so it is the run's (the commerce card's own rule decides). */
const choice = (over: any = {}) =>
  tradePositionChoice({
    now: NOW,
    L,
    attached: tradePlanAttached,
    planAt: NOW - 20 * HOUR,
    ...over,
  });

describe("Feature: the place a search would start from, source by source", () => {
  it("Given a place typed in 'Départ', Then it wins over everything", () => {
    const c = choice({
      originText: "  Area18  ",
      lastPlace: lastPlace(MIN),
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", MIN)] },
    });
    expect(c).toMatchObject({ source: "saisie", text: "Area18", label: "Area18" });
  });

  it("Given only a fresh journal place, Then it is the position, with its time", () => {
    const c = choice({ lastPlace: lastPlace(12 * MIN) });
    expect(c).toMatchObject({ source: "journal", label: "Stanton1 Lorville", at: NOW - 12 * MIN });
    expect(NBSP_FREE(tradePositionText(c, NOW))).toBe(
      "Départ : Stanton1 Lorville · d’après le journal du jeu (dernier lieu qu’il cite), il y a 12 min. Le jeu ne donne pas ta position en direct : si tu as bougé, indique-la dans « Départ ».",
    );
  });

  it("Given only the end of a complete run under a plan, Then the plan's selling terminal is the position", () => {
    const c = choice({
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 30 * MIN)] },
    });
    expect(c).toMatchObject({ source: "plan", text: "Port Tressler", at: NOW - 30 * MIN });
    expect(tradePositionText(c, NOW)).toContain("d’après ton plan (fin du dernier trajet)");
  });

  it("Given a plan applied AFTER the run's first purchase (for the next trip), Then it names where he is going, not where he is: it is not a position", () => {
    const c = choice({
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 30 * MIN)] },
      // Received 20 minutes ago: after the run began (90 minutes ago).
      planAt: NOW - 20 * MIN,
    });
    expect(c.source).toBe("aucune");
    // With a journal place it is the journal that stands, never the plan.
    const withJournal = choice({
      lastPlace: lastPlace(50 * MIN),
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 30 * MIN)] },
      planAt: NOW - 20 * MIN,
    });
    expect(withJournal.source).toBe("journal");
  });

  it("Given a plan that cannot be dated, Then its end is never a position", () => {
    const c = choice({
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 30 * MIN)] },
      planAt: undefined,
    });
    expect(c.source).toBe("aucune");
  });

  it("Given a plan spent by an earlier run, Then it is not this run's end either", () => {
    // The earlier run began 3 hours ago; the plan was received 4 hours ago, before it: the earlier run used it up.
    const earlier = run("complete", 2 * HOUR);
    const c = choice({
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 30 * MIN), earlier] },
      planAt: NOW - 4 * HOUR,
    });
    expect(c.source).toBe("aucune");
  });

  describe("a plan reached from a position and its opening run", () => {
    const PLAN = {
      commodity: "Laranite",
      buy_terminal: "Port Tressler",
      sell_terminal: "Area18 TDD",
    };
    const mk = (
      id: string,
      startAgo: number,
      endAgo: number,
      buyShop: string,
      sellShop: string,
    ) => ({
      id,
      stage: "complete",
      started_at: at(startAgo),
      ended_at: at(endAgo),
      buy_shops: [buyShop],
      sell_shops: [sellShop],
    });
    // R1: the opening trade (bought around the player, sold where the route loads). R2: the route.
    const R1 = mk("r1", 3 * HOUR, 2.5 * HOUR, "SCShop_Cargo_Lorville", "SCShop_Port_Tressler");
    const R2 = mk("r2", 2 * HOUR, HOUR, "SCShop_Port_Tressler", "SCShop_Cargo_Area18");
    const runs = [R2, R1];
    const planAt = NOW - 4 * HOUR;

    it("Given the plan carries its step-1 goods, Then the opening run does not use the plan up: the route's run keeps it", () => {
      const plan = { ...PLAN, preamble: "Medical Supplies" };
      expect(tradePlanAttached(L, plan, R2, planAt, runs).ok).toBe(true);
      // The opening run itself is not the plan's (it bought elsewhere).
      expect(tradePlanAttached(L, plan, R1, planAt, runs).ok).toBe(false);
    });

    it("Given no step-1 goods on the plan, Then the same earlier run does use it up, as before", () => {
      expect(tradePlanAttached(L, PLAN, R2, planAt, runs)).toEqual({
        ok: false,
        note: "plan déjà utilisé par un trajet précédent, non rattaché",
      });
    });

    it("Given a run in between that did not sell where the route loads, Then it is a real use of the plan", () => {
      const other = mk("r0", 3 * HOUR, 2.5 * HOUR, "SCShop_Cargo_Lorville", "SCShop_Cargo_Orison");
      expect(
        tradePlanAttached(L, { ...PLAN, preamble: "Medical Supplies" }, R2, planAt, [R2, other]).ok,
      ).toBe(false);
    });

    it("Given the route's run is attached, Then 'where he is' is the plan's end, with 'Et ensuite' able to use it", () => {
      const c = tradePositionChoice({
        now: NOW,
        L,
        attached: tradePlanAttached,
        planAt,
        plan: { ...PLAN, preamble: "Medical Supplies" },
        trade: { runs },
      });
      expect(c).toMatchObject({ source: "plan", text: "Area18 TDD" });
    });

    describe("with runs built by the real journal and the real trade section", () => {
      const BASE_MS = Date.UTC(2026, 10, 4, 8, 0, 0);
      // R1 buys Agricium at Lorville and sells it at Tressler; R2 buys Laranite at Tressler and sells it at Area18.
      const lines = [
        cargoBuyLine(BASE_MS, 60, 50_000, 100, AGRICIUM_GUID, "SCShop_Cargo_Lorville"),
        cargoSellLine(BASE_MS, 600, 60_000, 100, AGRICIUM_GUID, "SCShop_Cargo_Tressler"),
        cargoBuyLine(BASE_MS, 3600, 70_000, 100, LARANITE_GUID, "SCShop_Cargo_Tressler"),
        cargoSellLine(BASE_MS, 4200, 90_000, 100, LARANITE_GUID, "SCShop_Cargo_Area18"),
      ];
      const section: any = JSON.parse(
        JSON.stringify(
          buildTradeSection({
            transactions: journalTransactions(lines, BASE_MS + 24 * HOUR),
            history: [],
            includeBalance: false,
            nowMs: BASE_MS + 2 * HOUR,
            commodityNames: new Map([
              [AGRICIUM_GUID, "Agricium"],
              [LARANITE_GUID, "Laranite"],
            ]),
          }),
        ),
      );
      const [r2, r1] = section.runs;
      // The plan reached the page before the opening trade began.
      const planAtMs = BASE_MS - 10 * MIN;
      const plan = {
        commodity: "Laranite",
        buy_terminal: "Port Tressler",
        sell_terminal: "Area18 TDD",
      };

      it("Given the journal's own runs, Then they are the two trips in the shape the test expects", () => {
        expect(section.runs).toHaveLength(2);
        expect(r1).toMatchObject({
          commodity_name: "Agricium",
          buy_shops: ["SCShop_Cargo_Lorville"],
          sell_shops: ["SCShop_Cargo_Tressler"],
        });
        expect(r2).toMatchObject({
          commodity_name: "Laranite",
          buy_shops: ["SCShop_Cargo_Tressler"],
          sell_shops: ["SCShop_Cargo_Area18"],
        });
      });

      it("Given the plan applied before R1 with its step-1 goods, Then R2 is the plan's run and R1 (the opening trade) is not", () => {
        const withPreamble = { ...plan, preamble: "Agricium" };
        expect(tradePlanAttached(L, withPreamble, r2, planAtMs, section.runs).ok).toBe(true);
        expect(tradePlanAttached(L, withPreamble, r1, planAtMs, section.runs).ok).toBe(false);
      });

      it("Given the same plan without its step-1 goods, Then R1 has used it up and R2 is not attached", () => {
        expect(tradePlanAttached(L, plan, r2, planAtMs, section.runs)).toEqual({
          ok: false,
          note: "plan déjà utilisé par un trajet précédent, non rattaché",
        });
      });
    });

    it("Given only the model's own plan fields, Then the preamble survives the page's and the server's cleaners as plain text", () => {
      expect(L.cleanPlan({ ...PLAN, preamble: "Medical\u0007 Supplies" }).preamble).toBe(
        "Medical Supplies",
      );
    });
  });

  it("Given a run that is not complete, Then it says nothing about where the player is", () => {
    for (const stage of ["open", "partial", "sold_only"]) {
      const c = choice({
        plan: { sell_terminal: "Port Tressler" },
        trade: { runs: [run(stage, MIN)] },
      });
      expect(c.source, stage).toBe("aucune");
    }
  });

  it("Given both a journal place and a run's end, Then the newest wins", () => {
    const newerJournal = choice({
      lastPlace: lastPlace(5 * MIN),
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 40 * MIN)] },
    });
    expect(newerJournal.source).toBe("journal");
    const newerRun = choice({
      lastPlace: lastPlace(50 * MIN),
      plan: { sell_terminal: "Port Tressler" },
      trade: { runs: [run("complete", 10 * MIN)] },
    });
    expect(newerRun.source).toBe("plan");
  });

  it("Given only stale places (older than two hours), Then none is used and the newest is named as too old", () => {
    const c = choice({
      lastPlace: lastPlace(5 * HOUR),
      plan: { sell_terminal: "X" },
      trade: { runs: [run("complete", 9 * HOUR)] },
    });
    expect(c).toMatchObject({ source: "aucune", text: "" });
    expect(c.stale).toMatchObject({ source: "journal", label: "Stanton1 Lorville" });
    const sentence = NBSP_FREE(tradePositionText(c, NOW));
    expect(sentence).toContain("trop ancien (journal du jeu, il y a 5 h)");
    expect(sentence).toContain("indique ta position dans « Départ »");
  });

  it("Given a place just inside and just outside the limit, Then the limit is exactly two hours", () => {
    expect(choice({ lastPlace: lastPlace(2 * HOUR) }).source).toBe("journal");
    expect(choice({ lastPlace: lastPlace(2 * HOUR + MIN) }).source).toBe("aucune");
  });

  it("Given nothing known, Then there is no position and the sentence asks", () => {
    const c = choice({});
    expect(c).toMatchObject({ source: "aucune", stale: null });
    expect(tradePositionText(c, NOW)).toContain("Aucune position récente");
  });

  it("Given malformed or hostile input, Then it is no position (and no throw)", () => {
    for (const lp of [
      { words: "", at: at(MIN) },
      { words: "Lorville", at: "not a date" },
      { words: "Lorville" },
      "text",
      null,
    ]) {
      expect(choice({ lastPlace: lp }).source).toBe("aucune");
    }
    // A time in the future by more than a few minutes (a clock out of step) is never trusted.
    expect(
      choice({ lastPlace: { words: "Lorville", at: new Date(NOW + HOUR).toISOString() } }).source,
    ).toBe("aucune");
    expect(choice({ originText: "a\u202eb\u0007c" }).text).toBe("a b c");
  });

  it("Given ages, Then they are in minutes under an hour and coarse after", () => {
    const f = (ago: number) => NBSP_FREE(tradeAgoFine(NOW - ago, NOW));
    expect(f(10_000)).toBe("à l’instant");
    expect(f(12 * MIN)).toBe("il y a 12 min");
    expect(f(3 * HOUR)).toBe("il y a 3 h");
    expect(tradeAgoFine(null, NOW)).toBe("");
  });
});

describe("Feature: the request from a position", () => {
  const st = (over: any = {}) => ({
    budgetText: "",
    budgetBalance: false,
    cargoText: "",
    originText: "",
    ...over,
  });
  const build = (state: any, position: any) =>
    tradeBuildRequest("profit_per_hour", st(state), {
      position,
      defaultHold: { scu: 100, source: "dernier_trajet" },
    }) as any;

  it("Given the option off, Then the typed 'Départ' is an origin, as before, and no position is sent", () => {
    const r = build({ originText: "Lorville", fromHere: false }, { source: "journal" });
    expect(r.args.origin).toBe("Lorville");
    expect(r.args.position).toBeUndefined();
    expect(r.args.position_text).toBeUndefined();
    expect(r.positionSource).toBe("");
  });

  it("Given the journal as the source, Then only the flag is sent: never a place, never a token", () => {
    const r = build(
      { fromHere: true, originText: "" },
      { source: "journal", label: "Stanton1 Lorville", text: "" },
    );
    expect(r.args.position).toBe("journal");
    expect(JSON.stringify(r.args)).not.toMatch(/Stanton1|Lorville/);
    expect(r.args.origin).toBeUndefined();
    expect(r.positionSource).toBe("journal");
  });

  it("Given a typed place or the end of a run, Then it is position_text, and the origin is NOT sent with it", () => {
    for (const source of ["saisie", "plan"]) {
      const r = build({ fromHere: true, originText: "Area18" }, { source, text: "Area18" });
      expect(r.args.position_text, source).toBe("Area18");
      expect(r.args.origin, source).toBeUndefined();
      expect(r.positionSource).toBe(source);
    }
  });

  it("Given no position, Then there is no request and the reason is 'position' (nothing is guessed)", () => {
    expect(build({ fromHere: true }, { source: "aucune" })).toEqual({
      ok: false,
      reason: "position",
    });
    expect(build({ fromHere: true }, null)).toEqual({ ok: false, reason: "position" });
    expect(tradeInputProblem("position")).toContain("aucune position fiable");
  });

  it("Given the errors of the server, Then each has its own sentence", () => {
    expect(tradeErrorText({ code: "position_unknown" })).toContain(
      "Le journal du jeu ne nomme aucun lieu public",
    );
    const u = tradeErrorText({
      code: "position_unresolved",
      detail: "UEX knows no place that matches it.",
    });
    expect(u).toContain("UEX ne reconnaît pas ce lieu");
    expect(u).toContain("« Départ »");
  });

  it("Given the places the page knows, Then the suggestions are the plan's terminals and the last results', once each, bounded", () => {
    const res = tradeSuggestClean(L, suggestAnswer({ action: "search" })) as any;
    const places = tradeKnownPlaces({
      plan: { sell_terminal: "Area18 TDD", buy_terminal: "Port Tressler" },
      result: res,
    });
    expect(places[0]).toBe("Area18 TDD");
    expect(new Set(places).size).toBe(places.length);
    expect(places.length).toBeLessThanOrEqual(12);
    expect(tradeKnownPlaces({})).toEqual([]);
  });
});

describe("Feature: what the server answers is re-validated", () => {
  const raw = (over: any = {}) => ({
    position: "Lorville",
    at_position: false,
    start: "Port Tressler",
    step1: null,
    reposition_minutes: 25.4,
    first_cycle: { profit: 214368.4, minutes: 71.2, per_hour: 181000.6 },
    without_step1: { profit: 200000, minutes: 71, per_hour: 169000 },
    ...over,
  });

  it("Given a good opening, Then it is rebuilt in whole figures", () => {
    const o = tradeCleanOpening(raw()) as any;
    expect(o).toMatchObject({
      position: "Lorville",
      start: "Port Tressler",
      reposition_minutes: 25,
      first_cycle: { profit: 214368, minutes: 71, per_hour: 181001 },
      without_step1: { profit: 200000, minutes: 71, per_hour: 169000 },
      step1: null,
    });
  });

  it("Given hostile or incomplete openings, Then they are null and the option simply has none", () => {
    for (const bad of [
      null,
      "x",
      {},
      raw({ first_cycle: null }),
      raw({ without_step1: { profit: "a" } }),
      raw({ position: "" }),
      raw({ start: "\u0007" }),
    ]) {
      expect(tradeCleanOpening(bad)).toBeNull();
    }
    const o = tradeCleanOpening(raw({ position: "A\u202eB", step1: { commodity: "" } })) as any;
    expect(o.position).toBe("A B");
    expect(o.step1).toBeNull();
  });

  it("Given an answer from a position, Then the options keep their opening and the position is kept with its time", () => {
    const a = tradeSuggestClean(L, suggestAnswer({ action: "search", position: "journal" })) as any;
    expect(a.position).toMatchObject({ label: "Lorville", source: "journal" });
    expect(typeof a.position.at).toBe("number");
    expect(a.chains).toEqual([]);
    expect(a.options.every((o: any) => o.opening !== null)).toBe(true);
    const plain = tradeSuggestClean(L, suggestAnswer({ action: "search" })) as any;
    expect(plain.position).toBeNull();
    expect(plain.options.every((o: any) => o.opening === null)).toBe(true);
  });
});

describe("Feature: the card says step 1, step 2 and an honest comparison", () => {
  const answer = (args: any = { action: "search", position: "journal" }) =>
    tradeSuggestClean(L, suggestAnswer(args)) as any;
  const byKind = (a: any) => ({
    withStep: a.options.find((o: any) => o.opening.step1),
    empty: a.options.find((o: any) => !o.opening.step1 && !o.opening.at_position),
    here: a.options.find((o: any) => o.opening.at_position),
  });

  it("Given an opening trade, Then step 1 names the goods, the SCU, the destination and an estimated gain; step 2 is the route", () => {
    const { withStep } = byKind(answer());
    const m = tradeOpeningModel(L, withStep)!;
    expect(NBSP_FREE(m.step1)).toBe(
      "Étape 1 · depuis Lorville : transporter Medical Supplies (120 SCU) de Lorville vers Port Tressler · ≈ +8 400 aUEC estimés (prix UEX non relevés par des joueurs).",
    );
    expect(m.step2).toBe("Étape 2 · la route : " + withStep.route + ".");
    expect(m.hasStep1).toBe(true);
  });

  it("Given the comparison, Then it gives both per-hour figures, says the empty flight is the baseline, and keeps the route's steady figure apart", () => {
    const { withStep } = byKind(answer());
    const m = tradeOpeningModel(L, withStep)!;
    const f = withStep.opening.first_cycle.per_hour;
    const w = withStep.opening.without_step1.per_hour;
    expect(f).toBeGreaterThan(w);
    const text = NBSP_FREE(m.compare);
    expect(text).toContain("Premier cycle (trajet jusqu’à la route compris)");
    expect(text).toContain("avec l’étape 1");
    expect(text).toContain("en rejoignant la route à vide");
    expect(text).toContain("Ensuite, la route seule");
    // The caution says it is an estimate, and that step 1 costs no extra time in the model.
    expect(m.caution).toContain("Estimations");
    expect(m.caution).toContain("pas de temps en plus");
  });

  it("Given no profitable opening, Then step 1 is an empty flight to the start, with its time", () => {
    const { empty } = byKind(answer());
    const m = tradeOpeningModel(L, empty)!;
    expect(NBSP_FREE(m.step1)).toContain("aucun trajet rentable trouvé vers");
    expect(NBSP_FREE(m.step1)).toContain("rejoins-le à vide (≈ 25 min)");
    expect(m.hasStep1).toBe(false);
  });

  it("Given a route that starts where the player is, Then there is no step 1 and it says so", () => {
    const { here } = byKind(answer());
    const m = tradeOpeningModel(L, here)!;
    expect(m.step1).toContain("la route commence à");
    expect(m.hasStep1).toBe(false);
  });

  it("Given an unknown speed, Then no hourly figure is claimed", () => {
    const a = tradeSuggestClean(
      L,
      suggestAnswer({ action: "search", position: "journal" }, { variant: "nospeed" }),
    ) as any;
    const m = tradeOpeningModel(L, a.options[0])!;
    expect(m.compare).toContain("durée inconnue : pas de gain par heure");
    expect(m.compare).not.toMatch(/aUEC par heure/);
  });

  it("Given an option without an opening, Then there is no model", () => {
    expect(
      tradeOpeningModel(
        L,
        tradeSuggestClean(L, suggestAnswer({ action: "search" }) as any).options[0],
      ),
    ).toBeNull();
  });

  it("Given the big figure, Then from a position it is the FIRST cycle's, labelled so, and the route's own figures are labelled as the route alone", () => {
    const { withStep } = byKind(answer());
    const m = tradeCardModel(L, withStep, "profit_per_hour");
    expect(m.big.kind).toBe("hour");
    expect(m.big.unit).toContain("1er cycle depuis ta position");
    expect(NBSP_FREE(m.big.value)).toContain(
      NBSP_FREE(L.fmtAuec(withStep.opening.first_cycle.per_hour, true)),
    );
    expect(m.facts.some((f: any) => f.label.startsWith("Route seule"))).toBe(true);
    const time = tradeCardModel(L, withStep, "speed");
    expect(time.big.kind).toBe("time");
    const trip = tradeCardModel(L, withStep, "profit");
    expect(trip.big.unit).toContain("1er cycle");
  });

  it("Given a plan that started from a position, Then the recipe writes the planet it stood on as the departure, and the message says where it started, how old, and what the recipe does not reproduce", () => {
    const a = answer();
    const o = a.options[0];
    const view = {
      objective: "profit_per_hour",
      request: { action: "search", position: "journal" },
      answer: a,
      flags: {},
      priv: false,
      from: "",
      now: a.position.at + 12 * 60_000,
    };
    const args = tradeRecipeArgs(view);
    expect(args.origin_planet_name).toBe("Hurston");
    expect(args.origin_terminal_name).toBeUndefined();
    expect(args.position).toBeUndefined();
    const text = NBSP_FREE(tradeAgentMessage(L, o, view));
    expect(text).toContain("Le plan est parti de ma dernière position d’après le journal du jeu");
    expect(text).toContain("pas une position en direct, il y a 12 min");
    expect(text).toContain("ne reproduit que la planète de départ, pas l’étape 1");
    expect(text).toContain('uex_plan_trade(objective="profit_per_hour"');
    expect(text).toContain('origin_planet_name="Hurston"');
    // No token, no raw log words.
    expect(text).not.toMatch(/Stanton1|journal":/);
    // A place the player typed is said to be his own.
    const typed = tradeAgentMessage(L, o, {
      ...view,
      answer: { ...a, position: { ...a.position, source: "saisie", at: null } },
    });
    expect(typed).toContain("ma dernière position indiquée par moi");
  });

  it("Given a position with a planet, Then the message says the planet forces the first stop and the card's route may be absent; the recipe and the closing order stay", () => {
    const a = answer();
    const view = {
      objective: "profit_per_hour",
      request: { action: "search", position: "journal" },
      answer: a,
      flags: {},
      priv: false,
      from: "",
      now: a.position.at + 60_000,
    };
    const text = NBSP_FREE(tradeAgentMessage(L, a.options[0], view));
    expect(text).toContain("origin_planet_name impose le premier arrêt sur cette planète");
    expect(text).toContain("la route de la carte peut être absente du résultat");
    expect(text).not.toContain("ne reproduit aucun départ");
    // The sentence sits before the recipe, and the recipe before the closing order (never cut).
    expect(text.indexOf("origin_planet_name impose")).toBeLessThan(
      text.indexOf("uex_plan_trade(objective"),
    );
    expect(text.indexOf("uex_plan_trade(objective")).toBeLessThan(text.lastIndexOf("Compare "));
  });

  it("Given a position with no planet, Then the recipe has no origin key and the message says the call reproduces no departure at all", () => {
    const a = answer();
    const noPlanet = { ...a, position: { ...a.position, planet: null } };
    const view = {
      objective: "profit_per_hour",
      request: { action: "search", position: "journal" },
      answer: noPlanet,
      flags: {},
      priv: false,
      from: "",
      now: a.position.at + 60_000,
    };
    const args = tradeRecipeArgs(view);
    expect(Object.keys(args).filter((k) => k.startsWith("origin_"))).toEqual([]);
    const text = NBSP_FREE(tradeAgentMessage(L, a.options[0], view));
    expect(text).toContain("ne reproduit aucun départ");
    expect(text).not.toContain("ne reproduit que la planète de départ");
    expect(text).not.toContain("origin_planet_name");
    expect(text).toContain("uex_plan_trade(objective");
    expect(text).toContain("Compare ");
  });

  it("Given the message to the agent, Then it names step 1 with UEX names only, and never a place token or a balance instruction", () => {
    const { withStep } = byKind(answer());
    const text = tradeAgentMessage(L, withStep, {
      objective: "profit_per_hour",
      flags: {},
      priv: false,
      from: "",
    });
    expect(text).toContain(
      'Je pars de ma position ("Lorville") avec une étape 1 : "Medical Supplies" de "Lorville" vers "Port Tressler".',
    );
    expect(text).not.toMatch(/Stanton1/);
  });
});
