/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { figure } from "../testing/replay/audit.js";
import {
  layoutConfig,
  layoutContext,
  layoutHolds,
  layoutLabel,
  layoutNextPref,
  layoutPlace,
  layoutWant,
} from "./layoutOrder.js";
import {
  FakeNode,
  findAll,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { pageCss } from "./page.js";
import { Scenario } from "./testing/scenario.js";
import { sessionBar } from "./testing/sessionScenario.js";
import { TRADE_FIGURES, tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";
import { shipContext, modeInfo } from "./viewLogic.js";

/**
 * Feature: the order of the sections in full screen follows what the data already say (layoutOrder.ts): flying puts the
 * verdict, the alerts, the ship, the line of the trip under way and the instruments first; landed, on foot or an unknown
 * situation keep the order the page always had. Only the placement and the fold change, never a section's content.
 */

const SECOND = 1000;
/** The page writes 184 500 with a (narrow) no-break space (a whitespace for the regular expression): amounts are joined before a figure is looked for. */
const flat = (s: string): string => s.replace(/(?<=[0-9])\s(?=[0-9])/g, ""); // \s covers both no-break spaces
const L: any = { shipContext, modeInfo };
const ONLINE = { state: "online", since: "2026-11-04T10:00:00Z", code: null, reason: null };
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

// ---------------------------------------------------------------------------------------------- the rules, pure
describe("Feature: what counts as flight, station or unknown", () => {
  const live = (patch: any) => ({
    state: "live",
    connection: ONLINE,
    ship: { name: "DRAK_Cutter_1", landed: false, gear: "retracted" },
    pilot: { locomotion: "seated" },
    derived: {},
    conditions: [],
    ...patch,
  });
  const id = (poll: any, grey = false) => layoutContext(L, poll, grey).id;

  it("Given a ship that is not landed (in the air, in quantum mode, in a jump), Then it is flight", () => {
    expect(id(live({}))).toBe("flight");
    expect(id(live({ derived: { in_planet_frame: true } }))).toBe("flight");
    expect(id(live({ derived: { in_quantum_mode: true } }))).toBe("flight");
    expect(id(live({ derived: { in_jump: true } }))).toBe("flight");
    // the gear is not read: gear out is not "about to land", it is still flight
    expect(id(live({ ship: { name: "DRAK_Cutter_1", landed: false, gear: "deployed" } }))).toBe(
      "flight",
    );
  });

  it("Given a ship on the ground, on foot, in EVA or a ground vehicle, Then it is station", () => {
    expect(id(live({ ship: { name: "DRAK_Cutter_1", landed: true } }))).toBe("station");
    expect(id(live({ ship: null, pilot: { locomotion: "on_foot" } }))).toBe("station");
    expect(id(live({ ship: null, pilot: { locomotion: "eva" } }))).toBe("station");
    expect(id(live({ ship: null, derived: { ground_vehicle: "ARGO_ATLS" } }))).toBe("station");
  });

  it("Given anything the data do not settle, Then it is unknown and nothing is deduced", () => {
    expect(id(null)).toBe("unknown");
    expect(id(live({}), true)).toBe("unknown");
    expect(id(live({ state: "off" }))).toBe("unknown");
    expect(id(live({ connection: { ...ONLINE, state: "menu" } }))).toBe("unknown");
    expect(id(live({ connection: { ...ONLINE, state: "disconnected" } }))).toBe("unknown");
    expect(id(live({ connection: { ...ONLINE, state: "closed" } }))).toBe("unknown");
    // a ship whose landed state is not reported, a powered-off ship, a seat without a ship
    expect(id(live({ ship: { name: "DRAK_Cutter_1" } }))).toBe("unknown");
    expect(id(live({ conditions: [{ id: "powerplant_off" }] }))).toBe("unknown");
    expect(id(live({ ship: null, pilot: { locomotion: "seated" } }))).toBe("unknown");
    // a ship section while the pilot is on foot: the data contradict each other
    expect(id(live({ pilot: { locomotion: "on_foot" } }))).toBe("unknown");
  });

  it("Given an unknown, Then it says why: only a grey or absent stream is 'flux', which the page does not follow", () => {
    const why = (poll: any, grey = false) => layoutContext(L, poll, grey).why;
    expect(why(null)).toBe("flux");
    expect(why(live({}), true)).toBe("flux");
    expect(why(live({ state: "off" }))).toBe("flux");
    // Game.log wins over the frames: a menu is a real change even when the values are grey
    expect(why(live({ connection: { ...ONLINE, state: "menu" } }), true)).toBe("connexion");
    expect(why(live({ pilot: { locomotion: "on_foot" } }))).toBe("incohérent");
    expect(why(live({ ship: { name: "DRAK_Cutter_1" } }))).toBe("vaisseau");
  });

  it("Given the player's choice, Then it wins over the situation, and auto follows it", () => {
    expect(layoutWant("auto", "flight")).toBe("flight");
    expect(layoutWant("auto", "station")).toBe("station");
    expect(layoutWant("auto", "unknown")).toBe("station");
    expect(layoutWant("station", "flight")).toBe("station");
    expect(layoutWant("flight", "unknown")).toBe("flight");
    expect(layoutNextPref("auto")).toBe("station");
    expect(layoutNextPref("station")).toBe("flight");
    expect(layoutNextPref("flight")).toBe("auto");
    expect(layoutConfig().stableMs).toBe(3000);
  });

  it("Given each state, Then the button says exactly what it does, and says when the context is unknown", () => {
    expect(layoutLabel("auto", "flight", "flight")).toBe("Ordre : auto · vol");
    expect(layoutLabel("auto", "station", "station")).toBe("Ordre : auto · commerce");
    expect(layoutLabel("auto", "unknown", "")).toBe(
      "Ordre : auto · contexte inconnu, ordre commerce",
    );
    // the situation went unknown for a moment while the flight order still holds: the words follow what is on screen
    expect(layoutLabel("auto", "unknown", "flight")).toBe("Ordre : auto · vol");
    expect(layoutLabel("station", "flight", "station")).toBe("Ordre : commerce (forcé)");
    expect(layoutLabel("flight", "station", "flight")).toBe("Ordre : vol (forcé)");
  });
});

describe("Feature: moving sections never takes the focus away", () => {
  const family = () => {
    const parent = new FakeNode("div");
    const [a, b, c] = ["a", "b", "c"].map((t) => new FakeNode(t));
    for (const n of [a!, b!, c!]) parent.appendChild(n);
    const inner = new FakeNode("button");
    b!.appendChild(inner);
    return { parent, a: a!, b: b!, c: c!, inner };
  };

  it("Given the fake DOM, Then a node has one parent (adding it elsewhere takes it from where it was)", () => {
    const { parent, a, b } = family();
    const other = new FakeNode("div");
    other.appendChild(a);
    expect(parent.children).toHaveLength(2);
    expect(a.parentNode).toBe(other);
    parent.insertBefore(a, b);
    expect(parent.children.map((n) => n.tag)).toEqual(["a", "b", "c"]);
    expect(other.children).toHaveLength(0);
  });

  it("Given no focus, Then the children take the wanted order, moving only what must move", () => {
    const { parent, a, b, c } = family();
    expect(layoutPlace([[parent, [c, a, b]]], null)).toBe(true);
    expect(parent.children).toEqual([c, a, b]);
    const writes = FakeNode.writes;
    expect(layoutPlace([[parent, [c, a, b]]], null)).toBe(true);
    expect(FakeNode.writes).toBe(writes);
  });

  it("Given the focus inside a node that would move, Then nothing moves", () => {
    const { parent, a, b, c, inner } = family();
    expect(layoutHolds(b, inner)).toBe(true);
    expect(layoutHolds(a, inner)).toBe(false);
    expect(layoutPlace([[parent, [c, a, b]]], inner)).toBe(true); // only c moves: the focus in b is safe
    expect(parent.children).toEqual([c, a, b]);
    expect(layoutPlace([[parent, [b, c, a]]], inner)).toBe(false); // b would move
    expect(parent.children).toEqual([c, a, b]);
  });

  it("Given a node wanted in another parent, Then it is taken from where it was", () => {
    const { parent, a, b, c } = family();
    const grid = new FakeNode("div");
    expect(
      layoutPlace(
        [
          [grid, [a]],
          [parent, [b, c]],
        ],
        null,
      ),
    ).toBe(true);
    expect(grid.children).toEqual([a]);
    expect(parent.children).toEqual([b, c]);
  });
});

// ---------------------------------------------------------------------------------------------- the page
const flightPoll = (over: any = {}, ship: any = {}) => ({
  connection: ONLINE,
  ship: { name: "DRAK_Cutter_1", landed: false, gear: "retracted", ...ship },
  pilot: { locomotion: "seated", seat: "seat_pilot" },
  derived: {},
  conditions: [],
  ...over,
});

/** The fake host answers the poll the test builds, over the sections it names. */
function answer(w: PageWorld, patch: any | (() => any)) {
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    unchanged: undefined,
    state: "live",
    frame_age_ms: 100,
    weapons: null,
    sessions: sessionBar(w.scenario.now, include, "story"),
    ...(typeof patch === "function" ? patch() : patch),
  });
}

