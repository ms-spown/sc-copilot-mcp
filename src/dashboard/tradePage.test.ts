/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";
import {
  extractElement,
  FakeBus,
  findAll,
  findButton,
  isShown,
  startPage,
  VirtualClock,
  visibleText,
} from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { tradeBalanceAt, tradeLedger, type TradeVariant } from "./testing/tradeScenario.js";
import { ledgerChannelClean, ledgerStripBalance } from "./ledgerPanel.js";
import * as L from "./viewLogic.js";

/**
 * The commerce card inside the assembled page, run as it ships against the fake host, on the synthetic copy of the
 * player's run (buy 131 504, sell 318 072, planned 180 000, balance 320 000 -> 463 000). The poll answers come from
 * the real model (tradeRun.ts) over invented transactions (testing/tradeScenario.ts).
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const CHANNEL = L.viewConfig().channelName;
/** Every figure MEASURED in the run, as the page formats it (grouped by a thin space) or raw. The plan's own figures
 * (180 000 planned, 457 per SCU) come from the model, not from the balance: they are not in this list. */
const AMOUNTS =
  /131\D?504|318\D?072|186\D?568|143\D?000|463\D?000|320\D?000|43\D?568|136\D?432|19\D?468|24\D?100/;
const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  scu: 696,
  expected_profit_auec: 180_000,
  buy_unit_price: 189,
  sell_unit_price: 457,
  est_trip_minutes: 25,
  safety_note: "Route peu risquée",
  price_points: [430, 436, 441, 450, 447, 455, 462, 458, 449, 452, 460, 457],
  price_points_label: "7 derniers jours",
};

async function page(variant: TradeVariant = "story", plan: any = PLAN) {
  const scenario = new Scenario();
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) =>
    tradeLedger(nowMs, scenario.epoch, include, variant, plan ?? undefined);
  const w = await startPage({ scenario });
  if (plan) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan } },
    });
  }
  return w;
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
const card = (w: PageWorld) =>
  NBSP_FREE(visibleText(findAll(w.root, (n) => n.className === "card trade")[0]!));

describe("Feature: the commerce card says which figure is which", () => {
  it("Given the player's run and the balance shown, Then net, turnover and fees are named and add up", async () => {
    const w = await page();
    await w.advance(215 * SECOND); // the last sale at 202 s, settled 8 s later
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toContain("Laranite");
    expect(t).toContain("Port Tressler → Area18 TDD");
    expect(t).toMatch(/Bénéfice net\s*variation du solde\s*\+143 000 aUEC/);
    expect(t).toContain("tout ce qui a bougé le solde y est compté");
    expect(t).toMatch(/Chiffre d’affaires\s*mesuré\s*318 072 aUEC/);
    expect(t).toMatch(/Frais\s*mesuré\s*−43 568 aUEC/);
    expect(t).toContain("13,7 % du chiffre d’affaires");
    // the waterfall: planned profit -> price gap -> gross margin -> fees -> net
    expect(t).toMatch(/Bénéfice prévu[\s\S]*\+180 000 aUEC/);
    expect(t).toMatch(/Écart de prix[\s\S]*\+6 568 aUEC/);
    expect(t).toMatch(/Marge brute[\s\S]*\+186 568 aUEC/);
    expect(t).toMatch(/−43 568 aUEC/);
    // fees per side, labelled as measured
    expect(t).toMatch(/Achat\s*−19 468 aUEC/);
    expect(t).toMatch(/Vente\s*−24 100 aUEC/);
    // the next trip, net of the observed fees, labelled as an estimate
    expect(t).toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432 aUEC/);
    // the old, misleading names are gone
    expect(t).not.toContain("Réalisé");
    expect(text(w)).not.toContain("Réalisé");
  });

  it("Given the run is settled, Then pace and projection are labelled as estimates with their hypotheses", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toContain("Durée du trajet");
    expect(t).toMatch(/Répétitions par heure\s*4,6/);
    expect(t).toContain("estimé, à ce rythme");
    // one run only: no "per 4 hours" figure yet, and the overhead is an assumption said as such
    expect(t).not.toContain("Sur 4 h de jeu");
    expect(t).not.toContain("hypothèse de 4 h");
    expect(t).toContain("10 min d’attente et de trajet à vide supposées");
    expect(t).toContain("après deux trajets mesurés");
    expect(t).toContain("même trajet, mêmes prix et même quantité à chaque fois");
  });

  it("Given a plan with price points, Then the price curve shows the target and the price really obtained", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toContain("Cours de vente · 7 derniers jours");
    expect(t).toContain("Prix visé par le plan : 457 aUEC/SCU");
    expect(t).toContain("Prix obtenu en moyenne (mesuré) : 457 aUEC/SCU");
    expect(t).toContain("12 relevés");
    expect(t).toContain("la courbe ne vient jamais d’un appel du tableau de bord à UEX");
  });
});

