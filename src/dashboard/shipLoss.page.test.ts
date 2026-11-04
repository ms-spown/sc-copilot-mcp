/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  findAll,
  findButton,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { LOST_CARGO_PAID, sessionBar, type SessionVariant } from "./testing/sessionScenario.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * A ship destroyed with the player aboard, in the assembled page, against the fake host: what the saved-session card keeps
 * (no note dropped in silence), and what the commerce card says about the run that was interrupted.
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(100);
};
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function sessionPage(variant: SessionVariant) {
  const scenario = new Scenario();
  const w = await startPage({ scenario });
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    sessions: sessionBar(scenario.epoch + scenario.t, include, variant),
  });
  await w.advance(5 * SECOND);
  await fullscreen(w);
  return w;
}

describe("Feature: the session card keeps every note", () => {
  it("Given a resumed session, a start balance that is not the game's, a store notice and 3 losses, Then no note is dropped, the amount paid included", async () => {
    const w = await sessionPage("losses");
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = text(w);
    expect(t).toContain("Session reprise après 1 arrêt");
    expect(t).toContain("Solde de départ");
    expect(t).toContain("Sessions could not be saved");
    expect(t).toContain("Aucune activité depuis plus de 3 h");
    expect(count(t, "Vaisseau détruit à")).toBe(3);
    expect(t).toContain("Propriété du vaisseau non vérifiée");
    expect(t).toMatch(/Payé pour ce cargo : 137\D{1,3}911 aUEC/);
    expect(t).toContain("3 vaisseaux détruits");
    expect(String(LOST_CARGO_PAID)).toBe("137911");
  });

  it("Given 5 losses, Then the card says it lists the last 3 of 5, and still keeps the warning and the amount", async () => {
    const w = await sessionPage("manylosses");
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = text(w);
    expect(count(t, "Vaisseau détruit à")).toBe(3);
    expect(t).toContain("Les 3 derniers vaisseaux détruits sur 5 sont listés.");
    expect(t).toContain("5 vaisseaux détruits");
    expect(t).toContain("Propriété du vaisseau non vérifiée");
    expect(t).toMatch(/Payé pour ce cargo/);
  });

  it("Given the balance hidden, Then the notes and the SCU stay, the amount does not appear anywhere", async () => {
    const w = await sessionPage("losses");
    const t = text(w);
    expect(count(t, "Vaisseau détruit à")).toBe(3);
    expect(t).toContain("Propriété du vaisseau non vérifiée");
    expect(t).not.toMatch(/137\D{0,3}911/);
    expect(t).not.toContain("Payé pour ce cargo");
  });

  it("Given the count in the compact line, Then it uses no-break spaces (the words do not split)", async () => {
    const w = await sessionPage("losses");
    const lines = findAll(
      w.root,
      (n) => /vaisseaux\u00a0détruits/.test(n.textContent) && n.children.length === 0,
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("Feature: the commerce card after a ship was destroyed", () => {
  async function tradePage(lossAgoMs: number) {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) => {
      // The second sale is never written: the run stays "partial" ("Vente en cours") until the loss says otherwise.
      const l: any = tradeLedger(nowMs, scenario.epoch, include, "partial");
      const run = l.trade.runs[0];
      l.trade.ship_losses = [
        {
          at: new Date(nowMs - lossAgoMs).toISOString(),
          ship_class: "MISC_Freelancer",
          cause: "collision",
          causer: "unknown",
          zone: "OOC_Stanton_3a_Lyria",
          cargo_scu: 56,
          cargo_buys: 1,
          unconfirmed_buys: 0,
          unconfirmed_sells: 0,
          run_id: run.id,
          ...(include ? { paid_auec: 10_581 } : {}),
        },
      ];
      return l;
    };
    const w = await startPage({ scenario });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard" } },
    });
    await w.advance(215 * SECOND);
    await fullscreen(w);
    return w;
  }

  it("Given a fresh loss, Then the interrupted run says so once in the card, and the stage no longer says 'rien vendu' or 'pas terminé'", async () => {
    const w = await tradePage(60 * SECOND);
    const t = text(w);
    expect(t).toContain("Trajet interrompu");
    expect(t).not.toContain("Vente en cours");
    expect(t).not.toContain("Achat fait, rien vendu");
    expect(t).not.toContain("n’est pas terminé");
    // two places in full screen: the stage chip and the alert box (the card's own message stays silent)
    expect(count(t, "Cargo présumé perdu")).toBe(1);
    expect(t).toContain("Vaisseau détruit, joueur à bord");
  });

  it("Given a loss older than the alert's 15 minutes, Then the card's message carries the sentence, once", async () => {
    const w = await tradePage(40 * 60 * SECOND);
    const t = text(w);
    expect(t).toContain("Trajet interrompu");
    expect(count(t, "Cargo présumé perdu")).toBe(1);
    expect(t).toContain("Vaisseau détruit : trajet interrompu.");
    expect(t).not.toContain("Vente en cours");
  });
});
