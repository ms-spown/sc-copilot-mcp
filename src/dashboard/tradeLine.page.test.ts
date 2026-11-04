import { describe, expect, it } from "vitest";
import { findAll, isShown, startPage, visibleText } from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { tradeBalanceAt, tradeLedger, type TradeVariant } from "./testing/tradeScenario.js";

/**
 * The compact line and the full-screen header of a run under way, inside the assembled page run as it ships against
 * the fake host (the poll answers come from the real model over invented transactions). Run with the balance shown AND
 * hidden: the target price is the plan's market price and shows in both. The synthetic run: the purchases are
 * 20 s and 22 s into a 600 s loop, the sales 200 s and 202 s.
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  scu: 696,
  expected_profit_auec: 180_000,
  buy_unit_price: 189,
  sell_unit_price: 457,
  est_trip_minutes: 25,
};

async function page(variant: TradeVariant = "story", connection: any = null) {
  const scenario = new Scenario();
  scenario.connection = connection;
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) => tradeLedger(nowMs, scenario.epoch, include, variant, PLAN);
  const w = await startPage({ scenario });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
  });
  return w;
}

/** Puts the page in the wanted balance mode whatever its default is (the buttons are named after the action). */
async function balance(w: PageWorld, shown: boolean) {
  const label = shown ? "Afficher le solde" : "Masquer le solde";
  const btn = findAll(
    w.root,
    (n) => n.tag === "button" && (n.textContent === label || n.attrs["aria-label"] === label),
  )[0];
  if (btn) btn.click();
  await w.advance(3 * SECOND);
}

const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(100);
};
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));
const line = (w: PageWorld): string => {
  const n = findAll(w.root, (x) => x.className.includes("tr-line") && isShown(x))[0];
  return n ? NBSP_FREE(n.textContent) : "";
};
const meta = (w: PageWorld): string => {
  const n = findAll(w.root, (x) => x.className === "tr-meta")[0];
  return n ? NBSP_FREE(n.textContent) : "";
};

describe.each([
  ["balance shown", true],
  ["balance hidden", false],
])("Feature: the line of a run under way (%s)", (_label, shown) => {
  it("Given a purchase made two and a half minutes ago, Then the small view says what, how many, since when, and what the plan says", async () => {
    const w = await page();
    await w.advance(150 * SECOND); // 128 s after the first purchase
    await balance(w, shown);
    const l = line(w);
    expect(l).toContain("Trajet en cours · 696 SCU achetés · en route depuis ");
    expect(l).toMatch(/en route depuis [12] min/);
    expect(l).toContain("d’après ton plan : Laranite, Port Tressler → Area18 TDD, estimé 25 min");
    // the target price is the plan's market price, not the balance: it is there in both modes
    expect(l).toContain("vente visée 457/SCU");
    // never an id of the journal, never an escape written out
    expect(l).not.toMatch(/[0-9a-f]{8}/);
    expect(l).not.toContain("u00a0");
    expect(text(w)).not.toMatch(/5c2e9a41|SCShop_/);
  });

  it("Given the full screen while the run is under way, Then it says how long it has lasted, not the span of the purchases", async () => {
    const w = await page();
    await w.advance(150 * SECOND);
    await balance(w, shown);
    await fullscreen(w);
    const m = meta(w);
    expect(m).toMatch(/en cours depuis [12] min/);
    expect(m).not.toMatch(/durée \d+ s/);
    expect(m).toContain("trajet estimé 25 min");
    expect(text(w)).not.toMatch(/5c2e9a41|SCShop_/);
  });

  it("Given the run is over, Then the final duration appears and the 'under way' wording is gone", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await balance(w, shown);
    await fullscreen(w);
    expect(meta(w)).toMatch(/durée 3 min 02 s/);
    expect(meta(w)).not.toContain("en cours depuis");
    // the balance movements (shown only with the balance) name goods and shops too: no id, no class name anywhere
    expect(text(w)).not.toMatch(/5c2e9a41|SCShop_/);
  });
});

describe("Feature: the page does not claim a trip when the game says the player is not in a server session", () => {
  const menu = { state: "menu", since: null, code: null, reason: null };

  it("Given the game is in the menus with a purchase made 2 minutes ago, Then the line says when it was and nothing about a trip or a plan", async () => {
    const w = await page("story", menu);
    await w.advance(150 * SECOND);
    const l = line(w);
    expect(l).toMatch(
      /^Trajet non terminé · marchandise inconnue · 696 SCU achetés · premier achat il y a [12] min$/,
    );
    expect(l).not.toMatch(/en route|plan|Laranite|457/);
    await fullscreen(w);
    expect(meta(w)).toMatch(/premier achat il y a [12] min/);
    expect(meta(w)).not.toContain("en cours depuis");
  });

  it("Given the plan reached the page after the purchase, Then the line leaves it out and says so", async () => {
    const w = await page();
    await w.advance(150 * SECOND);
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
    });
    await w.advance(2 * SECOND);
    const l = line(w);
    expect(l).toContain("plan reçu après le premier achat, non rattaché");
    expect(l).not.toMatch(/Laranite|457|d’après ton plan/);
  });
});

describe("Feature: the planned profit shown while the balance is hidden is the plan's own figure", () => {
  it("Given a plan that is not private and no journal, When the balance is hidden, Then 'Bénéfice prévu' is exactly the plan's profit", async () => {
    const w = await page("none");
    await w.advance(5 * SECOND);
    await balance(w, false);
    await fullscreen(w);
    const card = NBSP_FREE(visibleText(findAll(w.root, (n) => n.className === "card trade")[0]!));
    expect(card).toMatch(/Bénéfice prévu[\s\S]*\+180 000 aUEC/);
    expect(card).toContain("marge du plan, avant frais");
    // no figure of the player's balance anywhere in the card
    expect(card).not.toMatch(/320\D?000|463\D?000|143\D?000/);
  });
});
