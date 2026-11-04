/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { LEDGER_VIEW_FUNCTIONS, ledgerChannelClean, ledgerStripBalance } from "./ledgerPanel.js";
import { LedgerService, ledgerLogFrom } from "./ledgerService.js";
import { MOVEMENTS_VIEW_FUNCTIONS } from "./movementsPanel.js";
import { dashboardHtml, viewScript } from "./page.js";
import { hashText } from "./poll.js";
import {
  FakeBus,
  VirtualClock,
  extractElement,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
} from "./testing/pageHarness.js";
import type { PageWorld } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { buildLedgerPayload, EMPTY_LEDGER } from "./ledger.js";
import {
  doubtfulFeeLedger,
  movementBalanceAt,
  movementsLedger,
  movementsStory,
} from "./testing/movementsScenario.js";
import { VIEW_FUNCTIONS } from "./viewLogic.js";
import * as VL from "./viewLogic.js";

/**
 * Where the money went, inside the poll and the page: nothing without the balance, nothing on the channel between
 * Views, nothing in the model-visible text, and a block that only draws what the server labelled. The amounts of the
 * made-up story are distinctive on purpose: 85 000 (probable reward), 6 300 (not explained), 9 000 (probable insurance),
 * 2 400 (an item).
 */

const SECOND = 1000;
const EPOCH = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW = EPOCH + 400_000;
const NBSP_FREE = (s: string) =>
  s.replace(new RegExp("[" + String.fromCharCode(160, 0x202f) + "]", "g"), " ");
const CHANNEL = VL.viewConfig().channelName;
/** The made-up amounts as the page writes them (thin space) or raw. */
const MOVED = /(?<![\d.])(85\D?000|6\D?300|9\D?000|2\D?400|210\D?300)(?!\d)/;
const RAW_MOVED = /(?<![\d.])(85000|6300|9000|2400|210300)(?!\d)/;
const FIELDS = /"movements"|"decomposition"|probable_contract_reward|unexplained_split/;
const PLAN = {
  commodity: "Laranite",
  scu: 696,
  expected_profit_auec: 180_000,
  sell_unit_price: 457,
};

const full: Record<string, any> = Object.fromEntries(
  [...VIEW_FUNCTIONS, ...LEDGER_VIEW_FUNCTIONS, ...MOVEMENTS_VIEW_FUNCTIONS].map((f) => [
    f.name,
    f,
  ]),
);

async function page(clock?: VirtualClock, bus?: FakeBus) {
  const scenario = new Scenario();
  scenario.uec = movementBalanceAt;
  scenario.ledger = (include, nowMs) => movementsLedger(nowMs, scenario.epoch, include, PLAN);
  const w = await startPage({ scenario, ...(clock ? { clock } : {}), ...(bus ? { bus } : {}) });
  return { w, scenario };
}
const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(100);
};
const card = (w: PageWorld) =>
  NBSP_FREE(visibleText(findAll(w.root, (n) => n.className === "card trade")[0]!));
const block = (w: PageWorld) => findAll(w.root, (n) => n.className === "mv")[0]!;

describe("Feature: the server builds nothing about the movements without the balance", () => {
  it("Given the poll without the balance, Then there is no movement, no decomposition and no amount, not even a count", () => {
    const payload = movementsLedger(NOW, EPOCH, false, PLAN);
    const wire = JSON.stringify(payload);
    expect(payload).not.toHaveProperty("movements");
    expect(wire).not.toMatch(FIELDS);
    expect(wire).not.toMatch(RAW_MOVED);
    expect(payload.trade!.runs[0]).not.toHaveProperty("money");
  });

  it("Given the balance asked, Then the section and the run's decomposition exist, with a hash of their own", () => {
    const withBalance = movementsLedger(NOW, EPOCH, true, PLAN);
    const without = movementsLedger(NOW, EPOCH, false, PLAN);
    // The login is before the first balance the server saw: the window starts at that balance.
    expect(withBalance.movements).toMatchObject({ v: 1, window: { basis: "history" } });
    expect(withBalance.trade!.runs[0]!.money!.decomposition).toMatchObject({
      net: 210_300,
      closes: true,
      parts: {
        probable_rewards: 85_000,
        unexplained: -6_300,
        probable_costs: -9_000,
        items: -2_400,
      },
    });
    expect(hashText(JSON.stringify(withBalance))).not.toBe(hashText(JSON.stringify(without)));
  });

  it("Given the ledger is not readable, Then no section is built even with the balance", () => {
    const s = movementsStory(NOW, EPOCH);
    const payload = buildLedgerPayload({
      base: { ...EMPTY_LEDGER, status: "unreadable" },
      history: s.history,
      includeBalance: true,
      trades: s.transactions,
      nowMs: NOW,
    });
    expect(payload).not.toHaveProperty("movements");
  });
});

