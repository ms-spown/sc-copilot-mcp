import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";
import {
  extractElement,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
} from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { transportLedger, type TransportVariant } from "./testing/ledgerScenario.js";
import { Scenario } from "./testing/scenario.js";

/**
 * The transport ledger panel inside the assembled page, run as it ships against the fake host. The poll answers
 * come from the real ledger code over an invented log (testing/ledgerScenario.ts).
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const GAIN_DIGITS = /184\D?500|434\D?500|250\D?000/;

async function page(variant: TransportVariant = "story", plan = false) {
  const scenario = new Scenario();
  const w = await startPage({ scenario });
  w.host.overrides.poll = (base, include) => ({
    ...base,
    ledger: transportLedger(
      scenario.now,
      scenario.epoch,
      include,
      variant,
      plan ? { expected_profit_auec: 150_000 } : undefined,
    ),
  });
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
/** Only the ledger card (the session card has its own "Rythme"). */
const card = (w: PageWorld) =>
  NBSP_FREE(visibleText(findAll(w.root, (n) => n.className === "card ledger")[0]!));

describe("Feature: the compact line shows the contract in progress", () => {
  it("Given a contract in progress with two steps, When the small view is open, Then one line names it and the step", async () => {
    const w = await page();
    await w.advance(30 * SECOND);
    expect(text(w)).toContain("Contrat en cours : Waste Disposal | Easy · étape 1/2");
    // No card in the small view: the panel belongs to the full-screen view.
    expect(text(w)).not.toContain("Carnet de transport");
  });

  it("Given the first objective is done, Then the line moves on to the next step", async () => {
    const w = await page();
    await w.advance(55 * SECOND);
    expect(text(w)).toContain("étape 2/2");
  });

  it("Given no contract in progress (the log is off, or all are over), Then there is no line at all", async () => {
    const off = await page("off");
    await off.advance(30 * SECOND);
    expect(text(off)).not.toContain("Contrat en cours");
    const empty = await page("empty");
    await empty.advance(30 * SECOND);
    expect(text(empty)).not.toContain("Contrat en cours");
  });
});

