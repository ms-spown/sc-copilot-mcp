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
import { specsSamples } from "./testing/specsFixtures.js";
import { suggestAnswer } from "./testing/suggestFixtures.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * The "Soute" list of the commerce form inside the assembled page, run as it ships against the fake host. The player's
 * case: the game is closed, no ship is flown, the last run moved 696 SCU. The sizes below are invented; the planner is a
 * fake. No network, no real data.
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));

async function form(
  options: {
    ship?: boolean;
    trade?: boolean;
    holds?: unknown[];
    suggest?: (args: any) => unknown | Promise<unknown>;
    balanceHidden?: boolean;
    /** A route plan from Claude (its selling terminal is a UEX name), delivered before the full screen. */
    plan?: boolean;
    /** Stay in the compact view (the default is the full screen). */
    compact?: boolean;
    /** A scenario the test keeps hold of (to change what the stream carries later). */
    scenario?: Scenario;
  } = {},
) {
  const scenario = options.scenario ?? new Scenario();
  if (options.ship) scenario.specs = specsSamples(scenario.now).ready;
  if (options.trade) {
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", {
        commodity: "Laranite",
        scu: 696,
        expected_profit_auec: 180_000,
      });
  }
  const w = await startPage({
    scenario,
    ...(options.suggest ? { suggest: options.suggest } : {}),
    ...(options.holds ? { holds: options.holds } : {}),
    ...(options.balanceHidden === false ? { balanceHidden: false } : {}),
  });
  if (options.plan) {
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
    // The run completes at 202 s: the full screen is asked for after it, as the other tests of the bar do.
    await w.advance(215 * SECOND);
  }
  if (!options.compact) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
  }
  // The story's run is complete at 202 s: let the journal be read.
  await w.advance(options.trade ? 215 * SECOND : 20 * SECOND);
  return w;
}

const selectOf = (w: PageWorld): any => {
  const found = findAll(w.root, (n) => n.tag === "select");
  expect(found).toHaveLength(1);
  return found[0];
};
const optionsOf = (w: PageWorld): any[] =>
  selectOf(w).children.filter((c: any) => c.tag === "option");
const valuesOf = (w: PageWorld): string[] => optionsOf(w).map((o) => o.attrs["value"]);
const labelsOf = (w: PageWorld): string[] => optionsOf(w).map((o) => NBSP_FREE(o.textContent));
const pick = async (w: PageWorld, value: string) => {
  const select = selectOf(w);
  select.value = value;
  for (const fn of select.listeners["change"] ?? []) fn({ target: select });
  await w.advance(0);
};
const lastSearch = (w: PageWorld) =>
  w.host.log.suggests.filter((a) => a.action === "search").at(-1);
const searches = (w: PageWorld) => w.host.log.suggests.filter((a) => a.action === "search");
const refineOpen = (w: PageWorld): boolean =>
  (findAll(w.root, (n) => n.className === "ta-refine")[0] as any).open === true;
const otherField = (w: PageWorld): FakeNode =>
  findAll(w.root, (n) => n.tag === "label" && n.textContent.startsWith("Autre taille"))[0]!;

describe("Feature: the form takes the player's own hold by default", () => {
  it("Given the game is closed and the last run moved 696 SCU, When he clicks 'Plus rentable', Then the search starts with 696, with no error and without opening 'Affiner'", async () => {
    const w = await form({ trade: true });
    // The list stands ready before any click, and nothing was searched.
    expect(selectOf(w).value).toBe("696");
    expect(NBSP_FREE(text(w))).toContain("D’après ton dernier trajet : 696 SCU transportés");
    expect(searches(w)).toEqual([]);
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)).toHaveLength(1);
    expect(searches(w)[0]!.cargo_scu).toBe(696);
    expect(text(w)).not.toContain("Indique la taille");
    expect(text(w)).not.toContain("Je ne connais pas ta soute");
    expect(refineOpen(w)).toBe(false);
    // The note under the results says where the figure came from, and does not call it typed.
    expect(text(w)).toContain("Soute 696 SCU (d’après ton dernier trajet)");
    expect(text(w)).not.toContain("(saisie)");
  });

  it("Given the same case with the balance hidden or shown, Then the default hold is the same", async () => {
    for (const hidden of [true, false]) {
      const w = await form({ trade: true, balanceHidden: hidden });
      expect(selectOf(w).value, String(hidden)).toBe("696");
      findButton(w.root, "Plus rentable").click();
      await w.advance(100);
      expect(searches(w)[0]!.cargo_scu, String(hidden)).toBe(696);
    }
  });

  it("Given a flown ship, Then its hold is the default and is NOT sent (the server names it), and the run stays in the list", async () => {
    const w = await form({ ship: true, trade: true });
    expect(selectOf(w).value).toBe("4");
    expect(valuesOf(w)).toEqual(["4", "696", "other"]);
    expect(labelsOf(w)[0]).toBe("Cutter · 4 SCU · vaisseau en vol");
    expect(labelsOf(w)[1]).toMatch(/^696 SCU · dernier trajet/);
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBeUndefined();
    expect(text(w)).toContain("fiche du vaisseau, Hull C");
  });

  it("Given the server lists sizes, Then each is offered once, with its source, and 'Autre taille…' comes last", async () => {
    const w = await form({
      trade: true,
      holds: [
        {
          scu: 696,
          trips: 3,
          // Relative to the story's clock (it starts on 2026-11-03 at 18:00 UTC), not to the wall clock.
          last_at: "2026-11-03T17:00:00.000Z",
          ship: null,
          basis: null,
        },
        { scu: 120, trips: 2, last_at: "2026-10-30T10:00:00.000Z", ship: null, basis: null },
        { scu: 3200, trips: 0, last_at: null, ship: "Testco Eps Barge", basis: "flotte" },
      ],
    });
    expect(valuesOf(w).sort()).toEqual(["120", "3200", "696", "other"].sort());
    expect(valuesOf(w).at(-1)).toBe("other");
    expect(labelsOf(w).at(-1)).toBe("Autre taille…");
    const barge = labelsOf(w).find((l) => l.includes("3 200"));
    expect(barge).toBe("Testco Eps Barge · 3 200 SCU · dans ta flotte");
    expect(new Set(valuesOf(w)).size).toBe(valuesOf(w).length);
  });
});