describe("Feature: the section does not change while the balance does not", () => {
  it("Given two polls a few seconds apart and no new balance change, Then the whole ledger is identical (so the delta protocol omits it)", () => {
    const a = movementsLedger(EPOCH + 300_000, EPOCH, true, PLAN);
    const b = movementsLedger(EPOCH + 303_000, EPOCH, true, PLAN);
    expect(JSON.stringify(b.movements)).toBe(JSON.stringify(a.movements));
    expect(hashText(JSON.stringify(b))).toBe(hashText(JSON.stringify(a)));
  });
});

describe("Feature: fees measured next to another possible cause are said to be doubtful", () => {
  it("Given a shop item bought inside the purchase window, Then the 2 % warning stays silent but the card says the fees may include it", async () => {
    const scenario = new Scenario();
    scenario.uec = movementBalanceAt;
    scenario.ledger = (include, nowMs) => doubtfulFeeLedger(nowMs, scenario.epoch, include, PLAN);
    const w = await startPage({ scenario });
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = card(w);
    expect(t).toMatch(/Frais\s*mesuré/);
    expect(t).toContain(
      "Attention : Les frais mesurés tombent dans une fenêtre qui contient aussi une autre cause possible",
    );
    expect(NBSP_FREE(visibleText(block(w)))).toMatch(/Frais sur l’achat\s*ambigu/);
  });
});

