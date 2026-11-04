/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { sessionBarInfo, sessionBarNormalize } from "./sessionPanel.js";
import { sessionBar, sessionToolAnswer } from "./testing/sessionScenario.js";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { FakeNode } from "./testing/pageHarness.js";
import { pageCss } from "./page.js";
import * as L from "./viewLogic.js";

/**
 * Feature: the compact view folds the session card into ONE line (value first: the dials and the alerts come before a
 * recap), and the line unfolds on a real button. The balance rules are unchanged: the net per hour is in the line only
 * while the balance is shown.
 */

const NOW = Date.UTC(2026, 11, 1, 20, 0, 0);
const NB = (s: string) => s.replace(/\p{Zs}/gu, " ");
const MONEY_DIGITS = /250\D?000|434\D?500|184\D?500|579\D?000|63\D?700/;
const SECOND = 1000;
const text = (w: PageWorld) => NB(visibleText(w.root));

async function page(variant: any = "story") {
  const scenario = new Scenario();
  const w = await startPage({ scenario });
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    sessions: sessionBar(scenario.epoch + scenario.t, include, variant),
  });
  w.host.overrides.tool = (name, args) =>
    sessionToolAnswer(name, args, scenario.epoch + scenario.t);
  return w;
}

describe("Feature: the line of the folded session card", () => {
  const lineOf = (variant: any, show: boolean) =>
    sessionBarInfo(L, sessionBarNormalize(sessionBar(NOW, show, variant), show), {
      showBalance: show,
      now: NOW,
    }).line;

  it("Given the balance is hidden, Then the line has the number, the trips and the time, and no money at all", () => {
    const line = NB(lineOf("story", false));
    expect(line).toMatch(/^Session 4 · 6 trajets · 1 h 28/);
    expect(line).not.toMatch(MONEY_DIGITS);
    expect(line).not.toContain("aUEC");
  });

  it("Given the balance is shown, Then the line adds the net per hour, and only then", () => {
    expect(NB(lineOf("story", true))).toMatch(
      /^Session 4 · 6 trajets · 1 h 28 min · \+125 795 aUEC\/h$/,
    );
    expect(NB(lineOf("story", false))).not.toContain("aUEC/h");
  });

  it("Given an unknown rate, an ended or a quiet session, Then no rate is invented and the state is in the line", () => {
    const bar: any = sessionBar(NOW, true);
    bar.current.money.net_per_hour_auec = null;
    const info = sessionBarInfo(L, sessionBarNormalize(bar, true), { showBalance: true, now: NOW });
    expect(info.line).not.toContain("aUEC/h");
    expect(lineOf("ended", false)).toContain("terminée");
    expect(NB(lineOf("stale", false))).toContain("inactive depuis 3 h");
    expect(lineOf("empty", false)).toBe("Aucune session");
  });
});

