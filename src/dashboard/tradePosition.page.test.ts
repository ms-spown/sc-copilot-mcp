/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  FakeNode,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
} from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { suggestAnswer } from "./testing/suggestFixtures.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * "Partir de ma position" inside the assembled page, run as it ships against the fake host. The planner is faked (invented
 * routes and openings). The game log's place is made up ("Stanton1 Lorville"): the game gives no live position.
 */

const SECOND = 1000;
const MIN = 60 * SECOND;
const HOUR = 60 * MIN;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));

async function form(
  options: {
    /** How old the place of the game log is (ms); omitted: the log named none. */
    placeAge?: number;
    /** The newest place the log named is a private one (a hangar): only its time reaches the page. */
    placePrivate?: boolean;
    trade?: boolean;
    /** true: the plan is in force during the run; "late": it is applied after the run (for the next trip). */
    plan?: boolean | "late";
    /** The option is ticked before anything else happens. */
    ticked?: boolean;
    suggest?: (args: any) => unknown | Promise<unknown>;
    balanceHidden?: boolean;
  } = {},
) {
  const scenario = new Scenario();
  const withTrade = options.trade !== false;
  if (withTrade) {
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) => {
      const l: any = tradeLedger(nowMs, scenario.epoch, include, "story", {
        commodity: "Laranite",
        scu: 696,
        expected_profit_auec: 180_000,
      });
      if (options.placeAge !== undefined && l.trade) {
        l.trade = {
          ...l.trade,
          last_place: options.placePrivate
            ? { words: "", at: new Date(nowMs - options.placeAge).toISOString(), private: true }
            : {
                words: "Stanton1 Lorville",
                at: new Date(nowMs - options.placeAge).toISOString(),
              },
        };
      }
      return l;
    };
  }
  const w = await startPage({
    scenario,
    suggest: options.suggest ?? ((a) => suggestAnswer(a)),
    ...(options.balanceHidden === false ? { balanceHidden: false } : {}),
  });
  if (options.ticked) {
    const box: any = findAll(
      w.root,
      (n) => n.tag === "label" && n.textContent.startsWith("Partir de ma position"),
    )[0]!.children[0];
    box.checked = true;
    for (const fn of box.listeners["change"] ?? []) fn({ target: box });
  }
  const sendPlan = () =>
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          view: "sc_live_dashboard",
          plan: {
            commodity: "Laranite",
            buy_terminal: "Port Tressler",
            sell_terminal: "Area18 TDD",
            scu: 696,
            expected_profit_auec: 180_000,
          },
        },
      },
    });
  if (options.plan === true) {
    sendPlan();
    await w.advance(215 * SECOND);
  }
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(withTrade ? 215 * SECOND : 20 * SECOND);
  // A plan applied AFTER the run (for the next trip).
  if (options.plan === "late") {
    sendPlan();
    await w.advance(3 * SECOND);
  }
  return w;
}

const checkbox = (w: PageWorld, label: string): any => {
  const wrap = findAll(w.root, (n) => n.tag === "label" && n.textContent.startsWith(label))[0];
  if (!wrap) throw new Error(`no checkbox "${label}"`);
  return wrap.children[0]!;
};
const tick = async (w: PageWorld, on = true) => {
  const box = checkbox(w, "Partir de ma position");
  box.checked = on;
  for (const fn of box.listeners["change"] ?? []) fn({ target: box });
  await w.advance(0);
};
const originInput = (w: PageWorld): any =>
  findAll(w.root, (n) => n.tag === "label" && n.textContent.startsWith("Départ"))[0]!.children[1];
const typeOrigin = async (w: PageWorld, value: string) => {
  const input = originInput(w);
  input.value = value;
  for (const t of ["input", "change"])
    for (const fn of input.listeners[t] ?? []) fn({ target: input });
  await w.advance(0);
};
const searches = (w: PageWorld) => w.host.log.suggests.filter((a) => a.action === "search");
const refineOpen = (w: PageWorld): boolean =>
  (findAll(w.root, (n) => n.className === "ta-refine")[0] as any).open === true;