async function fullscreenPage(
  options: { scenario?: Scenario; storage?: Map<string, string> } = {},
) {
  const w = await startPage({
    scenario: options.scenario ?? new Scenario(),
    ...(options.storage ? { storage: options.storage } : {}),
  });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  // The first polls come after a few seconds. Until the test says otherwise the situation is the unknown one (a ship whose
  // landed state is not reported), so that the first situation a test states is the first known one.
  answer(w, flightPoll({}, { landed: undefined }));
  await w.advance(8 * SECOND);
  return w;
}

const orderOf = (w: PageWorld) => w.root.attrs["data-order"] ?? "";
const button = (w: PageWorld, startsWith: string): FakeNode =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent.startsWith(startsWith))[0]!;
const orderButton = (w: PageWorld) => button(w, "Ordre :");
/** The identity of a section, by its class, for the order checks. */
const kind = (n: FakeNode) => n.className.split(" ")[0] || n.tag;
const rootOrder = (w: PageWorld) => w.root.children.map(kind);
/** Where the trip line of the commerce card stands among the children of the root. */
const tripPos = (w: PageWorld) =>
  w.root.children.findIndex((c) => c.className.split(" ").includes("tr-line"));
const SHORTCUT_FOLD = "Voir les";
const fullOrder = (w: PageWorld) =>
  findAll(w.root, (n) => n.className === "full")[0]!.children.map(kind);