describe("Feature: the channel between Views never carries them", () => {
  const rich = movementsLedger(NOW, EPOCH, true, PLAN);

  it("Given a ledger with movements, Then the sender's strip and the receiver's clean drop all of it", () => {
    expect(JSON.stringify(rich)).toMatch(RAW_MOVED);
    const sent = ledgerStripBalance(rich);
    expect(JSON.stringify(sent)).not.toMatch(RAW_MOVED);
    expect(JSON.stringify(sent)).not.toMatch(FIELDS);
    expect(sent.trade.runs[0].commodity).toBe("5c2e9a41");
    const received = ledgerChannelClean(rich);
    expect(JSON.stringify(received)).not.toMatch(RAW_MOVED);
    expect(JSON.stringify(received)).not.toMatch(FIELDS);
    expect(received).not.toHaveProperty("movements");
    expect(received.trade.runs[0].money).toBeNull();
    expect(ledgerChannelClean(received)).toEqual(received);
  });

  it("Given a leader that shows the balance, Then the wire has no movement and the follower shows no block", async () => {
    const scenario = new Scenario();
    scenario.uec = movementBalanceAt;
    scenario.ledger = (include, nowMs) => movementsLedger(nowMs, scenario.epoch, include, PLAN);
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const pages: PageWorld[] = [];
    for (let i = 0; i < 2; i++) {
      pages.push(await startPage({ scenario, clock, bus }));
      await clock.advance(50);
    }
    const [follower, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(30 * SECOND);
    findButton(leader.root, "Afficher le solde").click();
    await clock.advance(190 * SECOND);
    for (const p of pages) await fullscreen(p);
    await clock.advance(2 * SECOND);
    expect(NBSP_FREE(visibleText(leader.root))).toContain("Mouvements du solde");
    const wire = JSON.stringify(bus.log);
    expect(bus.log.length).toBeGreaterThan(20);
    expect(wire).not.toMatch(RAW_MOVED);
    expect(wire).not.toMatch(FIELDS);
    expect(isShown(block(follower))).toBe(false);
    expect(NBSP_FREE(visibleText(follower.root))).not.toMatch(MOVED);
  });

  it("Given a hostile 'leader' that sends movements and a decomposition, Then they are dropped on reception", async () => {
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
    expect(isShown(block(w))).toBe(false);
    expect(NBSP_FREE(visibleText(w.root))).not.toMatch(MOVED);
  });
});

describe("Feature: the block in the card's details", () => {
  it("Given the balance hidden, Then the block is not drawn and no amount of the movements is in the page", async () => {
    const { w } = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    expect(isShown(block(w))).toBe(false);
    expect(NBSP_FREE(visibleText(w.root))).not.toMatch(MOVED);
    expect(JSON.stringify(w.host.log.received)).not.toMatch(RAW_MOVED);
  });

  it("Given the balance shown, Then the block lists each movement with its label and confidence, and names no cause for the unexplained one", async () => {
    const { w } = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(isShown(block(w))).toBe(true);
    const t = NBSP_FREE(visibleText(block(w)));
    expect(t).toContain("Mouvements du solde");
    expect(t).toMatch(/Achat de marchandise\s*rapproché du journal\s*−131 504 aUEC/);
    expect(t).toMatch(/Frais sur l’achat\s*mesuré\s*−19 468 aUEC/);
    expect(t).toMatch(/Achat d’objet\s*rapproché du journal\s*−2 400 aUEC/);
    expect(t).toContain("ration_pack_test");
    expect(t).toMatch(/Récompense de contrat\s*probable\s*\+85 000 aUEC/);
    expect(t).toContain("montant lu sur le solde : le journal n’a pas de ligne de récompense");
    expect(t).toMatch(/Assurance\s*probable\s*−9 000 aUEC/);
    expect(t).toMatch(/Non expliqué\s*sans cause connue\s*−6 300 aUEC/);
    expect(t).toContain(
      "carburant, réparation, amende, virement ou récompense ? le journal ne le dit pas",
    );
    // The unexplained row never says "refuel" or "repair" as a fact.
    expect(t).not.toMatch(/Plein|Réparation\s*(probable|mesuré)/);
  });

  it("Given the card's warning, Then the unexplained part of the net is decomposed", async () => {
    const { w } = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const warn = card(w);
    expect(warn).toMatch(/Attention : Variation du solde \+210 300 aUEC = marge brute \+186 568/);
    expect(warn).toContain("frais −43 568 (mesurés)");
    expect(warn).toContain("objets achetés −2 400");
    expect(warn).toContain("récompenses probables de contrat +85 000");
    expect(warn).toContain("non expliqué −6 300");
  });

  it("Given a filter, Then only the matching movements stay, and the run toggle narrows to the run", async () => {
    const { w } = await page();
    await w.advance(215 * SECOND);
    await fullscreen(w);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(block(w), "Non expliqués").click();
    const t = NBSP_FREE(visibleText(findAll(block(w), (n) => n.className === "mv-list")[0]!));
    expect(t).toContain("−6 300 aUEC");
    expect(t).not.toContain("Récompense de contrat");
    expect(t).not.toContain("Achat de marchandise");
    findButton(block(w), "Probables").click();
    const p = NBSP_FREE(visibleText(findAll(block(w), (n) => n.className === "mv-list")[0]!));
    expect(p).toContain("Récompense de contrat");
    expect(p).not.toContain("−6 300");
    findButton(block(w), "Ce trajet seulement").click();
    expect(
      NBSP_FREE(visibleText(findAll(block(w), (n) => n.className === "mv-list")[0]!)),
    ).toContain("Récompense de contrat");
  });

  it("Given the balance shown, Then ui/update-model-context and the fixed messages carry none of it", async () => {
    const { w } = await page();
    await w.advance(100 * SECOND);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(120 * SECOND);
    await fullscreen(w);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(MOVED);
    findButton(w.root, "Analyser ma situation").click();
    await w.advance(100);
    for (const m of w.host.log.messages) expect(NBSP_FREE(m)).not.toMatch(MOVED);
  });
});

describe("Feature: the page rebuilds what it is given, field by field", () => {
  const hostile = {
    v: 1,
    window: { from: "2026-11-03T18:00:00.000Z", to: "not a date", basis: "x" },
    total_auec: "evil",
    count: 1e9,
    totals: {
      unexplained: { count: 3, auec: -5 },
      __proto__: { x: 1 },
      rogue: { count: 1, auec: 1 },
    },
    unexplained_split: null,
    coverage: { changes: "a", starts_before_history: "true" },
    listed: [
      ...Array.from({ length: 400 }, (_, i) => ({
        at: "2026-11-03T18:00:00.000Z",
        amount: i,
        category: i % 2 ? "unexplained" : "made_up_cause",
        confidence: "certain",
        ref: String.fromCharCode(0x202e) + "evil" + String.fromCharCode(0x200b) + "x".repeat(500),
        hints: ["fine", "stream_gap", "<script>"],
      })),
      { at: "garbage", amount: 5 },
      { at: "2026-11-03T18:00:00.000Z", amount: Infinity },
      null,
      7,
    ],
    explanation: Array.from({ length: 50 }, () => "y".repeat(5000)),
  };

  it("Given hostile input, Then lists are capped, enums fall back, text is cleaned and bad entries vanish", () => {
    const n = full.movementsNormalize!(full, hostile);
    expect(n.listed.length).toBeLessThanOrEqual(40);
    expect(
      n.listed.every(
        (m: any) =>
          m.ref.length <= 60 &&
          !new RegExp("[" + String.fromCharCode(0x202e, 0x200b) + "]").test(m.ref),
      ),
    ).toBe(true);
    expect(
      n.listed.every((m: any) =>
        [
          "unexplained",
          "explained_by_transaction",
          "fee_on_transaction",
          "item_purchase",
          "probable_contract_reward",
          "probable_insurance_or_hangar_cost",
        ].includes(m.category),
      ),
    ).toBe(true);
    expect(n.listed.every((m: any) => m.confidence === "none")).toBe(true);
    expect(n.listed.every((m: any) => m.hints.every((h: string) => h === "stream_gap"))).toBe(true);
    expect(n.explanation.length).toBeLessThanOrEqual(8);
    expect(n.explanation.every((s: string) => s.length <= 600)).toBe(true);
    expect(n.totals).not.toHaveProperty("rogue");
    expect(n.total_auec).toBe(0);
    expect(n.window.to).toBeNull();
    expect(full.movementsNormalize!(full, { v: 2 })).toBeNull();
    expect(full.movementsNormalize!(full, null)).toBeNull();
    expect(full.movementsNormalize!(full, "x")).toBeNull();
  });

  it("Given a decomposition without a net, Then it is refused; with one, unknown fields are dropped", () => {
    expect(full.movementsDecompositionNormalize!(full, { parts: {} })).toBeNull();
    const d = full.movementsDecompositionNormalize!(full, {
      net: 5,
      secret: "x",
      parts: { fees: -3, rogue: 1 },
      named: [
        { at: "2026-11-03T18:00:00.000Z", amount: -2, reason: "weird" },
        { at: "bad", amount: 1 },
      ],
    });
    expect(d).not.toHaveProperty("secret");
    expect(d.parts).not.toHaveProperty("rogue");
    expect(d.named).toEqual([{ at: "2026-11-03T18:00:00.000Z", amount: -2, reason: "no_cause" }]);
  });

  it("Given the shipped page, Then the block's functions are serialised once each and its styles use no image or address", () => {
    const names = [...VIEW_FUNCTIONS, ...LEDGER_VIEW_FUNCTIONS, ...MOVEMENTS_VIEW_FUNCTIONS].map(
      (f) => f.name,
    );
    expect(new Set(names).size).toBe(names.length);
    const script = viewScript();
    for (const f of MOVEMENTS_VIEW_FUNCTIONS) expect(script).toContain(`function ${f.name}(`);
    expect(script).not.toMatch(/__vi_|_import_/);
    const style = extractElement(dashboardHtml(), "style")!;
    expect(style).toContain(".mv-row");
    expect(style).not.toMatch(/url\(|@import|https?:/);
  });
});

describe("Feature: the ledger service keeps the events the explainer needs", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-movements-"));
    file = path.join(dir, "Game.log");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const at = (s: number) => `<${new Date(EPOCH + s * 1000).toISOString()}>`;

  it("Given a log with a login, an insurance claim and a hangar request, Then they are kept with their time only, apart from the ledger's own events", async () => {
    fs.writeFileSync(
      file,
      [
        `${at(0)} Log started on Tue Nov  3 18:00:00 2026`,
        `${at(1)} <LoginCompleted> Login completed for the made-up player`,
        `${at(60)} <CWallet::ProcessClaimToNextStep> New Insurance Claim Request - made up`,
        `${at(61)} <CWallet::ProcessClaimToNextStep> New Insurance Claim Request - made up`,
        `${at(120)}  "Hangar Request Completed: made up" [1]`,
        `${at(130)} [Info] filler line`,
      ].join("\n") + "\n",
    );
    const d = new Date(Date.UTC(2026, 10, 3, 19, 0, 0));
    fs.utimesSync(file, d, d);
    const clock = { now: 0 };
    const service = new LedgerService(
      ledgerLogFrom(new GameLog({ logPath: file })),
      () => clock.now,
    );
    expect(service.movementEvents()).toEqual([]); // not read yet
    clock.now += 5000;
    service.state();
    await service.settled();
    const events = service.movementEvents();
    expect(events.map((e) => [e.type, (e.atMs - EPOCH) / 1000])).toEqual([
      ["login_completed", 1],
      ["insurance_claim_requested", 60],
      ["insurance_claim_requested", 61],
      ["hangar_request_completed", 120],
    ]);
    expect(Object.keys(events[0]!).sort()).toEqual(["atMs", "type"]);
    // The ledger's own list is untouched by them.
    expect(service.eventCount).toBe(0);
    // Reading again does not duplicate them.
    fs.appendFileSync(file, `${at(140)} [Info] more filler\n`);
    const d2 = new Date(Date.UTC(2026, 10, 3, 19, 0, 5));
    fs.utimesSync(file, d2, d2);
    clock.now += 5000;
    service.state();
    await service.settled();
    expect(service.movementEvents()).toHaveLength(4);
  });

  it("Given no configured log, Then there are no events", () => {
    const service = new LedgerService(undefined);
    expect(service.movementEvents()).toEqual([]);
  });
});