const click = async (w: PageWorld, label = "Plus rentable") => {
  findButton(w.root, label).click();
  await w.advance(100);
  await w.advance(10);
};

describe("Feature: the option is off until the player ticks it", () => {
  it("Given a fresh place in the log, Then nothing is assumed: the search has no position and no origin, and the sentence says so", async () => {
    const w = await form({ placeAge: 12 * MIN });
    expect(checkbox(w, "Partir de ma position").checked).toBe(false);
    expect(text(w)).toContain("Position connue : Stanton1 Lorville.");
    expect(text(w)).toContain("Rien n’est supposé tant que la case n’est pas cochée.");
    await click(w);
    const a = searches(w)[0]!;
    expect(a.position).toBeUndefined();
    expect(a.position_text).toBeUndefined();
    expect(a.origin).toBeUndefined();
  });

  it("Given a 'Départ' typed and the option off, Then it is the origin where the route loads, as before", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await typeOrigin(w, "Lorville");
    expect(text(w)).toContain("Où la route commence (elle y charge).");
    await click(w);
    expect(searches(w)[0]).toMatchObject({ origin: "Lorville" });
    expect(searches(w)[0]!.position).toBeUndefined();
  });
});

describe("Feature: from a fresh place, the search starts there and the card says two steps", () => {
  it("Given the option ticked and a place named 12 minutes ago, Then the server is told 'journal' (never a place) and the cards show step 1 and step 2", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await tick(w);
    expect(NBSP_FREE(text(w))).toContain("Départ : Stanton1 Lorville · d’après le journal du jeu");
    expect(NBSP_FREE(text(w))).toContain("il y a 12 min");
    await click(w);
    const a = searches(w)[0]!;
    expect(a.position).toBe("journal");
    expect(a.origin).toBeUndefined();
    expect(JSON.stringify(a)).not.toMatch(/Stanton1|Lorville/);
    const t = text(w);
    expect(t).toContain("Étape 1 · depuis Lorville : transporter");
    expect(t).toContain("Étape 2 · la route :");
    expect(t).toContain("Premier cycle (trajet jusqu’à la route compris)");
    expect(t).toContain("en rejoignant la route à vide");
    expect(t).toContain("Estimations : prix UEX de la communauté");
    expect(t).toContain("1er cycle depuis ta position, estimé");
    // The note under the results says where the plans start, from which source, and what is not computed.
    expect(t).toContain("Départ : Lorville (d’après le journal du jeu");
    expect(t).toContain("Les chaînes A → B → C ne sont pas calculées depuis une position");
    expect(t).not.toContain("Chaînes A → B → C, sans retour");
  });

  it("Given the three kinds of option, Then each card says what it is: an opening trade, an empty flight, already there", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await tick(w);
    await click(w);
    const t = text(w);
    expect(t).toContain("transporter Medical Supplies (120 SCU)");
    expect(t).toContain("aucun trajet rentable trouvé vers");
    expect(t).toContain("la route commence à");
  });

  it("Given a search already made, When the option is ticked, Then it searches again by itself with the position", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await click(w);
    expect(searches(w)).toHaveLength(1);
    await tick(w);
    await w.advance(1500);
    expect(searches(w)).toHaveLength(2);
    expect(searches(w)[1]!.position).toBe("journal");
  });

  it("Given the balance shown or hidden, Then the position behaves the same (a place is not balance-derived)", async () => {
    for (const hidden of [true, false]) {
      const w = await form({ placeAge: 12 * MIN, balanceHidden: hidden });
      await tick(w);
      await click(w);
      expect(searches(w)[0]!.position, String(hidden)).toBe("journal");
      expect(text(w)).toContain("Étape 1");
    }
  });

  it("Given the message to the agent, Then it names step 1 with UEX names, and carries no game token", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await tick(w);
    await click(w);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Demander à l’agent" && isShown(n),
    )[0]!.click();
    await w.advance(SECOND);
    const sent = w.host.log.messages.join("\n");
    expect(sent).toContain("Je pars de ma position");
    expect(sent).toContain("étape 1");
    expect(sent).not.toMatch(/Stanton1/);
  });
});

