/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { specsSamples } from "./testing/specsFixtures.js";
import { suggestAnswer, type SuggestVariant } from "./testing/suggestFixtures.js";
import { fmtNum } from "./viewLogic.js";

/**
 * The "Fiabilité" block of the route cards inside the assembled page, run as it ships against the fake host. The planner is
 * faked (invented routes, invented market facts): no network, no UEX, no real data.
 */

const SECOND = 1000;
const flat = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

async function search(variant: SuggestVariant = "ok") {
  const scenario = new Scenario();
  scenario.specs = specsSamples(scenario.now).ready;
  const w = await startPage({
    scenario,
    suggest: (args: any) => suggestAnswer(args, { variant }),
  });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(20 * SECOND);
  findButton(w.root, "Plus rentable").click();
  await w.advance(200);
  return w;
}

const blocks = (w: PageWorld): FakeNode[] =>
  findAll(w.root, (n) => n.tag === "details" && n.className.split(" ").includes("ta-rel")).filter(
    isShown,
  );
const textOf = (n: FakeNode) => flat(visibleText(n));
const summaryOf = (n: FakeNode) => n.children.find((c) => c.tag === "summary")!;

describe("Feature: every route card shows its reliability, the level without opening anything", () => {
  it("Given a search, Then each card has a native details block whose summary names the level in words", async () => {
    const w = await search();
    const list = blocks(w);
    expect(list.length).toBeGreaterThanOrEqual(5);
    for (const b of list) {
      const sum = summaryOf(b);
      expect(sum).toBeDefined();
      expect(sum.tag).toBe("summary");
      // the level is a WORD in the summary (the symbol is decoration, the colour a third cue)
      expect(textOf(sum)).toMatch(
        /Fiabilité : (Relevée par des joueurs|Partiellement relevée|Estimation non vérifiée|Relevés non vérifiés)/,
      );
      const icon = findAll(sum, (n) => n.className.split(" ").includes("ta-rel-icon"))[0]!;
      expect(icon.attrs["aria-hidden"]).toBe("true");
      expect(["reported", "partial", "estimate", "unchecked"]).toContain(b.attrs["data-level"]);
    }
  });

  it("Given a card whose prices nobody reported, Then the level is 'Estimation non vérifiée' and the reasons are listed with their sources", async () => {
    const w = await search();
    const first = blocks(w)[0]!;
    expect(first.attrs["data-level"]).toBe("estimate");
    const t = textOf(first);
    expect(t).toContain("Fiabilité : Estimation non vérifiée");
    expect(t).toContain("Aller : le prix de vente");
    expect(t).toContain(`le prix de vente (${fmtNum(457)}) est au plafond`);
    expect(t).toContain("le plan achète tout le stock affiché");
    expect(t).toContain("le prix monte quand le stock baisse");
    expect(t).toContain("pas modélisé");
    expect(t).toContain("0 relevé joueur sur cette route");
    expect(t).toContain("(UEX · ");
    expect(t).toContain("prix relevé il y a");
    expect(t).toContain("Retour : le terminal acheteur est très rempli (72 à 85%)");
  });

  it("Given a card, Then it carries a prudent first run and the sentence on what the estimate leaves out", async () => {
    const w = await search();
    const t = textOf(blocks(w)[0]!);
    expect(t).toContain(
      `Premier trajet de test : ${fmtNum(150)} puis ${fmtNum(100)} SCU au lieu de ${fmtNum(696)} puis ${fmtNum(120)} SCU`,
    );
    expect(t).toContain("Gain estimé pour cette quantité");
    expect(t).toContain("regarde au terminal le prix et le stock réels");
    expect(t).toContain("durée réelle du cycle");
    expect(t).toContain("temps de chargement");
    expect(t).toContain("piraterie");
  });

  it("Given the big figure, Then it is labelled an estimate with the reason that weighs most", async () => {
    const w = await search();
    const t = text(w);
    expect(t).toContain("aUEC par heure, estimé (aucun relevé joueur)");
  });

  it("Given no word that promises anything, Then none of the blocks says 'sûr', 'garanti' or 'certain'", async () => {
    const w = await search();
    for (const b of blocks(w)) expect(textOf(b)).not.toMatch(/\bsûre?\b|garanti|certain/i);
  });

  it("Given the chains list, Then its cards have the block too", async () => {
    const w = await search();
    const all = findAll(
      w.root,
      (n) => n.tag === "article" && n.className.split(" ").includes("ta-card"),
    );
    const shown = all.filter(isShown);
    expect(shown.length).toBeGreaterThan(5);
    for (const card of shown) {
      const own = findAll(
        card,
        (n) => n.tag === "details" && n.className.split(" ").includes("ta-rel"),
      );
      expect(own).toHaveLength(1);
    }
  });
});

