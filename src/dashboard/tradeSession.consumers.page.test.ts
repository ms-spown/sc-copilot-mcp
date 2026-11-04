/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { findAll, findButton, isShown, startPage, visibleText } from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { sessionBar } from "./testing/sessionScenario.js";
import { specsSamples } from "./testing/specsFixtures.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * The other readers of the journal's newest run (the "Debrief" button, "Et ensuite ?", the pre-flight and loss boxes) speak of
 * the play session's runs only, like the card. The synthetic journal: a run bought at 20 s and sold at 202 s of the story. The
 * play session begins at a chosen second; a run before it is "of an older session".
 */

const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  scu: 696,
  expected_profit_auec: 180_000,
};

async function page(sessionStartS: number) {
  const scenario = new Scenario();
  scenario.specs = specsSamples(scenario.now).ready;
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) => tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
  const w = await startPage({ scenario, balanceHidden: false });
  w.host.overrides.poll = (base: any, include: boolean) => {
    const bar: any = sessionBar(scenario.now, include, "story");
    bar.current.started_at = new Date(scenario.epoch + sessionStartS * SECOND).toISOString();
    bar.current.ended_at = null;
    return { ...base, sessions: bar };
  };
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
  });
  return w;
}

const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(20 * SECOND);
};
const askKind = (w: PageWorld) =>
  findAll(w.root, (n) => n.tag === "button" && n.attrs["data-ask"] !== undefined)[0]!.attrs[
    "data-ask"
  ];
const searches = (w: PageWorld) => w.host.log.suggests.filter((a) => a.action === "search");

describe("Feature: the Debrief button follows the session's runs", () => {
  it("Given a run that ended 4 minutes ago in this session, Then the button offers the debrief", async () => {
    const w = await page(0);
    await w.advance(450 * SECOND);
    expect(askKind(w)).toBe("debrief");
  });

  it("Given the same run but a session that began after it, Then the button is the plain analysis", async () => {
    const w = await page(300);
    await w.advance(450 * SECOND);
    expect(askKind(w)).toBe("analyse");
  });
});

describe("Feature: 'Et ensuite ?' is seeded by a run of the session only", () => {
  it("Given a run of this session, Then one suggestion is asked from the plan's terminal (control)", async () => {
    const w = await page(0);
    await fullscreen(w);
    await w.advance(215 * SECOND);
    expect(searches(w)).toHaveLength(1);
    expect(NB(visibleText(w.root))).toContain("Et ensuite ?");
  });

  it("Given the run belongs to an older session, Then nothing is asked and no 'Et ensuite ?' is shown", async () => {
    const w = await page(210);
    await fullscreen(w);
    await w.advance(215 * SECOND);
    expect(searches(w)).toEqual([]);
    expect(NB(visibleText(w.root))).not.toContain("Et ensuite ?");
  });
});

describe("Feature: the page has exactly one balance control", () => {
  it.each([
    ["compact", false],
    ["full screen", true],
  ])(
    "Given the %s view, Then a single 'Masquer le solde' exists, and a single 'Afficher le solde' once hidden",
    async (_l, full) => {
      const w = await page(0);
      if (full) await fullscreen(w);
      await w.advance(5 * SECOND);
      const count = (label: string) =>
        findAll(w.root, (n) => n.tag === "button" && n.textContent === label).length;
      expect(count("Masquer le solde")).toBe(1);
      expect(count("Afficher le solde")).toBe(0);
      findButton(w.root, "Masquer le solde").click();
      await w.advance(3 * SECOND);
      expect(count("Afficher le solde")).toBe(1);
      expect(count("Masquer le solde")).toBe(0);
      expect(
        findAll(w.root, (n) => n.tag === "button" && /le solde$/.test(n.textContent)).length,
      ).toBe(1);
      // and the one that exists is on screen, in the header
      const b = findButton(w.root, "Afficher le solde");
      expect(isShown(b)).toBe(true);
      expect(w.root.children[0]!.className).toBe("top");
      expect(findAll(w.root.children[0]!, (n) => n === b)).toHaveLength(1);
    },
  );
});

/** A page like `page`, with a loss and/or a refused price added to the journal's section, and no wiki sheet for the ship. */
async function pageWith(
  sessionStartS: number,
  extra: (l: any, at: number) => void,
  options: { specs?: boolean } = {},
) {
  const scenario = new Scenario();
  if (options.specs !== false) scenario.specs = specsSamples(scenario.now).ready;
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) => {
    const l: any = tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    extra(l, scenario.epoch + 410 * SECOND);
    return l;
  };
  const w = await startPage({ scenario, balanceHidden: false });
  w.host.overrides.poll = (base: any, include: boolean) => {
    const bar: any = sessionBar(scenario.now, include, "story");
    bar.current.started_at = new Date(scenario.epoch + sessionStartS * SECOND).toISOString();
    bar.current.ended_at = null;
    return { ...base, sessions: bar };
  };
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
  });
  return w;
}
const verdictText = (w: PageWorld) =>
  NB(findAll(w.root, (n) => n.className === "verdict")[0]!.textContent);

describe("Feature: the action bar's hold list still reads the whole journal", () => {
  it.each([
    ["a session that began before the run", 0],
    ["a session that began after the run", 300],
  ])(
    "Given %s and no wiki sheet, Then the run's 696 SCU is still the default hold",
    async (_l, start) => {
      const w = await pageWith(start, () => undefined, { specs: false });
      await fullscreen(w);
      await w.advance(240 * SECOND);
      expect(NB(visibleText(w.root))).toContain("696");
      findButton(w.root, "Plus rentable").click();
      await w.advance(100);
      expect(w.host.log.suggests.filter((a) => a.action === "search")[0]!.cargo_scu).toBe(696);
    },
  );
});

describe("Feature: a loss or a refused price is shown even when the run is of an older session", () => {
  it("Given a ship lost 30 s ago with the cargo of the older run, Then the gravest alert is still there and the button asks about the loss", async () => {
    const w = await pageWith(300, (l, at) => {
      l.trade.ship_losses = [
        {
          at: new Date(at - 30 * SECOND).toISOString(),
          ship_class: "MISC_Hull_C",
          cause: "combat",
          causer: "other",
          zone: "OOC_Stanton_3a_Lyria",
          cargo_scu: 56,
          cargo_buys: 1,
          unconfirmed_buys: 0,
          unconfirmed_sells: 0,
          run_id: l.trade.runs[0].id,
        },
      ];
    });
    await w.advance(410 * SECOND);
    expect(verdictText(w)).toMatch(/^Vaisseau détruit/);
    expect(askKind(w)).toBe("loss");
    // the older run itself is still kept apart from the session's figures
    await fullscreen(w);
    expect(isShown(findAll(w.root, (n) => n.className.split(" ").includes("tr-last"))[0]!)).toBe(
      true,
    );
  });

  it("Given a price refused 20 s ago, Then the alert is shown too, with a session that has no run of its own", async () => {
    const w = await pageWith(300, (l, at) => {
      l.trade.price_refusals = [
        {
          at: new Date(at - 20 * SECOND).toISOString(),
          side: "buy",
          kind: "commodity",
          confidence: "confirmed",
          superseded: false,
        },
      ];
    });
    await w.advance(410 * SECOND);
    expect(verdictText(w)).toMatch(/^Prix changé : achat refusé/);
    expect(askKind(w)).toBe("refusal");
  });
});
