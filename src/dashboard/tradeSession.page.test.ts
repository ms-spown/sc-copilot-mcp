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
import { sessionBar } from "./testing/sessionScenario.js";
import { tradeBalanceAt, tradeLedger, type TradeVariant } from "./testing/tradeScenario.js";

/**
 * F3: the commerce card must not show the run of an OLDER play session as if it were a result of the current one.
 * The synthetic journal (invented Game.log lines through the real parser): one run bought at 20 s and sold at 200 s of the
 * story (318 072 aUEC of sales), an optional second one at 300 to 330 s. The play session starts at a chosen second.
 */

const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const TURNOVER = /(?<![\d])318 072(?![\d])/;
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

/** `sessionStartS`: the second of the story the saved play session began at; "off": sessions are off; "empty": none yet. */
async function page(
  sessionStartS: number | "off" | "empty",
  options: { variant?: TradeVariant; hidden?: boolean; plan?: boolean } = {},
) {
  const scenario = new Scenario();
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) =>
    tradeLedger(nowMs, scenario.epoch, include, options.variant ?? "story", PLAN);
  const w = await startPage({ scenario, balanceHidden: options.hidden ?? false });
  w.host.overrides.poll = (base: any, include: boolean) => {
    if (sessionStartS === "off")
      return { ...base, sessions: sessionBar(scenario.now, include, "off") };
    const bar: any = sessionBar(
      scenario.now,
      include,
      sessionStartS === "empty" ? "empty" : "story",
    );
    if (sessionStartS !== "empty") {
      bar.current.started_at = new Date(scenario.epoch + sessionStartS * SECOND).toISOString();
      bar.current.ended_at = null;
    }
    return { ...base, sessions: bar };
  };
  if (options.plan) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
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
const text = (w: PageWorld) => NB(visibleText(w.root));
const cls = (n: FakeNode, c: string) => n.className.split(" ").includes(c);
const inside = (n: FakeNode, c: string): boolean => {
  for (let p: FakeNode | null = n; p; p = p.parentNode) if (cls(p, c)) return true;
  return false;
};
/** Every node whose own text holds `re` (hidden ones too, and attributes). */
const holders = (w: PageWorld, re: RegExp): FakeNode[] =>
  findAll(w.root, (n) => NB(n.textContent).match(re) !== null && n.children.length === 0);
/** Outside the card's figures: in the folded last-run block, or in the dated list of balance movements. */
const apart = (n: FakeNode) => inside(n, "tr-last") || inside(n, "mv");
const last = (w: PageWorld) => findAll(w.root, (n) => cls(n, "tr-last"))[0]!;
const card = (w: PageWorld) => findAll(w.root, (n) => n.tag === "section" && cls(n, "trade"))[0]!;
const line = (w: PageWorld): FakeNode | undefined =>
  findAll(w.root, (n) => cls(n, "tr-line") && isShown(n))[0];