describe("Feature: the full-screen panel", () => {
  it("Given a running contract, Then its steps are listed in order with place and goods, ticked as objectives complete, and no quantity", async () => {
    const w = await page();
    await w.advance(30 * SECOND);
    await fullscreen(w);
    const t = text(w);
    expect(t).toContain("Carnet de transport");
    expect(t).toContain("Waste Disposal | Easy");
    expect(t).toContain("Chargement · Outpost Test One · Test Waste Stanton");
    expect(t).toContain("Livraison · Station Test Two");
    expect(t.indexOf("Chargement")).toBeLessThan(t.indexOf("Livraison"));
    expect(t).toContain("accepté à ");
    expect(t).toContain("en cours depuis ");
    // The game gives no quantity and no reward: the panel shows none and says so.
    expect(t).not.toMatch(/\b\d+\s?SCU\b/);
    expect(t).toContain("ni la quantité (SCU) ni la récompense");
    const ticks = () =>
      findAll(w.root, (n) => n.className === "lg-tick" && isShown(n)).map((n) => n.textContent);
    // Two steps of the running contract and three of the other one later; here the first contract has 0 done.
    expect(ticks().slice(0, 2)).toEqual(["○", "○"]);
    await w.advance(25 * SECOND); // 55 s: the first objective is complete
    expect(ticks().slice(0, 2)).toEqual(["✓", "○"]);
  });

  it("Given an abandoned, a finished and a running contract, Then each shows its state, and the finished one its duration", async () => {
    const w = await page();
    await w.advance(100 * SECOND);
    await fullscreen(w);
    const t = text(w);
    expect(t).toContain("abandonné");
    expect(t).toContain("terminé");
    expect(t).toContain("en cours");
    expect(t).toContain("durée 1 min 16 s");
    expect(t).toContain("Contrats terminés");
    expect(t).toContain("Durée cumulée des terminés");
    // Steps without a count of goods: only what the log says.
    expect(t).toContain("Chargement · Outpost Test Three");
  });

  it("Given the balance is hidden, Then no gain, no total, no pace and no planned/measured figure is drawn or kept", async () => {
    const w = await page("story", true);
    await w.advance(110 * SECOND);
    await fullscreen(w);
    const t = card(w);
    expect(t).not.toContain("Gain mesuré");
    expect(t).not.toContain("Gain total");
    expect(t).not.toContain("Rythme");
    expect(t).not.toContain("Prévu / réalisé");
    expect(t).not.toMatch(GAIN_DIGITS);
    expect(w.host.log.polls.every((p) => !p.includeBalance)).toBe(true);
    expect(JSON.stringify(w.host.log.contexts)).not.toMatch(GAIN_DIGITS);
  });

  it("Given the player shows the balance, Then the gain of the finished contract appears, marked raw, with the total and the plan", async () => {
    const w = await page("story", true);
    await w.advance(110 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = text(w);
    expect(t).toContain("Gain mesuré : +184 500 aUEC (brut)");
    expect(t).toContain("chevauche un autre contrat"); // the second contract opened before the first was settled
    expect(t).toContain("Gain total mesuré");
    expect(t).toContain("+184 500 aUEC");
    expect(t).toContain("disponible après 2 min de contrats"); // 76 s of contract time: no pace yet
    expect(t).toContain("Prévu / réalisé (dernier contrat)");
    expect(t).toContain("prévu +150 000 aUEC");
    expect(t).toContain("réalisé +184 500 aUEC");
    expect(t).toContain("mêle achats, récompenses et amendes");
    // Showing it did not send anything to the conversation.
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(c).not.toMatch(GAIN_DIGITS);
  });

  it("Given the balance is shown and then hidden, Then the gain disappears at once, before any new answer", async () => {
    const w = await page();
    await w.advance(110 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).toContain("Gain mesuré");
    findButton(w.root, "Masquer le solde").click();
    expect(text(w)).not.toContain("Gain mesuré");
  });

  it("Given the gain cannot be measured yet, Then the panel says so and shows no number, not zero", async () => {
    const w = await page();
    await w.advance(94 * SECOND); // completed at 90 s, settled at 100 s
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).toContain("Gain en attente");
    expect(text(w)).not.toContain("Gain mesuré :");
  });

  it("Given the full-screen view, Then the aUEC figures never reach the messages, even after many minutes", async () => {
    const w = await page();
    await w.advance(30 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(110 * SECOND);
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(GAIN_DIGITS);
  });
});

describe("Feature: states of the ledger", () => {
  const cases: [TransportVariant, string][] = [
    ["off", "Le carnet a besoin du journal de jeu"],
    ["loading", "Lecture du journal de jeu"],
    ["unreadable", "illisible pour l’instant"],
    ["empty", "Aucun contrat dans la session de jeu en cours"],
  ];
  for (const [variant, expected] of cases) {
    it(`Given the status '${variant}', Then the panel says '${expected}' without any error`, async () => {
      const w = await page(variant);
      await w.advance(30 * SECOND);
      await fullscreen(w);
      expect(text(w)).toContain("Carnet de transport");
      expect(text(w)).toContain(expected);
      expect(text(w)).not.toContain("délai dépassé");
    });
  }

  it("Given the log is off, Then the panel points to sc_log_status and the two variables that enable it", async () => {
    const w = await page("off");
    await w.advance(30 * SECOND);
    await fullscreen(w);
    expect(text(w)).toContain("sc_log_status");
    expect(text(w)).toContain("SC_INSTALL_DIR");
    expect(text(w)).toContain("SC_GAME_LOG_PATH");
  });

  it("Given a server that sends no ledger at all, Then the panel stays out of the way", async () => {
    const w = await startPage();
    await w.advance(30 * SECOND);
    await fullscreen(w);
    expect(text(w)).not.toContain("Carnet de transport");
  });
});

describe("Feature: text from the game is displayed as text only", () => {
  const TAGS = [0x41, 0x42].map((c) => String.fromCodePoint(0xe0000 + c)).join("");
  const hostile = (title: string) => async () => {
    const w = await startPage();
    w.host.overrides.poll = (base) => ({
      ...base,
      ledger: {
        v: 1,
        status: "ok",
        as_of: null,
        partial: false,
        contracts_total: 1,
        contracts: [
          {
            id: "abcd1234",
            title,
            state: "in_progress",
            accepted_at: new Date(w.clock.now - 60_000).toISOString(),
            ended_at: null,
            duration_ms: null,
            steps: [
              {
                kind: "pickup",
                location: `<b>${"L".repeat(900)}</b>`,
                cargo: "<script>x</script>",
              },
            ],
            steps_total: 1,
            steps_done: 0,
            steps_done_is_estimate: true,
          },
        ],
        totals: { completed: 0, abandoned: 0, failed: 0, duration_ms: 0 },
      },
    });
    await w.advance(30 * SECOND);
    await fullscreen(w);
    return w;
  };

  it("Given a title with markup, tag characters, bidi controls and 5 000 characters, Then it is shown capped, clean and as plain text", async () => {
    const w = await hostile(
      `<img src=x onerror=alert(1)> ${TAGS}\u202e\u2066${"A".repeat(5000)}`,
    )();
    const t = visibleText(w.root);
    expect(t).toContain("<img src=x onerror=alert(1)> ");
    expect(t).not.toContain("\u202e");
    expect(t).not.toMatch(/[\u{e0000}-\u{e007f}]/u);
    const titles = findAll(w.root, (n) => n.className === "lg-title").map((n) => n.textContent);
    expect([...titles[0]!].length).toBeLessThanOrEqual(80);
    // No element was created from the text (the fake DOM would also throw on innerHTML).
    expect(findAll(w.root, (n) => ["img", "script", "b"].includes(n.tag))).toEqual([]);
    const places = findAll(w.root, (n) => n.className === "lg-step-text").map((n) => n.textContent);
    expect([...places[0]!].length).toBeLessThanOrEqual(200);
    expect(places[0]).toContain("<script>x</script>");
  });

  it("Given a title that is empty, Then the panel says 'Contrat sans titre'", async () => {
    const w = await hostile("")();
    expect(text(w)).toContain("Contrat sans titre");
  });
});

describe("Feature: the ledger code ships with the page", () => {
  it("Given the assembled page, Then the panel follows the same rules as the rest of the View", () => {
    const script = viewScript();
    expect(script).toContain("function ledgerPanel");
    expect(script).not.toMatch(/__vi_|__vite_|import\.meta/);
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    const style = extractElement(dashboardHtml(), "style")!;
    expect(style).toContain(".lg-contract");
    expect(style).not.toMatch(/url\(|@import/);
    // Nothing moves in the panel, so reduced motion needs nothing more; the rule stays satisfied.
    expect(style).not.toMatch(/\.lg-[^{]*\{[^}]*(animation|transition)/);
  });
});