describe("Feature: full screen in flight puts the instruments right after the banner", () => {
  it("Given a ship in the air as soon as the page opens, Then the flight order is applied at once, and the button says so", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(orderButton(w).textContent).toBe("Ordre : auto · vol");
    // root: the verdict and alerts first, then the banner, the trip line, and the grid; the shortcuts and the session left it
    const root = rootOrder(w);
    expect(root.indexOf("alerts")).toBeLessThan(root.indexOf("ctx"));
    expect(root.indexOf("ctx")).toBeLessThan(tripPos(w));
    expect(tripPos(w)).toBeLessThan(root.indexOf("full"));
    expect(root).not.toContain("sc");
    expect(root).not.toContain("ses");
    expect(fullOrder(w)).toEqual([
      "off-note",
      "col",
      "col",
      "col",
      "sc",
      "trbox",
      "ses",
      "hl",
      "wide",
    ]);
    expect(findAll(w.root, (n) => n.className === "full")[0]!.children[1]!.className).toBe(
      "col col-instr",
    );
  });

  it("Given the same sections, Then the flight order is a permutation of the default one, nothing lost or doubled", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe(""); // landed: nothing was ever applied, the page is as built
    const all = (): FakeNode[] => findAll(w.root, () => true).filter((n) => n.parentNode);
    const before = new Set(all());
    const countBefore = all().length;
    orderButton(w).click(); // commerce (forced): same order
    orderButton(w).click(); // vol (forced)
    await w.advance(100);
    expect(orderOf(w)).toBe("flight");
    expect(all().length).toBe(countBefore);
    expect(new Set(all())).toEqual(before);
    // and every node still has exactly one parent that lists it
    for (const n of all()) {
      if (n === w.root) continue;
      expect(n.parentNode!.children.filter((c) => c === n)).toHaveLength(1);
    }
  });

  it("Given the ship on the ground, on foot, or an unknown situation, Then the page keeps the order it always had", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    const station = [rootOrder(w), fullOrder(w)];
    expect(orderButton(w).textContent).toBe("Ordre : auto · commerce");
    answer(w, {
      connection: ONLINE,
      ship: null,
      pilot: { locomotion: "on_foot" },
      derived: {},
      conditions: [],
    });
    await w.advance(5 * SECOND);
    expect([rootOrder(w), fullOrder(w)]).toEqual(station);
    expect(orderButton(w).textContent).toBe("Ordre : auto · commerce");
    // unknown: a ship whose landed state is not reported
    answer(w, flightPoll({}, { landed: undefined }));
    await w.advance(5 * SECOND);
    expect([rootOrder(w), fullOrder(w)]).toEqual(station);
    expect(orderButton(w).textContent).toBe("Ordre : auto · contexte inconnu, ordre commerce");
    // the default order is the one of the page as built: sessions and shortcuts before the commerce card
    expect(rootOrder(w).indexOf("sc")).toBeLessThan(rootOrder(w).indexOf("ses"));
    expect(rootOrder(w).indexOf("ses")).toBeLessThan(rootOrder(w).indexOf("full"));
    expect(fullOrder(w).slice(0, 2)).toEqual(["off-note", "trbox"]);
  });

  it("Given the compact view, Then the order is never changed, and leaving full screen restores it", async () => {
    const w = await startPage({ scenario: new Scenario() });
    answer(w, flightPoll());
    await w.advance(5 * SECOND);
    const compact = [rootOrder(w), fullOrder(w)];
    expect(orderOf(w)).toBe("");
    expect(isShown(orderButton(w))).toBe(false);
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    await w.advance(2 * SECOND);
    expect([rootOrder(w), fullOrder(w)]).toEqual(compact);
  });
});

describe("Feature: leaving full screen always gives the compact view its sections back", () => {
  it("Given the focus in the shortcuts zone (moved by the flight order) when the host leaves full screen, Then the order is restored anyway", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    const fold = findAll(w.root, (n) => n.className.includes("sc-fold"))[0]!;
    (w.doc as any).activeElement = fold;
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    await w.advance(2 * SECOND);
    expect(rootOrder(w)).toContain("sc");
    expect(rootOrder(w)).toContain("ses");
    expect(fullOrder(w)).not.toContain("sc");
  });
});