describe("Feature: no amount without the balance", () => {
  it("Given the balance is hidden, Then the card shows goods, places, SCU and time but no amount of the run", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    const t = card(w);
    expect(t).toContain("Trajet terminé");
    expect(t).toContain("696 SCU");
    expect(t).toContain("Le solde est masqué");
    // The planned profit comes from the model, not from the balance; every amount of the run must be absent.
    const withoutPlan = t.replace(/180 000/g, "");
    expect(withoutPlan).not.toMatch(AMOUNTS);
    expect(t).not.toContain("Bénéfice net\n+");
  });

  it("Given the balance was shown and is hidden again, Then the amounts disappear at once", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(card(w)).toContain("+143 000 aUEC");
    findButton(w.root, "Masquer").click();
    expect(card(w).replace(/180 000/g, "")).not.toMatch(AMOUNTS);
  });

  it("Given the small view, Then one line says where the run stands, with an amount only when the balance is shown", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    expect(text(w)).toContain("Dernier trajet · marchandise 5c2e9a41 : terminé");
    expect(text(w)).not.toMatch(AMOUNTS);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).toContain(
      "Dernier trajet · marchandise 5c2e9a41 : bénéfice net +143 000 aUEC (mesuré)",
    );
  });

  it("Given the balance is shown, Then nothing of the run goes to the conversation", async () => {
    const w = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(30 * SECOND);
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(c).not.toMatch(AMOUNTS);
    for (const c of w.host.log.contexts) expect(c).not.toMatch(/mesuré|chiffre d.affaires|Frais/i);
  });
});

