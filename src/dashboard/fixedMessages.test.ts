import { describe, expect, it } from "vitest";
import { findAll, findButton, isShown, startPage, visibleText } from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";
import { specsSamples } from "./testing/specsFixtures.js";
import { SERVER_INSTRUCTIONS as INSTRUCTIONS } from "../instructions.js";
import { actionMessage } from "./viewLogic.js";

/**
 * F6: every fixed message the page posts to the conversation follows the player's balance choice, read at CLICK time.
 * Shown: the message says NOTHING about the balance and names no include_balance (Claude's tools answer with the amounts by
 * default, so Claude has all the information it needs). Hidden (the toggle, SC_BALANCE=hidden): the instruction stays, exactly
 * as it always was. The balance itself is never in these messages (except the route button, which says so and is pressed).
 */

const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const TAIL_HIDDEN = [" Ne lis pas mon solde.", " N’inclus pas mon solde."];
const ABOUT_BALANCE = /solde|balance|montants|include_balance/i;
const ctx = (showBalance: boolean | undefined) => ({ showBalance, vehicle: "DRAK_Cutter" });

describe("Feature: the contextual fixed messages, whole strings, in each mode", () => {
  const SHOWN: Record<string, string> = {
    analyse:
      "Analyse ma situation dans le jeu à partir de la télémétrie en direct : appelle sc_live_state (sections ship, pilot et weapons) et sc_live_events, dis l’âge des données et ce que le flux ne contient pas, puis ce qui demande mon attention.",
    bilan:
      "Fais le bilan de ma session à partir de la télémétrie en direct : appelle sc_live_events et sc_live_state, résume décollages, atterrissages, sauts, alertes et combats en distinguant les événements confirmed et unverified.",
    loss: "Analyse la perte de mon vaisseau : appelle sc_session_current puis sc_trade_journal, et dis ce qu’ils établissent (vaisseau détruit avec moi à bord, cargo acheté et non vendu, seulement présumé perdu) et ce qu’ils ne disent pas (valeur perdue, suite donnée à l’assurance, coût de remplacement, responsable). Regarde aussi sc_log_context : il ne donne que le nombre de demandes d’assurance de la session, sans lien établi avec cette perte, dis-le tel quel. N’invente rien. Si un de ces outils manque, dis-le.",
    refusal:
      "Que faire maintenant ? Un prix a changé au kiosque pendant ma transaction. Appelle sc_trade_journal pour voir ce qui a été refusé et où j’en suis du trajet, puis relis les prix avec uex_get_price_history et uex_get_market_status pour cette marchandise en disant leur âge (prix collaboratifs). Pour uex_get_price_history, utilise le terminal de vente nommé par le journal ou par moi, sinon demande-le-moi. Propose un seul prochain pas concret, sans inventer de chiffre. Si un outil manque, dis-le.",
    debrief:
      "Fais le debrief de mon dernier trajet : appelle sc_trade_journal puis sc_session_current, regarde le prix de vente actuel avec uex_get_price_history (utilise le terminal de vente nommé par le journal ou par moi, sinon demande-le-moi), et dis ce qui a bien marché, ce que je changerais et la prochaine route. Distingue ce qui est mesuré de ce qui est estimé, et dis explicitement ce qui diffère entre ce que le journal établit et ce que tu trouves toi-même chez UEX (prix, quantités, frais) et pourquoi, avant de donner ton verdict. Si un outil manque, dis-le.",
  };

  it.each(Object.keys(SHOWN))(
    "Given the balance is shown, Then the %s message is exactly the plain text, with nothing about the balance",
    (kind) => {
      const m = actionMessage(kind, ctx(true))!;
      expect(m).toBe(SHOWN[kind]);
      expect(m).not.toMatch(ABOUT_BALANCE);
    },
  );

  it.each(Object.keys(SHOWN))(
    "Given the balance is hidden (or the flag is missing), Then the %s message keeps the instruction and include_balance false",
    (kind) => {
      for (const flag of [false, undefined]) {
        const m = actionMessage(kind, ctx(flag))!;
        expect(m).toContain("include_balance false");
        expect(TAIL_HIDDEN.some((t) => m.endsWith(t))).toBe(true);
        // taking the instruction out gives back the plain text
        const plain = m
          .replace(", tous deux avec include_balance false", "")
          .replace(" avec include_balance false", "");
        for (const t of TAIL_HIDDEN) {
          if (plain.endsWith(t)) expect(plain.slice(0, -t.length)).toBe(SHOWN[kind]);
        }
        expect(m).not.toMatch(/include_balance (true|vrai)/);
      }
    },
  );
});