describe("Feature: what the player types wins, and what is too old is never used", () => {
  it("Given a 'Départ' typed and the option ticked, Then it is the position (the journal is ignored) and no origin goes with it", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await tick(w);
    await typeOrigin(w, "Area18");
    expect(text(w)).toContain("Départ : « Area18 », indiqué par toi");
    await click(w);
    const a = searches(w).at(-1)!;
    expect(a.position_text).toBe("Area18");
    expect(a.position).toBeUndefined();
    expect(a.origin).toBeUndefined();
  });

  it("Given a place named three hours ago, Then it is not used: the search does not leave, 'Affiner' opens and the focus goes to 'Départ'", async () => {
    const w = await form({ placeAge: 3 * HOUR });
    await tick(w);
    expect(NBSP_FREE(text(w))).toContain(
      "Dernier lieu connu trop ancien (journal du jeu, il y a 3 h)",
    );
    await click(w);
    expect(searches(w)).toEqual([]);
    expect(text(w)).toContain("Je n’ai aucune position fiable");
    expect(refineOpen(w)).toBe(true);
    expect(FakeNode.focused).toBe(originInput(w));
  });

  it("Given no source at all, Then the player is asked, never guessed", async () => {
    const w = await form({ trade: false });
    await tick(w);
    expect(text(w)).toContain("Aucune position récente (ni journal, ni dernier trajet)");
    await click(w);
    expect(searches(w)).toEqual([]);
    expect(text(w)).toContain("Je n’ai aucune position fiable");
  });

  it("Given a plan whose last run is complete, Then the plan's end is a position of its own, labelled so", async () => {
    const w = await form({ plan: true });
    await tick(w);
    expect(NBSP_FREE(text(w))).toContain(
      "Départ : Area18 TDD · d’après ton plan (fin du dernier trajet)",
    );
    await click(w);
    expect(searches(w).at(-1)!.position_text).toBe("Area18 TDD");
  });

  it("Given a plan applied after the run for the next trip, Then its end is not a position: the journal stands, or the player is asked", async () => {
    const late = await form({ plan: "late", placeAge: 12 * MIN });
    await tick(late);
    expect(NBSP_FREE(text(late))).toContain("d’après le journal du jeu");
    expect(text(late)).not.toContain("d’après ton plan");
    await click(late);
    expect(searches(late).at(-1)!.position).toBe("journal");
    // Without a journal place there is nothing to use: the plan's selling terminal is where he is GOING.
    const none = await form({ plan: "late" });
    await tick(none);
    expect(text(none)).toContain("Aucune position récente");
    await click(none);
    expect(searches(none).filter((a) => !a.next_run)).toEqual([]);
  });

  it("Given the option off and a 'Départ' typed, Then the hint does not call what he typed a position", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await typeOrigin(w, "Lorville");
    expect(text(w)).toContain("Position connue : Stanton1 Lorville.");
    expect(text(w)).not.toContain("Position connue : Lorville.");
  });

  it("Given an automatic re-search that finds no position, Then it says so and the focus stays where the player put it", async () => {
    const w = await form({ trade: false });
    await click(w);
    expect(searches(w)).toHaveLength(1);
    const budget: any = findAll(
      w.root,
      (n) => n.tag === "label" && n.textContent.startsWith("Budget (aUEC)"),
    )[0]!.children[1];
    budget.focus();
    await tick(w);
    await w.advance(2 * SECOND);
    expect(text(w)).toContain("Je n’ai aucune position fiable");
    expect(FakeNode.focused).toBe(budget);
    // It only says what is missing: "Affiner" is not opened by a search the player did not just ask for.
    expect(refineOpen(w)).toBe(false);
  });

  it("Given the newest place the log named is private (a hangar), Then no source is used: the player is asked, and the plan's older end is not taken instead", async () => {
    const w = await form({ plan: true, placeAge: 1 * MIN, placePrivate: true });
    await tick(w);
    expect(NBSP_FREE(text(w))).toContain("Ton dernier lieu connu est privé");
    expect(text(w)).not.toContain("d’après ton plan");
    expect(text(w)).not.toContain("Stanton1");
    await click(w);
    expect(searches(w).filter((a) => !a.next_run)).toEqual([]);
    expect(text(w)).toContain("Je n’ai aucune position fiable");
  });

  it("Given a search resolved the log's words to a UEX place, Then UEX's name is shown from then on instead of the raw words", async () => {
    const w = await form({ placeAge: 12 * MIN });
    await tick(w);
    expect(text(w)).toContain("Départ : Stanton1 Lorville · d’après le journal du jeu");
    await click(w);
    expect(text(w)).toContain("Départ : Lorville · d’après le journal du jeu");
    expect(text(w)).not.toContain("Départ : Stanton1 Lorville");
  });
});