describe("Feature: honest when it does not know", () => {
  it("Given the dashboard was opened after the purchases, Then the net is unknown, says why, and fees are not invented", async () => {
    const w = await page("unknown");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toMatch(/Bénéfice net\s*inconnu\s*—/);
    expect(t).toContain("n’a pas vu ton solde juste avant le premier achat");
    expect(t).toMatch(/Frais\s*inconnu\s*—/);
    expect(t).toMatch(/Marge brute[\s\S]*\+186 568 aUEC/);
    expect(t).not.toContain("+143 000");
  });

  it("Given the stream was cut around the sales, Then the fees are deduced as a total and labelled estimated", async () => {
    const w = await page("estimated");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toMatch(/Bénéfice net\s*variation du solde\s*\+143 000 aUEC/);
    expect(t).toMatch(/Frais\s*estimé\s*−43 568 aUEC/);
    expect(t).toContain("estimé : marge brute − bénéfice net, sans détail par côté");
    expect(t).not.toContain("Achat\n");
  });

  it("Given a reward paid during the trip and the fees measured, Then a visible warning says the balance variation is not this trip's profit", async () => {
    const w = await page("reward");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toMatch(/Bénéfice net\s*variation du solde\s*\+543 000 aUEC/);
    expect(t).toMatch(
      /Attention : Le solde a monté de 400 000 aUEC de plus que la marge brute et les frais ne l’expliquent/,
    );
    expect(t).toContain("la variation du solde n’est pas le bénéfice de ce seul trajet");
    expect(t).toMatch(/Frais\s*mesuré\s*−43 568 aUEC/);
  });

  it("Given a reward and a stream cut, Then the gap is not shown as fees", async () => {
    const w = await page("rewardcut");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toMatch(/Frais\s*inconnu\s*—/);
    expect(t).toContain("le solde a bougé pour une autre raison");
    expect(t).toContain("Attention : Le solde a bougé pour une autre raison que les frais");
    expect(t).not.toMatch(/Frais\s*estimé/);
    expect(t).not.toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });

  it("Given only the first lot was sold, Then the run is in progress and no net is claimed", async () => {
    const w = await page("partial");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toContain("Vente en cours");
    expect(t).toContain("Le trajet n’est pas terminé");
    expect(t).not.toContain("+143 000");
  });

  it("Given no trade journal, Then the card says so, shows the plan, and calls the balance change by its name", async () => {
    const w = await page("none");
    await w.advance(100 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toContain("Plan seul");
    expect(t).toContain("désactivé ou illisible");
    expect(t).toMatch(/Bénéfice prévu\s*\+180 000 aUEC/);
    expect(t).toMatch(/Variation du solde\s*[−+]/);
    expect(t).toContain("pas un bénéfice");
    expect(t).not.toMatch(/Bénéfice net\s*(mesuré|estimé|calculé)/);
  });

  it("Given neither a plan nor a journal, Then the card holds only the action bar: no figure, no tile", async () => {
    const w = await page("none", null);
    await w.advance(20 * SECOND);
    await fullscreen(w);
    const cards = findAll(w.root, (n) => n.className === "card trade").filter((n) => isShown(n));
    expect(cards).toHaveLength(1);
    const t = NBSP_FREE(visibleText(cards[0]!));
    expect(t).toContain("Trouver une route");
    expect(t).not.toContain("Bénéfice net");
    expect(t).not.toContain("Chiffre d’affaires");
  });
});

describe("Feature: the page stays safe", () => {
  it("Given hostile text in the plan, Then it is plain text, bounded, with the new fields cleaned", async () => {
    const evil = '<img src=x onerror="alert(1)">' + "x".repeat(200);
    const w = await page("story", {
      ...PLAN,
      commodity: evil,
      safety_note: evil,
      price_points_label: evil,
      price_points: [1, "2", NaN, Infinity, -5, 3, ...Array.from({ length: 80 }, (_, i) => i)],
    });
    await w.advance(215 * SECOND);
    await fullscreen(w);
    const t = card(w);
    expect(t).toContain("<img src=x");
    expect(t).not.toContain("x".repeat(70));
    // the DOM of the harness refuses innerHTML: reaching here means nothing was set as markup
  });

  it("Given the shipped script, Then the commerce modules use no innerHTML and no Node import", () => {
    const script = viewScript();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(script).not.toMatch(/\brequire\(|from "node:|import\(/);
    const html = dashboardHtml();
    expect(extractElement(html, "script")).toBeTruthy();
    expect(html).toContain("tr-wf-bar");
  });
});

describe("Feature: the commerce section on the channel between Views", () => {
  const rich = tradeLedger(
    Date.UTC(2026, 10, 3, 18, 3, 40),
    Date.UTC(2026, 10, 3, 18, 0, 0),
    true,
    "story",
    PLAN,
  );

  it("Given a ledger with a run and its money, Then the sender's strip and the receiver's clean drop every amount but keep the run", () => {
    expect(JSON.stringify(rich)).toMatch(/318072/);
    const sent = ledgerStripBalance(rich);
    expect(JSON.stringify(sent)).not.toMatch(AMOUNTS);
    expect(JSON.stringify(sent)).not.toMatch(/"money"|net|fees|turnover/);
    expect(sent.trade.runs[0].commodity).toBe("5c2e9a41");
    const received = ledgerChannelClean(rich);
    expect(JSON.stringify(received)).not.toMatch(AMOUNTS);
    expect(received.trade.runs[0]).toMatchObject({
      commodity: "5c2e9a41",
      stage: "complete",
      scu_bought: 696,
    });
    expect(received.trade.runs[0].money).toBeNull();
    expect(ledgerChannelClean(received)).toEqual(received);
  });

  it("Given a leader that shows the balance, Then the wire carries the run without any amount, and the follower shows it without amounts", async () => {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const pages: PageWorld[] = [];
    for (let i = 0; i < 2; i++) {
      pages.push(await startPage({ scenario, clock, bus }));
      await clock.advance(50);
    }
    const [follower, leader] = pages as [PageWorld, PageWorld];
    for (const p of pages) {
      p.fromHost({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
      });
    }
    await clock.advance(30 * SECOND);
    findButton(leader.root, "Afficher le solde").click();
    await clock.advance(190 * SECOND);
    for (const p of pages) await fullscreen(p);
    await clock.advance(2 * SECOND);
    expect(card(leader)).toContain("+143 000 aUEC");
    const wire = JSON.stringify(bus.log);
    expect(bus.log.length).toBeGreaterThan(20);
    // The plan is not the balance: it may travel, nothing measured does.
    expect(wire.replace(/180000/g, "")).not.toMatch(
      /(?<![\d.])(131504|318072|186568|143000|463000|320000|43568|136432)(?!\d)/,
    );
    expect(wire).toContain("5c2e9a41");
    const t = card(follower);
    expect(t).toContain("Trajet terminé");
    expect(t.replace(/180 000/g, "")).not.toMatch(AMOUNTS);
  });

  it("Given a hostile 'leader' that sends a run with its money, Then the money is dropped on reception", async () => {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const w = await startPage({ scenario, clock, bus });
    await clock.advance(10 * SECOND);
    bus.inject(CHANNEL, { t: "hello", id: "viewimpostor1", rank: clock.now + 1000, visible: true });
    await clock.advance(10);
    const s = new Scenario();
    s.advanceTo(30_000);
    const poll: any = s.poll(false);
    poll.ledger = rich;
    bus.inject(CHANNEL, { t: "snapshot", id: "viewimpostor1", rank: clock.now + 1000, poll });
    await clock.advance(2 * SECOND);
    await fullscreen(w);
    await clock.advance(2 * SECOND);
    const t = card(w);
    expect(t).toContain("Trajet terminé");
    expect(t).not.toMatch(AMOUNTS);
  });
});