describe("Feature: the one line unfolds on a real button", () => {
  const fold = (w: PageWorld) =>
    findAll(w.root, (n) => n.tag === "button" && n.className === "btn ses-one")[0]!;
  const ses = (w: PageWorld) => findAll(w.root, (n) => n.className === "ses")[0]!;

  it("Given the compact view, Then the card is folded by default and the control says so (aria-expanded)", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const b = fold(w);
    expect(b.attrs["type"]).toBe("button");
    expect(b.attrs["aria-expanded"]).toBe("false");
    expect(NB(b.textContent)).toMatch(/^Session 4 · 6 trajets · 1 h 28 min ▾$/);
    expect(ses(w).attrs["data-fold"]).toBe("1");
  });

  it("Given the fold button, Then it names what it controls, its arrow is hidden from the accessible name, and the focus stays on it", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const b = fold(w);
    const bar = findAll(w.root, (n) => n.className === "ses-bar")[0]!;
    expect(b.attrs["aria-controls"]).toBe(bar.attrs["id"]);
    // the accessible name is the text node alone: the arrow is a separate aria-hidden node
    const [text, caret] = b.children;
    expect(text!.textContent).toMatch(/^Session 4 · 6 trajets/);
    expect(text!.textContent).not.toMatch(/[▾▴]/);
    expect(caret!.attrs["aria-hidden"]).toBe("true");
    FakeNode.focused = null;
    b.click();
    await w.advance(100);
    expect(FakeNode.focused).toBe(b);
    expect(caret!.textContent).toBe(" ▴");
  });

  it("Given a click, Then it unfolds and a second click folds it again, with aria-expanded following", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    fold(w).click();
    await w.advance(200);
    expect(ses(w).attrs["data-fold"]).toBe("0");
    expect(fold(w).attrs["aria-expanded"]).toBe("true");
    expect(NB(fold(w).textContent)).toMatch(/▴$/);
    // The control stays where it is: the keyboard focus is not lost by the change.
    expect(isShown(fold(w))).toBe(true);
    fold(w).click();
    await w.advance(200);
    expect(ses(w).attrs["data-fold"]).toBe("1");
    expect(fold(w).attrs["aria-expanded"]).toBe("false");
  });

  it("Given the balance is shown, Then the folded line carries the net per hour; hidden again, it is gone from the whole bar", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(NB(fold(w).textContent)).toContain("+125 795 aUEC/h");
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(fold(w).textContent).not.toContain("aUEC");
    expect(text(w)).not.toMatch(MONEY_DIGITS);
  });

  it("Given a session in progress, Then 'Nouvelle session' is a secondary button, never the loud one (it is the main one only once the session has ended)", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const b = findButton(w.root, "Nouvelle session");
    expect(b.className).toBe("btn small");
    const ended = await page("ended");
    await ended.advance(5 * SECOND);
    expect(findButton(ended.root, "Nouvelle session").className).toBe("btn small primary");
  });

  it("Given the compact view, Then the order is header, alerts, dials, ship, session line, balance, then the rest", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const order = w.root.children.map((n) => n.className.split(" ")[0]!);
    const at = (c: string) => order.indexOf(c);
    expect(at("top")).toBe(0);
    expect(at("alerts")).toBeLessThan(at("inline"));
    expect(at("inline")).toBeLessThan(at("ctx"));
    expect(at("ctx")).toBeLessThan(at("ses"));
    expect(at("ses")).toBeLessThan(at("balance-row"));
    expect(at("ses")).toBeLessThan(at("btn"));
  });

  it("Given no alert, Then the compact view spends no row on it, and the cockpit keeps its 'Aucune alerte'", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const alerts = () => findAll(w.root, (n) => n.className === "alerts")[0]!;
    const chips = findAll(alerts(), (n) => n.className.startsWith("alert") && isShown(n));
    expect(chips).toHaveLength(0);
    expect(alerts().attrs["data-hidden"]).toBe("1");
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(2 * SECOND);
    expect(alerts().attrs["data-hidden"]).toBe("0");
  });

  it("Given a note that matters (a read-only store), Then the folded line says there is one", async () => {
    const line = (variant: any) =>
      sessionBarInfo(L, sessionBarNormalize(sessionBar(NOW, false, variant), false), {
        showBalance: false,
        now: NOW,
      }).line;
    expect(line("readonly")).toContain("fichier en lecture seule");
    expect(line("readonly")).not.toMatch(/\bnote\b/);
    expect(line("story")).not.toContain("lecture seule");
    expect(line("story")).not.toContain("enregistrement impossible");
  });

  it("Given the stylesheet, Then the compact margins beat the margins of the cards (higher specificity, not order)", () => {
    expect(pageCss()).toContain("[data-mode=inline] > :not(#_) { margin: 0; }");
  });

  it("Given an interruption, Then the note says the game stopped, in plain words", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    expect(text(w)).toContain("Session reprise après 1 arrêt du jeu (détail dans Sessions).");
    expect(text(w)).not.toContain("coupure");
  });
});