describe("Feature: the page does not jump when `landed` flips, and follows once it has held", () => {
  it("Given landed changing every second for ten seconds, Then nothing moves; after three stable seconds, one move", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    const t0 = w.clock.now;
    answer(w, () => flightPoll({}, { landed: Math.floor((w.clock.now - t0) / SECOND) % 2 === 0 }));
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      await w.advance(500);
      seen.push(JSON.stringify([rootOrder(w), fullOrder(w)]));
    }
    expect(new Set(seen).size).toBe(1);
    expect(orderOf(w)).toBe("flight");
    // landed for good
    answer(w, flightPoll({}, { landed: true }));
    const after: string[] = [];
    for (let i = 0; i < 10; i++) {
      await w.advance(500);
      after.push(JSON.stringify([rootOrder(w), fullOrder(w)]));
    }
    const changes = after.filter((s, i) => i > 0 && s !== after[i - 1]).length;
    expect(changes).toBe(1);
    // not before three seconds: the first two seconds are still the flight order
    expect(after[0]).toBe(seen[0]);
    expect(after[3]).toBe(seen[0]);
    expect(orderOf(w)).toBe("station");
    expect(orderButton(w).textContent).toBe("Ordre : auto · commerce");
  });

  it("Given the keyboard focus inside a section that would move, Then the change waits for the focus to leave", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    const fold = findAll(w.root, (n) => n.className.includes("sc-fold"))[0]!;
    (w.doc as any).activeElement = fold;
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(8 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(fold.parentNode).not.toBeNull();
    (w.doc as any).activeElement = orderButton(w);
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("station");
  });

  it("Given the button, Then it forces an order at once, cycles auto, commerce, vol, and keeps the choice in memory only", async () => {
    const storage = new Map<string, string>();
    const w = await fullscreenPage({ storage });
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(2 * SECOND);
    const labels = [orderButton(w).textContent];
    orderButton(w).click();
    labels.push(orderButton(w).textContent);
    expect(orderOf(w)).toBe(""); // commerce: already that order
    orderButton(w).click();
    labels.push(orderButton(w).textContent);
    expect(orderOf(w)).toBe("flight"); // at once, no wait
    await w.advance(10 * SECOND);
    expect(orderOf(w)).toBe("flight"); // forced: the situation does not take it back
    orderButton(w).click();
    labels.push(orderButton(w).textContent);
    expect(labels).toEqual([
      "Ordre : auto · commerce",
      "Ordre : commerce (forcé)",
      "Ordre : vol (forcé)",
      "Ordre : auto · commerce",
    ]);
    // back to auto is the player's own action too: it applies at once, here the situation (landed) says commerce
    expect(orderOf(w)).toBe("station");
    expect(orderButton(w).attrs["type"]).toBe("button");
    expect([...storage.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- focus order
/** The controls a keyboard visits in full screen, in document order, as the player would meet them. */
function tabStops(w: PageWorld): string[] {
  const out: string[] = [];
  const visit = (n: FakeNode, inFull: boolean) => {
    if (n.attrs["data-hidden"] === "1") return;
    const cls = n.className.split(" ");
    if (cls.includes("inline") || cls.includes("balance-row") || cls.includes("toast-top")) return;
    // the style sheet hides a folded card
    if (cls.includes("trade") && n.parentNode?.attrs["data-fold"] === "1") return;
    if (n.tag === "button" || n.tag === "summary" || n.attrs["tabindex"] === "0") {
      out.push(n.attrs["aria-label"] || n.textContent);
    }
    for (const c of n.children) visit(c, inFull);
  };
  visit(w.root, true);
  return out;
}
const at = (stops: string[], startsWith: string) =>
  stops.findIndex((s) => s.startsWith(startsWith));

describe("Feature: the keyboard meets the sections in the order they are drawn", () => {
  it("Given the flight order, Then the tab order goes instruments, shortcuts, the commerce fold, the session", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    const stops = tabStops(w);
    const pin = at(stops, "Épingler : vitesse");
    const shortcuts = at(stops, SHORTCUT_FOLD);
    const fold = at(stops, "Carte Commerce");
    const session = at(stops, "Sessions");
    expect(pin).toBeGreaterThan(-1);
    expect(shortcuts).toBeGreaterThan(-1);
    expect(fold).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(shortcuts);
    expect(shortcuts).toBeLessThan(fold);
    expect(fold).toBeLessThan(session);
    // the folded card has no tab stop of its own
    expect(at(stops, "Plus rentable")).toBe(-1);
  });

  it("Given the default order, Then the tab order goes shortcuts, session, commerce, instruments", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    const stops = tabStops(w);
    const shortcuts = at(stops, "À propos des touches");
    const session = at(stops, "Sessions");
    const trade = at(stops, "Plus rentable");
    const pin = at(stops, "Épingler : vitesse");
    expect(shortcuts).toBeGreaterThan(-1);
    expect(shortcuts).toBeLessThan(session);
    expect(session).toBeLessThan(trade);
    expect(trade).toBeLessThan(pin);
    expect(at(stops, "Carte Commerce")).toBe(-1); // no fold bar outside the flight order
  });

  it("Given a change of order, Then the order button stays where it is in the header, before every section", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    const before = at(tabStops(w), "Ordre :");
    orderButton(w).click();
    orderButton(w).click();
    await w.advance(100);
    expect(orderOf(w)).toBe("flight");
    expect(at(tabStops(w), "Ordre :")).toBe(before);
    expect(at(tabStops(w), "Ordre :")).toBeLessThan(at(tabStops(w), "Épingler : vitesse"));
  });
});

// ---------------------------------------------------------------------------------------------- the fold
const trade = (w: PageWorld) => findAll(w.root, (n) => n.className === "trbox")[0]!;
const foldButton = (w: PageWorld): FakeNode =>
  findAll(w.root, (n) => n.tag === "button" && n.attrs["aria-controls"] === "trade-card")[0]!;
const foldSum = (w: PageWorld) => findAll(w.root, (n) => n.className === "tfold-sum")[0]!;

describe("Feature: the commerce card is one line, with a fold, while nothing fresh happens in it", () => {
  it("Given the flight order and no commerce event, Then the card is folded to a line and the button opens it", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    expect(trade(w).attrs["data-fold"]).toBe("1");
    expect(foldButton(w).attrs["aria-expanded"]).toBe("false");
    expect(foldButton(w).attrs["aria-controls"]).toBe("trade-card");
    // the name never changes (it would contradict aria-expanded for a screen reader): the state is aria-expanded alone
    expect(foldButton(w).attrs["aria-label"]).toBe("Carte Commerce");
    expect(foldSum(w).textContent).toBe("aucun trajet ni plan");
    foldButton(w).click();
    expect(trade(w).attrs["data-fold"]).toBe("0");
    expect(foldButton(w).attrs["aria-expanded"]).toBe("true");
    expect(foldButton(w).attrs["aria-label"]).toBe("Carte Commerce");
    // the card is the one the box holds, with the id the button controls
    expect(findAll(trade(w), (n) => n.attrs["id"] === "trade-card")).toHaveLength(1);
    foldButton(w).click();
    expect(trade(w).attrs["data-fold"]).toBe("1");
    // the player's choice is kept while the order holds
    await w.advance(5 * SECOND);
    expect(trade(w).attrs["data-fold"]).toBe("1");
  });

  it("Given the station order, Then the commerce card is as it always was: no bar, no fold", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    expect(trade(w).attrs["data-fold"]).toBe("0");
    expect(isShown(findAll(w.root, (n) => n.className === "tfold")[0]!)).toBe(false);
  });

  it("Given a run just settled, Then the card opens by itself, and the player can still fold it", async () => {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    const w = await fullscreenPage({ scenario });
    // 215 s: the run is settled (a "Debrief" is what the Ask Claude button offers): fresh
    answer(w, flightPoll());
    await w.advance(220 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(button(w, "Debrief du trajet")).toBeDefined();
    expect(trade(w).attrs["data-fold"]).toBe("0");
    foldButton(w).click();
    expect(trade(w).attrs["data-fold"]).toBe("1");
  });

  it("Given a fresh event that goes stale while the focus is inside the card, Then the rule does not fold it; once the focus leaves, it does", async () => {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    let variant: "story" | "none" = "story";
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, variant, PLAN);
    const w = await fullscreenPage({ scenario });
    answer(w, flightPoll());
    await w.advance(220 * SECOND); // the run is settled: a debrief, fresh
    expect(trade(w).attrs["data-fold"]).toBe("0");
    const card = findAll(trade(w), (n) => n.attrs["id"] === "trade-card")[0]!;
    const inside = findAll(card, (n) => n.tag === "button")[0]!;
    (w.doc as any).activeElement = inside;
    variant = "none"; // nothing fresh any more: the rule says fold
    await w.advance(5 * SECOND);
    expect(button(w, "Debrief du trajet")).toBeUndefined();
    expect(trade(w).attrs["data-fold"]).toBe("0");
    (w.doc as any).activeElement = orderButton(w);
    await w.advance(2 * SECOND);
    expect(trade(w).attrs["data-fold"]).toBe("1");
  });

  it("Given the player opened the card, Then a change of order gives the fold back to the rule", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(2 * SECOND);
    foldButton(w).click(); // open by hand
    foldButton(w).click(); // and folded again: user choice is false
    foldButton(w).click(); // open
    expect(trade(w).attrs["data-fold"]).toBe("0");
    // user choice back to the rule by a change of order (a landing then a take-off): fold is closed when the rule says so,
    // unless the focus is inside the card
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("station");
    answer(w, flightPoll());
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(trade(w).attrs["data-fold"]).toBe("1"); // the choice was reset with the change of order
  });

  it("Given the balance shown and hidden, Then the fold line carries no amount, only the stage and the route", async () => {
    const figures = [
      TRADE_FIGURES.start,
      TRADE_FIGURES.end,
      ...TRADE_FIGURES.buys,
      ...TRADE_FIGURES.sells,
      TRADE_FIGURES.buyFee,
      TRADE_FIGURES.sellFee,
      PLAN.expected_profit_auec,
    ];
    for (const shown of [true, false]) {
      const scenario = new Scenario();
      scenario.uec = tradeBalanceAt;
      scenario.ledger = (include, nowMs) =>
        tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
      const w = await fullscreenPage({ scenario });
      w.fromHost({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
      });
      const label = shown ? "Afficher le solde" : "Masquer le solde";
      const toggle = findAll(
        w.root,
        (n) => n.tag === "button" && (n.textContent === label || n.attrs["aria-label"] === label),
      )[0];
      if (toggle) toggle.click();
      answer(w, flightPoll());
      await w.advance(150 * SECOND);
      expect(orderOf(w)).toBe("flight");
      expect(trade(w).attrs["data-fold"]).toBe("1");
      const bar = findAll(w.root, (n) => n.className === "tfold")[0]!;
      const said = visibleText(bar) + "\n" + orderButton(w).textContent;
      // the stage and the route of the card, in words fixed here (not read back from the card), nothing else
      expect(foldSum(w).textContent).toBe(
        "Achat fait, rien vendu · Laranite · Port Tressler → Area18 TDD",
      );
      for (const f of figures) expect(flat(said)).not.toMatch(figure(f));
      expect(said).not.toMatch(/5c2e9a41|SCShop_/);
      // The positive control: the page prints amounts with separators, so they are joined before matching, and with the
      // balance shown the card (folded by the style sheet only) does hold the fee, with it hidden nothing of the page does.
      const everything = flat(visibleText(w.root));
      if (shown) expect(everything).toMatch(figure(TRADE_FIGURES.buyFee));
      // (the plan's own expected profit is the model's figure, not the balance's: it shows in both modes, as it always did)
      else
        for (const f of figures.filter((x) => x !== PLAN.expected_profit_auec))
          expect(everything).not.toMatch(figure(f));
    }
  });
});