describe("Feature: the prompts and the server instructions never tell Claude to avoid a balance that is shown", () => {
  it("Given the instructions, Then the balance comes by default and hiding is the player's choice only when a result says so", () => {
    expect(INSTRUCTIONS).toMatch(/aUEC amounts come by default/);
    expect(INSTRUCTIONS).not.toMatch(
      /Ne lis pas mon solde|N’inclus pas mon solde|avoid the balance|do not read my balance/i,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The two messages built by the cards: "Demander à l'agent" of a route, and of the pre-flight check.
// ---------------------------------------------------------------------------------------------------------------------

const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  buy_unit_price: 189,
  sell_unit_price: 457,
  scu: 696,
  expected_profit_auec: 180_000,
};

async function world(hidden: boolean): Promise<PageWorld> {
  const scenario = new Scenario();
  scenario.specs = specsSamples(scenario.now).ready;
  const w = await startPage({ scenario, balanceHidden: hidden });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
  });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(20 * SECOND);
  return w;
}
const shownButton = (w: PageWorld, label: string) =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent === label && isShown(n))[0]!;

describe.each([
  ["shown", false],
  ["hidden", true],
])(
  "Feature: the messages built by the cards, with the balance %s at the click",
  (_label, hidden) => {
    it("Given a route result and 'Demander à l’agent', Then the balance instruction is there only when hidden", async () => {
      const w = await world(hidden);
      findButton(w.root, "Plus rentable").click();
      await w.advance(200);
      shownButton(w, "Demander à l’agent").click();
      await w.advance(300);
      const m = NB(w.host.log.messages.at(-1)!);
      expect(m).toContain("uex_plan_trade");
      expect(
        m.endsWith(
          "propose une meilleure alternative si elle existe." +
            (hidden ? " Ne lis pas mon solde." : ""),
        ),
      ).toBe(true);
      if (hidden) expect(m.match(/Ne lis pas mon solde/g)).toHaveLength(1);
      else expect(m).not.toMatch(ABOUT_BALANCE);
    });

    it("Given the pre-flight check and 'Demander à l’agent', Then the same rule", async () => {
      const w = await world(hidden);
      findButton(w.root, "Vérifier avant de partir").click();
      await w.advance(300);
      findAll(w.root, (n) => n.className === "tr-preflight");
      findButton(
        findAll(w.root, (n) => n.className === "tr-preflight")[0]!,
        "Demander à l’agent",
      ).click();
      await w.advance(300);
      const m = NB(w.host.log.messages.at(-1)!);
      // the exact readings of the check, as ready calls, and the order to reconcile
      expect(m).toContain(
        'uex_get_commodity_prices(commodity_name="Laranite", terminal_name="Port Tressler", side="buy")',
      );
      expect(m).toContain(
        'uex_get_commodity_prices(commodity_name="Laranite", terminal_name="Area18 TDD", side="sell")',
      );
      expect(m).toContain(
        "dis explicitement ce qui diffère et pourquoi (stock, âge des prix, relevés) avant de donner ton verdict",
      );
      expect(m).not.toMatch(/[\n`<>{}[\]]/);
      expect(
        m.endsWith(
          "propose une meilleure alternative si elle existe." +
            (hidden ? " Ne lis pas mon solde." : ""),
        ),
      ).toBe(true);
      if (!hidden) expect(m).not.toMatch(ABOUT_BALANCE);
      expect(visibleText(w.root)).toContain("Message envoyé à Claude");
    });

    it("Given the player toggles the balance between two clicks, Then each message follows the choice at ITS click", async () => {
      const w = await world(hidden);
      findButton(w.root, "Plus rentable").click();
      await w.advance(200);
      shownButton(w, "Demander à l’agent").click();
      await w.advance(300);
      findButton(w.root, hidden ? "Afficher le solde" : "Masquer le solde").click();
      await w.advance(3 * SECOND);
      shownButton(w, "Demander à l’agent").click();
      await w.advance(300);
      const [first, second] = w.host.log.messages.slice(-2).map(NB) as [string, string];
      expect(/Ne lis pas mon solde/.test(first)).toBe(hidden);
      expect(/Ne lis pas mon solde/.test(second)).toBe(!hidden);
    });
  },
);

describe("Feature: 'Et ensuite ?' hands the agent the request that produced its card", () => {
  it("Given a completed run and the card of the next route, Then the message carries the origin and the hold of that very request", async () => {
    const scenario = new Scenario();
    scenario.specs = specsSamples(scenario.now).ready;
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    const w = await startPage({ scenario, balanceHidden: false });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
    });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(235 * SECOND);
    const asks = findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Demander à l’agent" && isShown(n),
    );
    expect(asks.length).toBeGreaterThan(0);
    asks[asks.length - 1]!.click();
    await w.advance(300);
    const m = NB(w.host.log.messages.at(-1)!);
    expect(m).toContain("Je viens de terminer un trajet à");
    expect(m).toContain('origin_terminal_name="Area18 TDD"');
    expect(m).toMatch(/uex_plan_trade\(objective="profit_per_hour", /);
    expect(m).not.toMatch(ABOUT_BALANCE);
  });
});