describe("Feature: picking another size runs the search again with it", () => {
  it("Given a first search, When he picks another size in the list, Then the search is repeated with that size and says it was his choice", async () => {
    const w = await form({
      trade: true,
      holds: [{ scu: 120, trips: 2, last_at: "2026-10-30T10:00:00.000Z", ship: null, basis: null }],
    });
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)).toHaveLength(1);
    await pick(w, "120");
    // The change speaks for itself in the one live region...
    expect(text(w)).toContain("Soute choisie : 120 SCU");
    await w.advance(1500);
    expect(searches(w)).toHaveLength(2);
    expect(lastSearch(w)!.cargo_scu).toBe(120);
    expect(text(w)).toContain("Choisie par toi dans la liste.");
    expect(text(w)).toContain("Soute 120 SCU (choisie dans ta liste)");
  });

  it("Given nothing was searched yet, When he picks a size, Then nothing is asked before his first click", async () => {
    const w = await form({
      trade: true,
      holds: [{ scu: 120, trips: 1, last_at: "2026-10-30T10:00:00.000Z", ship: null, basis: null }],
    });
    await pick(w, "120");
    await w.advance(5 * SECOND);
    expect(searches(w)).toEqual([]);
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBe(120);
  });

  it("Given a size picked, When the flown ship appears, Then his choice still wins", async () => {
    const scenario = new Scenario();
    const w = await form({ trade: true, scenario });
    expect(selectOf(w).value).toBe("696");
    await pick(w, "696");
    // The ship (a 4 SCU Cutter) shows up in the stream after the pick.
    scenario.specs = specsSamples(scenario.now).ready;
    await w.advance(5 * SECOND);
    expect(valuesOf(w)).toContain("4");
    expect(selectOf(w).value).toBe("696");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBe(696);
  });

  it("Given no pick, When the flown ship appears, Then it takes over as the default (and its hold is not sent)", async () => {
    const scenario = new Scenario();
    const w = await form({ trade: true, scenario });
    expect(selectOf(w).value).toBe("696");
    scenario.specs = specsSamples(scenario.now).ready;
    await w.advance(5 * SECOND);
    expect(selectOf(w).value).toBe("4");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBeUndefined();
  });
});

describe("Feature: 'Autre taille…' reveals a labelled number field", () => {
  it("Given the default, Then the number field is hidden; choosing 'Autre taille…' shows it, focused, with its own label", async () => {
    const w = await form({ trade: true });
    expect(isShown(otherField(w))).toBe(false);
    await pick(w, "other");
    await w.advance(10);
    expect(isShown(otherField(w))).toBe(true);
    const input = otherField(w).children[1] as any;
    expect(input.tag).toBe("input");
    expect(FakeNode.focused).toBe(input);
    // Two controls never share one label.
    const selectLabel = findAll(
      w.root,
      (n) => n.tag === "label" && n.children.includes(selectOf(w)),
    )[0]!;
    expect(selectLabel.textContent.startsWith("Soute (SCU)")).toBe(true);
    expect(selectLabel.children.filter((c) => c.tag === "input")).toEqual([]);
  });

  it("Given 'Autre taille…' left empty, When he searches, Then no search leaves, the form opens on the field and no default is used silently", async () => {
    const w = await form({ trade: true });
    await pick(w, "other");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)).toEqual([]);
    expect(text(w)).toContain("Indique la taille de ta soute (SCU)");
    expect(refineOpen(w)).toBe(true);
  });

  it("Given a size typed, Then it is searched as typed and the note says so", async () => {
    const w = await form({ trade: true });
    await pick(w, "other");
    const input: any = otherField(w).children[1];
    input.value = "96";
    for (const type of ["input", "change"])
      for (const fn of input.listeners[type] ?? []) fn({ target: input });
    await w.advance(0);
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBe(96);
    expect(text(w)).toContain("Saisie par toi.");
    expect(text(w)).toContain("Soute 96 SCU (saisie)");
  });
});