describe("Feature: the line of the trip under way stands above the instruments, and says nothing the compact line does not", () => {
  const withTrip = async (shown: boolean) => {
    const scenario = new Scenario();
    scenario.uec = tradeBalanceAt;
    scenario.ledger = (include, nowMs) =>
      tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    const w = await startPage({ scenario });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
    });
    const label = shown ? "Afficher le solde" : "Masquer le solde";
    const toggle = findAll(
      w.root,
      (n) => n.tag === "button" && (n.textContent === label || n.attrs["aria-label"] === label),
    )[0];
    if (toggle) toggle.click();
    await w.advance(150 * SECOND);
    return w;
  };
  const tripLine = (w: PageWorld) =>
    findAll(w.root, (n) => n.className.split(" ").includes("tr-line") && isShown(n))[0];

  it.each([
    ["balance shown", true],
    ["balance hidden", false],
  ])(
    "Given a trip under way (%s), Then the full-screen flight order shows the compact line's text",
    async (_l, shown) => {
      const w = await withTrip(shown);
      const compact = tripLine(w)!.textContent;
      expect(compact).toContain("Trajet en cours");
      w.fromHost({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { displayMode: "fullscreen" },
      });
      await w.advance(2 * SECOND);
      expect(orderOf(w)).toBe("flight");
      const line = tripLine(w)!.textContent;
      // the whole sentence, the time since the first purchase included (both read within the same minute)
      expect(line).toBe(compact);
      expect(line).toContain("d’après ton plan : Laranite, Port Tressler → Area18 TDD");
      // right under the banner, before the grid
      const root = rootOrder(w);
      expect(root.indexOf("ctx")).toBeLessThan(tripPos(w));
      expect(tripPos(w)).toBeLessThan(root.indexOf("full"));
      for (const f of [TRADE_FIGURES.start, TRADE_FIGURES.end, PLAN.expected_profit_auec]) {
        expect(flat(line)).not.toMatch(figure(f));
      }
      // The positive control: the amounts are on the page with the balance shown (the fee of the purchase, in the card), not
      // with it hidden.
      const everything = flat(visibleText(w.root));
      if (shown) expect(everything).toMatch(figure(TRADE_FIGURES.buyFee));
      else expect(everything).not.toMatch(figure(TRADE_FIGURES.buyFee));
      // the station order has the card and no second line
      orderButton(w).click();
      await w.advance(100);
      expect(orderOf(w)).toBe("station");
      expect(tripLine(w)).toBeUndefined();
    },
  );

  it("Given no trip under way, Then the flight order shows no line", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(tripLine(w)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------- the shortcuts
describe("Feature: in flight the shortcuts are limited to what has a key or is an alert", () => {
  const zone = (w: PageWorld) => findAll(w.root, (n) => n.className === "sc")[0]!;
  const rows = (w: PageWorld) =>
    findAll(zone(w), (n) => n.className === "sc-row" && isShown(n)).map((r) =>
      visibleText(r).replace(/\n/g, " "),
    );
  const fold = (w: PageWorld) => findAll(zone(w), (n) => n.className.includes("sc-fold"))[0]!;

  it("Given a ship flying near a planet, Then only the braking key shows, the rest sits behind the fold", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({ derived: { in_planet_frame: true } }));
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(rows(w)).toEqual(["Frein spatial X défaut"]);
    expect(fold(w).textContent).toBe("Voir les 4 autres ▸");
    fold(w).click();
    expect(rows(w)).toHaveLength(5);
    fold(w).click();
    expect(rows(w)).toEqual(["Frein spatial X défaut"]);
  });

  it("Given a hostile lock, Then the countermeasures with their keys are on the front", async () => {
    const w = await fullscreenPage();
    answer(
      w,
      flightPoll({
        derived: { in_planet_frame: true },
        conditions: [{ id: "hostile_lock", level: "bad" }],
      }),
    );
    await w.advance(2 * SECOND);
    expect(rows(w)).toEqual([
      "Leurres · verrouillage hostile H défaut",
      "Brouillage · verrouillage hostile J défaut",
      "Frein spatial X défaut",
    ]);
  });

  it("Given the default order, Then the zone is what it always was (up to six reminders)", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({ derived: { in_planet_frame: true } }));
    await w.advance(2 * SECOND);
    orderButton(w).click(); // commerce
    await w.advance(100);
    expect(orderOf(w)).toBe("station");
    expect(rows(w).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------- what does not change
describe("Feature: nothing else about the page changes", () => {
  it("Given both orders, Then there are still at most three live regions, no storage is used and no section changes its words", async () => {
    const storage = new Map<string, string>();
    const w = await fullscreenPage({ storage });
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    const live = () => findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length;
    const liveFlight = live();
    const words = (order: string) => {
      const texts = new Map<string, string>();
      for (const sel of ["tr-stage", "tr-route", "ctx-title", "ses-title"]) {
        texts.set(sel, findAll(w.root, (n) => n.className === sel)[0]?.textContent ?? "");
      }
      void order;
      return texts;
    };
    const flightWords = words("flight");
    expect(orderOf(w)).toBe("flight");
    orderButton(w).click(); // commerce
    await w.advance(100);
    expect(live()).toBe(liveFlight);
    expect(live()).toBeLessThanOrEqual(3);
    expect(words("station")).toEqual(flightWords);
    expect([...storage.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- audit corrections
describe("Feature: the grey of a cut stream is the same in both orders (the planner keeps its colours)", () => {
  /** The classes the `[data-grey="1"] .full > ...` rule leaves alone, read from the style sheet (the fake DOM has no style). */
  const exempt = (): string[] => {
    const rule = /\[data-grey="1"\] \.full > ((?::not\(\.[a-z-]+\))+) \{ opacity: 0\.5/.exec(
      pageCss(),
    );
    expect(rule).not.toBeNull();
    return [...rule![1]!.matchAll(/:not\(\.([a-z-]+)\)/g)].map((m) => m[1]!);
  };

  it("Given the style sheet, Then the commerce box, the shortcuts, the session and the health strip are not greyed by the grid rule", () => {
    expect(exempt().sort()).toEqual(["hl", "sc", "ses", "trbox"]);
    // the card itself keeps its own rules: coloured as a whole, only what is not the action bar is greyed
    expect(pageCss()).toContain('[data-grey="1"] .trade { opacity: 1; filter: none; }');
    expect(pageCss()).toContain(
      '[data-grey="1"] .trade > :not(.tr-actions-slot) { opacity: 0.5; filter: grayscale(1); }',
    );
  });

  it("Given each order, Then the same children of the grid are the greyed ones", async () => {
    const w = await fullscreenPage();
    const greyed = (): string[] =>
      findAll(w.root, (n) => n.className === "full")[0]!
        .children.filter((c) => !exempt().some((k) => c.className.split(" ").includes(k)))
        .map(kind)
        .sort();
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    const station = greyed();
    answer(w, flightPoll());
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("flight");
    expect(greyed()).toEqual(station);
    expect(station).toEqual(["col", "col", "col", "off-note", "wide"]);
  });
});

describe("Feature: a grey stream is not a change of situation", () => {
  it("Given a flight whose stream goes grey for twenty seconds, Then nothing moves", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    expect(orderOf(w)).toBe("flight");
    const before = JSON.stringify([rootOrder(w), fullOrder(w)]);
    answer(w, flightPoll({ frame_age_ms: 60_000 })); // frames older than the stale limit: grey values
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await w.advance(500);
      seen.push(JSON.stringify([rootOrder(w), fullOrder(w)]));
    }
    expect(visibleText(w.root)).toContain("Flux interrompu");
    expect(new Set(seen)).toEqual(new Set([before]));
    expect(orderOf(w)).toBe("flight");
    expect(orderButton(w).textContent).toBe("Ordre : auto · vol");
  });

  it("Given the game log saying menu, Then the page goes back to the default order after its stability, and returns when the flight resumes", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    expect(orderOf(w)).toBe("flight");
    answer(w, flightPoll({ connection: { ...ONLINE, state: "menu" } }));
    await w.advance(2 * SECOND);
    expect(orderOf(w)).toBe("flight"); // not yet
    await w.advance(3 * SECOND);
    expect(orderOf(w)).toBe("station");
    expect(orderButton(w).textContent).toBe("Ordre : auto · contexte inconnu, ordre commerce");
    answer(w, flightPoll());
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("flight");
  });
});

describe("Feature: an alert reminder calls the shortcuts up, between the banner and the instruments", () => {
  const lock = { conditions: [{ id: "hostile_lock", level: "bad" }] };

  it("Given a hostile lock in flight, Then the zone stands right under the banner, with the countermeasure keys; without an alert, after the instruments", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({ derived: { in_planet_frame: true } }));
    await w.advance(3 * SECOND);
    expect(fullOrder(w)).toContain("sc");
    expect(rootOrder(w)).not.toContain("sc");
    answer(w, flightPoll({ derived: { in_planet_frame: true }, ...lock }));
    await w.advance(1 * SECOND); // urgent: no wait
    const root = rootOrder(w);
    expect(root.indexOf("ctx")).toBeLessThan(root.indexOf("sc"));
    expect(root.indexOf("sc")).toBeLessThan(root.indexOf("full"));
    expect(fullOrder(w)).not.toContain("sc");
    const zone = findAll(w.root, (n) => n.className === "sc")[0]!;
    expect(visibleText(zone)).toContain("Leurres");
    // the tab order: the zone before the instruments
    const stops = tabStops(w);
    expect(at(stops, SHORTCUT_FOLD)).toBeLessThan(at(stops, "Épingler : vitesse"));
    // the alert ends: the zone goes back down after its moment of stability, not before
    answer(w, flightPoll({ derived: { in_planet_frame: true } }));
    await w.advance(2 * SECOND);
    expect(rootOrder(w)).toContain("sc");
    await w.advance(3 * SECOND);
    expect(rootOrder(w)).not.toContain("sc");
    expect(fullOrder(w)).toContain("sc");
    expect(orderOf(w)).toBe("flight");
  });

  it("Given the commerce order, Then an alert does not move the zone", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({ ...lock }, { landed: true }));
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("");
    const root = rootOrder(w);
    expect(root.indexOf("sc")).toBeLessThan(root.indexOf("ses"));
  });
});

describe("Feature: the commerce fold keeps one name, and aria-expanded says the state", () => {
  it("Given the fold opened and closed, Then the accessible name is the same, only aria-expanded changes", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    const states: string[] = [];
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      names.push(foldButton(w).attrs["aria-label"]!);
      states.push(foldButton(w).attrs["aria-expanded"]!);
      foldButton(w).click();
    }
    expect(names).toEqual(["Carte Commerce", "Carte Commerce", "Carte Commerce"]);
    expect(states).toEqual(["false", "true", "false"]);
    expect(foldButton(w).textContent).not.toMatch(/Déplier|Replier/);
  });
});

describe("Feature: the automatic change of order is said once, through the existing status region", () => {
  const sr = (w: PageWorld) => w.root.children.find((c) => c.className === "sr-only")!;

  it("Given flight, then landing, Then the region says the new order; a press of the button does not add to it", async () => {
    const w = await fullscreenPage();
    const live = () => findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length;
    const regions = live();
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    expect(sr(w).textContent).toBe("Ordre : vol");
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(5 * SECOND);
    expect(orderOf(w)).toBe("station");
    expect(sr(w).textContent).toBe("Ordre : commerce");
    orderButton(w).click(); // forced commerce: nothing moves
    orderButton(w).click(); // forced flight, by hand: the button already says it
    expect(orderOf(w)).toBe("flight");
    expect(sr(w).textContent).toBe("Ordre : commerce");
    expect(live()).toBe(regions);
    expect(live()).toBeLessThanOrEqual(3);
  });
});

describe("Feature: an automatic change waits while the page is scrolled down", () => {
  const scrollTo = (w: PageWorld, y: number) => {
    (w.doc.documentElement as any).scrollTop = y;
  };

  it("Given a landing while the page is scrolled past 200 px, Then it waits for the top; the player's press applies at once", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll());
    await w.advance(3 * SECOND);
    expect(orderOf(w)).toBe("flight");
    scrollTo(w, 500);
    answer(w, flightPoll({}, { landed: true }));
    await w.advance(10 * SECOND);
    expect(orderOf(w)).toBe("flight");
    scrollTo(w, 150);
    await w.advance(1 * SECOND);
    expect(orderOf(w)).toBe("station"); // near the top again: applied
    // back in flight, scrolled: waits; the button applies anyway
    answer(w, flightPoll());
    scrollTo(w, 900);
    await w.advance(6 * SECOND);
    expect(orderOf(w)).toBe("station");
    orderButton(w).click(); // commerce (forced): already that order
    orderButton(w).click(); // flight (forced)
    expect(orderOf(w)).toBe("flight");
  });

  it("Given the alert calling the zone up while scrolled, Then it waits too", async () => {
    const w = await fullscreenPage();
    answer(w, flightPoll({ derived: { in_planet_frame: true } }));
    await w.advance(3 * SECOND);
    scrollTo(w, 600);
    answer(
      w,
      flightPoll({
        derived: { in_planet_frame: true },
        conditions: [{ id: "hostile_lock", level: "bad" }],
      }),
    );
    await w.advance(3 * SECOND);
    expect(rootOrder(w)).not.toContain("sc");
    scrollTo(w, 0);
    await w.advance(1 * SECOND);
    expect(rootOrder(w)).toContain("sc");
  });
});