describe("Feature: what the server refuses is said, and 'Et ensuite ?' keeps its own origin", () => {
  it("Given the server cannot place the place, Then the sentence relays it, 'Affiner' opens and the focus goes to 'Départ'", async () => {
    const w = await form({
      placeAge: 12 * MIN,
      suggest: () => ({
        v: 1,
        state: "error",
        code: "position_unresolved",
        detail: "UEX knows no place that matches it.",
      }),
    });
    await tick(w);
    await click(w);
    expect(text(w)).toContain("UEX ne reconnaît pas ce lieu comme une position");
    expect(text(w)).toContain("UEX knows no place that matches it.");
    expect(refineOpen(w)).toBe(true);
    expect(FakeNode.focused).toBe(originInput(w));
  });

  it("Given the journal gave nothing to the server, Then position_unknown is a sentence, not a red error", async () => {
    const w = await form({
      placeAge: 12 * MIN,
      suggest: () => ({ v: 1, state: "error", code: "position_unknown" }),
    });
    await tick(w);
    await click(w);
    expect(text(w)).toContain("Le journal du jeu ne nomme aucun lieu public");
  });

  it("Given the option ticked and a run that completes under a plan, Then 'Et ensuite ?' starts from the run's end and never carries the position", async () => {
    // The option is ticked BEFORE the run ends and the full screen opens: the automatic suggestion that follows the run
    // starts from where the run ended (its own origin) and must not have used the position option.
    const w = await form({ placeAge: 12 * MIN, plan: true, ticked: true });
    const next = searches(w).filter((a) => a.next_run);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ origin: "Area18 TDD" });
    expect(next[0]!.position).toBeUndefined();
    expect(next[0]!.position_text).toBeUndefined();
  });
});

describe("Feature: the controls are real, labelled and quiet", () => {
  it("Given the form, Then the option is a checkbox described by its sentence, and 'Départ' offers the places the page knows", async () => {
    const w = await form({ placeAge: 12 * MIN, plan: true });
    const box = checkbox(w, "Partir de ma position");
    const note = findAll(w.root, (n) => n.attrs["id"] === box.attrs["aria-describedby"])[0];
    expect(note).toBeDefined();
    // The sentence is outside the label (it would be read twice).
    const label = findAll(w.root, (n) => n.tag === "label" && n.children.includes(box))[0]!;
    expect(label.textContent).toBe("Partir de ma position");
    const input = originInput(w);
    expect(input.attrs["list"]).toBe("ta-places");
    const list = findAll(w.root, (n) => n.tag === "datalist")[0]!;
    const values = list.children.map((o) => o.attrs["value"]);
    expect(values).toContain("Area18 TDD");
    expect(values).toContain("Port Tressler");
  });

  it("Given a minute of repaints, Then no new live region was added by the option", async () => {
    const w = await form({ placeAge: 12 * MIN });
    const regions = () => findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length;
    const before = regions();
    await tick(w);
    await w.advance(60 * SECOND);
    expect(regions()).toBe(before);
  });
});