describe("Feature: when nothing is known, the form asks instead of inventing", () => {
  it("Given no ship, no run and no fleet, Then the list holds only a placeholder and 'Autre taille…'", async () => {
    const w = await form();
    expect(valuesOf(w)).toEqual(["", "other"]);
    expect(labelsOf(w)[0]).toBe("Choisis ta soute…");
    expect(selectOf(w).value).toBe("");
    expect(text(w)).toContain("Soute inconnue");
    // No made-up "typical" size anywhere in the list.
    expect(labelsOf(w).join(" ")).not.toMatch(/\d/);
  });

  it("Given no hold at all, When he clicks, Then the server's answer opens 'Affiner' on the list, as a question and not as a red error", async () => {
    const w = await form({ suggest: () => ({ v: 1, state: "error", code: "no_cargo" }) });
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    await w.advance(10);
    expect(text(w)).toContain("Je ne connais pas ta soute");
    expect(refineOpen(w)).toBe(true);
    expect(FakeNode.focused).toBe(selectOf(w));
    const status = findAll(w.root, (n) => n.className === "ta-status")[0]!;
    expect(status.attrs["data-tone"]).toBe("warn");
  });
});

describe("Feature: after a completed run, the follow-up suggestion uses the run's size", () => {
  it("Given no ship and a plan, When a run completes, Then 'Et ensuite ?' is asked with the run's quantity", async () => {
    const w = await form({ trade: true, plan: true });
    await w.advance(3 * SECOND);
    const s = searches(w);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ origin: "Area18 TDD", cargo_scu: 696 });
    // The card says which hold it was computed with and where it came from.
    expect(text(w)).toContain("Soute 696 SCU (d’après ton dernier trajet)");
  });
});

describe("Feature: an automatic re-search never takes the keyboard focus", () => {
  it("Given a first search and a size typed badly in 'Autre taille', When the automatic search runs, Then it says what is wrong and the focus stays where the player put it", async () => {
    const w = await form({ trade: true });
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    await pick(w, "other");
    await w.advance(10);
    const input: any = otherField(w).children[1];
    expect(FakeNode.focused).toBe(input);
    input.value = "abc";
    for (const type of ["input", "change"])
      for (const fn of input.listeners[type] ?? []) fn({ target: input });
    // The player moves on to the budget field before the automatic search fires (900 ms later).
    const budget: any = findAll(
      w.root,
      (n) => n.tag === "label" && n.textContent.startsWith("Budget (aUEC)"),
    )[0]!.children[1];
    budget.focus();
    await w.advance(2 * SECOND);
    expect(text(w)).toContain("La soute doit être un nombre entier de SCU");
    expect(FakeNode.focused).toBe(budget);
    // A click of his own, on the other hand, brings him to the field.
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    await w.advance(10);
    expect(FakeNode.focused).toBe(input);
  });
});

describe("Feature: a typed size is read like a displayed one and bounded", () => {
  it("Given '4 608' and '100001', Then the first is searched as 4608 and the second is refused with the hold's own sentence", async () => {
    const w = await form({ trade: true });
    await pick(w, "other");
    const input: any = otherField(w).children[1];
    const type = async (value: string) => {
      input.value = value;
      for (const t of ["input", "change"])
        for (const fn of input.listeners[t] ?? []) fn({ target: input });
      await w.advance(0);
    };
    await type("4\u00a0608");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w).at(-1)!.cargo_scu).toBe(4608);
    await w.advance(10 * SECOND);
    await type("100001");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)).toHaveLength(1);
    expect(text(w)).toContain("entre 1 et 100 000");
    expect(text(w)).not.toContain("Le serveur n’a pas répondu");
  });
});