const text = (w: PageWorld) => flat(visibleText(w.root));

describe("Feature: a better-evidenced option is marked, and the order stays the planner's", () => {
  it("Given an option relevée par des joueurs below an estimate, Then only the better ones carry 'Mieux vérifiée'", async () => {
    const w = await search("mixed");
    const list = blocks(w);
    const levels = list.map((b) => b.attrs["data-level"]);
    expect(levels.slice(0, 5)).toContain("reported");
    expect(levels[0]).toBe("estimate");
    const marked = list.filter((b) =>
      textOf(summaryOf(b)).includes("Mieux vérifiée que la première de la liste"),
    );
    expect(marked.length).toBeGreaterThanOrEqual(1);
    // the first card is never marked, and no estimate card is marked
    expect(textOf(summaryOf(list[0]!))).not.toContain("Mieux vérifiée");
    for (const b of marked) expect(b.attrs["data-level"]).not.toBe("estimate");
  });

  it("Given only estimates, Then nothing is marked", async () => {
    const w = await search("ok");
    expect(text(w)).not.toContain("Mieux vérifiée");
  });
});

describe("Feature: an answer without the block does not break the card", () => {
  it("Given an older server whose options carry no reliability, Then the cards show and the block is hidden", async () => {
    const scenario = new Scenario();
    scenario.specs = specsSamples(scenario.now).ready;
    const w = await startPage({
      scenario,
      suggest: (args: any) => {
        const a: any = suggestAnswer(args);
        for (const o of [...(a.options ?? []), ...(a.chains ?? [])]) delete o.reliability;
        return a;
      },
    });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(20 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(200);
    expect(text(w)).toContain("Laranite");
    expect(blocks(w)).toHaveLength(0);
    expect(text(w)).toContain("aUEC par heure, estimé");
    expect(text(w)).not.toContain("(aucun relevé joueur)");
  });

  it("Given a block with an unknown level or hostile text, Then the level is refused and the text is bounded", async () => {
    const scenario = new Scenario();
    scenario.specs = specsSamples(scenario.now).ready;
    const w = await startPage({
      scenario,
      suggest: (args: any) => {
        const a: any = suggestAnswer(args);
        a.options[0].reliability.level = "safe";
        a.options[1].reliability.reasons[0] = { text: "<b>x</b>".repeat(300), source: "s" };
        a.options[1].reliability.reasons.length = 1;
        return a;
      },
    });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(20 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(200);
    const list = blocks(w);
    expect(list.map((b) => b.attrs["data-level"])).not.toContain("safe");
    const long = list.map(textOf).find((t) => t.includes("<b>x</b>"));
    expect(long).toBeDefined();
    expect(long!.length).toBeLessThan(2000);
  });
});

describe("Feature: a plan sized from the balance keeps its outlay off the block", () => {
  it("Given a search with the balance as budget, Then the block holds the market facts but no outlay", async () => {
    const scenario = new Scenario();
    scenario.specs = specsSamples(scenario.now).ready;
    const asked: any[] = [];
    const w = await startPage({
      scenario,
      suggest: (args: any) => {
        asked.push(args);
        return suggestAnswer(args);
      },
    });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(20 * SECOND);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const box: any = findAll(
      w.root,
      (n) => n.tag === "label" && n.textContent.startsWith("Budget = mon solde"),
    )[0]!.children[0]!;
    box.checked = true;
    for (const fn of box.listeners["change"] ?? []) fn({ target: box });
    await w.advance(0);
    findButton(w.root, "Plus rentable").click();
    await w.advance(200);
    expect(asked.filter((a) => a.action === "search").at(-1).budget_private).toBe(true);
    const first = textOf(blocks(w)[0]!);
    expect(first).toContain("au plafond");
    expect(first).not.toContain("immobilisés");
  });
});