describe("Feature: a run of the journal that is not of the play session is set apart", () => {
  it("Given the session began before the run, Then the card shows it as the session's own result", async () => {
    const w = await page(0);
    await w.advance(215 * SECOND);
    await fullscreen(w);
    const hits = holders(w, TURNOVER).filter(isShown);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((n) => !inside(n, "tr-last"))).toBe(true);
    expect(isShown(last(w))).toBe(false);
    expect(text(w)).toContain("Trajet terminé");
  });

  it("Given a new, empty session began after the run, Then no figure of the run stands in the session's place", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    await fullscreen(w);
    // The turnover of the old run is only inside the folded 'last known run' block (the dated list of balance movements,
    // in the folded details, is the one other place a sale appears: it is a timeline, not a result of the session).
    const hits = holders(w, TURNOVER);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(apart)).toBe(true);
    // The headline tiles, the waterfall and the stage badge of the card are not drawn for it.
    const tiles = findAll(w.root, (n) => cls(n, "tr-tile"));
    expect(tiles.every((n) => !isShown(n))).toBe(true);
    expect(isShown(findAll(w.root, (n) => cls(n, "tr-wf"))[0]!)).toBe(false);
    const stage = findAll(w.root, (n) => cls(n, "tr-stage"))[0]!;
    expect(isShown(stage)).toBe(false);
    expect(text(w)).toContain("Aucun trajet dans cette session pour l’instant");
    // The block is labelled with the date and 'hors session', and is folded.
    const sum = findAll(last(w), (n) => n.tag === "summary")[0]!;
    expect(NB(sum.textContent)).toMatch(
      /^Dernier trajet connu · (aujourd’hui|hier|\d+ \S+) \d{2}:\d{2}, hors session$/,
    );
    expect(isShown(last(w))).toBe(true);
    expect(last(w).attrs["open"]).toBeUndefined();
    // And it says it is not part of the session.
    expect(
      NB(
        last(w)
          .children.map((c) => c.textContent)
          .join(" "),
      ),
    ).toContain("il n’entre dans aucun chiffre de la session");
    // Nothing outside the folded block says the run is finished.
    expect(
      findAll(
        card(w),
        (n) => isShown(n) && !inside(n, "tr-last") && /Trajet terminé/.test(n.textContent),
      ),
    ).toHaveLength(0);
  });

  it("Given the old run and the balance hidden, Then the block holds no amount anywhere", async () => {
    const w = await page(300, { hidden: true });
    await w.advance(450 * SECOND);
    await fullscreen(w);
    expect(holders(w, TURNOVER)).toHaveLength(0);
    expect(text(w)).not.toMatch(/(?<![\d])143 000(?![\d])/);
    expect(
      NB(
        last(w)
          .children.map((c) => c.textContent)
          .join(" "),
      ),
    ).toContain("Montants masqués");
    expect(w.host.log.polls.every((p) => !p.includeBalance)).toBe(true);
  });

  it("Given the old run, Then its detail is one click away and shows the amounts with their meaning", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    await fullscreen(w);
    const body = NB(
      last(w)
        .children.map((c) => c.textContent)
        .join(" "),
    );
    expect(body).toMatch(TURNOVER);
    expect(body).toContain("Bénéfice net");
    expect(body).toContain("696 SCU");
    expect(body).toContain("durée");
  });

  it("Given the compact view, Then a calm line says the last run is outside the session, with no amount", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    const l = line(w)!;
    expect(l).toBeDefined();
    expect(NB(l.textContent)).toMatch(
      /^Hors session · dernier trajet connu : .+, (aujourd’hui|hier|\d+ \S+) \d{2}:\d{2}$/,
    );
    expect(l.attrs["data-past"]).toBe("1");
    expect(NB(l.textContent)).not.toMatch(/aUEC|\d{3} \d{3}/);
    expect(NB(l.textContent)).not.toContain("Trajet en cours");
  });

  it("Given a trip of the session itself, Then the compact line is the trip's, not the old one's", async () => {
    const w = await page(0);
    await w.advance(215 * SECOND);
    const l = line(w)!;
    expect(NB(l.textContent)).toContain("Dernier trajet");
    expect(NB(l.textContent)).not.toContain("Hors session");
    expect(l.attrs["data-past"]).toBe("0");
  });

  it("Given two older runs, Then the newest is the folded block and the other stays reachable in the history, dated", async () => {
    const w = await page(400, { variant: "second" });
    await w.advance(450 * SECOND);
    await fullscreen(w);
    const sum = NB(findAll(last(w), (n) => n.tag === "summary")[0]!.textContent);
    expect(sum).toContain("hors session");
    const items = findAll(w.root, (n) => cls(n, "tr-history-item") && isShown(n));
    expect(items).toHaveLength(1);
    expect(NB(items[0]!.textContent)).toMatch(
      /hors session, (aujourd’hui|hier|\d+ \S+) \d{2}:\d{2}/,
    );
  });

  it("Given a purchase made just before the session began, Then the trip under way is still the session's", async () => {
    // The session starts at 100 s, in the middle of the run (bought at 20 s, sold at 200 s): its last transaction is after.
    const w = await page(100);
    await w.advance(215 * SECOND);
    await fullscreen(w);
    expect(isShown(last(w))).toBe(false);
    expect(holders(w, TURNOVER).filter(isShown).length).toBeGreaterThan(0);
  });

  it("Given no session yet, Then every run of the journal is outside it", async () => {
    const w = await page("empty");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    expect(isShown(last(w))).toBe(true);
    expect(holders(w, TURNOVER).every(apart)).toBe(true);
  });

  it("Given sessions are off, Then a recent run is still shown as before", async () => {
    const w = await page("off");
    await w.advance(215 * SECOND);
    await fullscreen(w);
    expect(isShown(last(w))).toBe(false);
    expect(text(w)).toContain("Trajet terminé");
  });

  it("Given the old run, Then the net taken apart change by change is not drawn for it", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    await fullscreen(w);
    expect(text(w)).not.toContain("Détail");
  });

  it("Given a click on 'Afficher/Masquer le solde' with the old run, Then the amounts follow the choice", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(holders(w, TURNOVER)).toHaveLength(0);
  });
});