describe("Feature: a run under way is listed but never becomes the default", () => {
  it("Given the story's first lot only (the run is under way at 30 s), Then its size is in the list as 'en cours' and nothing is chosen for the player", async () => {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", {
        commodity: "Laranite",
        scu: 696,
        expected_profit_auec: 1,
      });
    const w = await startPage({ scenario });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(40 * SECOND);
    expect(labelsOf(w).some((l) => /696 SCU · trajet en cours/.test(l))).toBe(true);
    expect(selectOf(w).value).toBe("");
    findButton(w.root, "Plus rentable").click();
    await w.advance(100);
    expect(searches(w)[0]!.cargo_scu).toBeUndefined();
  });
});

describe("Feature: the compact view asks the server nothing", () => {
  it("Given the compact view with runs and a hold list, Then the sizes are not read; they are read once the full screen opens", async () => {
    const w = await form({
      trade: true,
      compact: true,
      holds: [{ scu: 120, trips: 2, last_at: "2026-10-30T10:00:00.000Z", ship: null, basis: null }],
    });
    await w.advance(10 * 60 * SECOND);
    expect(w.host.log.holdsCalls).toBe(0);
    expect(w.host.log.suggests).toEqual([]);
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(5 * SECOND);
    expect(w.host.log.holdsCalls).toBe(1);
    expect(valuesOf(w)).toContain("120");
  });
});

describe("Feature: the list is a real, quiet, labelled control", () => {
  it("Given repaints over a minute, Then the option nodes are the same (an open list is never rebuilt) and the live regions are still two", async () => {
    const w = await form({ trade: true });
    const before = optionsOf(w);
    const regions = () => findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length;
    const n = regions();
    await w.advance(60 * SECOND);
    const after = optionsOf(w);
    expect(after).toHaveLength(before.length);
    after.forEach((o, i) => expect(o).toBe(before[i]));
    expect(regions()).toBe(n);
  });

  it("Given the control, Then it is a select inside a label, described by the note under it", async () => {
    const w = await form({ trade: true });
    const select = selectOf(w);
    const note = findAll(w.root, (n) => n.attrs["id"] === select.attrs["aria-describedby"])[0];
    expect(note).toBeDefined();
    expect(NBSP_FREE(note!.textContent)).toContain("D’après ton dernier trajet");
  });

  it("Given a server that is not asked in vain, Then the sizes are requested once per run, not once per repaint", async () => {
    const w = await form({ trade: true });
    const asked = w.host.log.holdsCalls;
    // One for the first sight and one for the run that began: a quiet minute asks nothing more (the list is read again
    // only for a new run or after five minutes).
    expect(asked).toBe(2);
    await w.advance(60 * SECOND);
    expect(w.host.log.holdsCalls).toBe(asked);
    await w.advance(120 * SECOND);
    expect(w.host.log.holdsCalls).toBe(asked + 1);
  });

  it("Given a hold of 696 SCU, Then the quantity reaches neither the model's context nor the channel between Views, and a message holds it only in the recipe and in the card's own figures", async () => {
    const w = await form({ trade: true });
    findButton(w.root, "Plus rentable").click();
    await w.advance(2 * SECOND);
    // Something does go out to the conversation (the card's fixed message), so the check below is not vacuous.
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Demander à l’agent" && isShown(n),
    )[0]!.click();
    await w.advance(SECOND);
    expect(w.host.log.messages.length).toBeGreaterThan(0);
    const quantity = /\b696\b/;
    for (const c of w.host.log.contexts) expect(c).not.toMatch(quantity);
    // The card's message carries the hold as the cargo_scu of the call that reproduces the card (the agent must plan with the
    // same hold to compare like with like): a ship's capacity is not derived from the balance. Nowhere else.
    for (const m of w.host.log.messages) {
      const text = NBSP_FREE(m);
      expect(text.match(/\b696\b/g) ?? []).toHaveLength(2); // the recipe, and the card's own step (this budget is typed, not the balance)
      expect(text).toContain("cargo_scu=696");
    }
    // The channel between Views carries the state of the page (the leading View posts it): not empty, and no quantity.
    expect(w.bus!.log.length).toBeGreaterThan(0);
    for (const posted of w.bus!.log) expect(JSON.stringify(posted.data)).not.toMatch(quantity);
  });
});

describe("Feature: what the server lists is never trusted as markup", () => {
  it("Given hostile names in the list, Then they are shown as plain cleaned text", async () => {
    const w = await form({
      holds: [
        {
          scu: 50,
          trips: 0,
          last_at: null,
          ship: "<img src=x onerror=alert(1)>\u202e",
          basis: "flotte",
        },
      ],
      suggest: (a) => suggestAnswer(a),
    });
    const label = labelsOf(w).find((l) => l.includes("50 SCU"));
    expect(label).toBeDefined();
    expect(label).not.toContain("\u202e");
    expect(label).toContain("<img src=x onerror=alert(1)>");
  });
});
