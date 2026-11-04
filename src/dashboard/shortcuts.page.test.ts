/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { shortcutsKeyNote, shortcutsPanel } from "./shortcutsPanel.js";
import {
  FakeNode,
  findAll,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";

/**
 * Feature: the "Raccourcis" zone in the assembled page, as it ships, against the fake host. The made-up flight of the
 * scenario gives some contexts (on foot at 9 s, hostile lock at 68 s, on the ground at 14 s); the others are made by
 * overriding what the host answers.
 */

const SECOND = 1000;
const ONLINE = { state: "online", since: "2026-11-04T10:00:00Z", code: null, reason: null };

async function at(seconds: number, options: { fullscreen?: boolean } = {}) {
  const w = await startPage({ scenario: new Scenario() });
  if (options.fullscreen) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
  }
  await w.advance(seconds * SECOND);
  return w;
}

/** The host answers a poll built by the test, over the sections it names (the ones left out are the ones it sends). */
async function made(patch: any, options: { fullscreen?: boolean } = {}) {
  const w = await at(30, options);
  w.host.overrides.poll = (base: any) => ({
    ...base,
    unchanged: undefined,
    connection: ONLINE,
    ship: null,
    pilot: null,
    derived: null,
    weapons: null,
    conditions: [],
    ...patch,
  });
  await w.advance(3 * SECOND);
  return w;
}

const flight = (extra: any = {}, ship: any = {}) => ({
  ship: { name: "DRAK_Cutter_1", landed: false, gear: "retracted", ...ship },
  pilot: { locomotion: "seated", seat: "seat_pilot" },
  derived: {},
  ...extra,
});

const zone = (w: PageWorld): FakeNode => findAll(w.root, (n) => n.className === "sc")[0]!;
const rows = (w: PageWorld): FakeNode[] =>
  findAll(zone(w), (n) => n.className === "sc-row" && isShown(n));
const rowText = (r: FakeNode) => visibleText(r).replace(/\n/g, " ");
const zoneText = (w: PageWorld) => (isShown(zone(w)) ? visibleText(zone(w)) : "");
const buttons = (w: PageWorld) =>
  findAll(zone(w), (n) => n.tag === "button" && isShown(n)).map((b) => b.textContent);
const unfold = (w: PageWorld) =>
  findAll(zone(w), (n) => n.tag === "button" && n.className.includes("sc-fold"))[0]!.click();
const press = (w: PageWorld, label: string) =>
  findAll(zone(w), (n) => n.tag === "button" && n.textContent.startsWith(label))[0]!.click();

describe("Feature: the compact view shows at most three reminders of the moment", () => {
  it("Given the pilot on foot, Then the suit light shows as a low priority with its default key, and one button", async () => {
    const w = await at(9);
    expect(isShown(zone(w))).toBe(true);
    expect(rows(w).map(rowText)).toEqual(["Lampe de combinaison · si besoin T défaut"]);
    expect(visibleText(zone(w))).toContain("· À pied");
    // folded: one tab stop, and it says what it holds
    expect(buttons(w)).toEqual(["À propos des touches ▸"]);
    const fold = findAll(zone(w), (n) => n.tag === "button" && n.className.includes("sc-fold"))[0]!;
    expect(fold.attrs["aria-expanded"]).toBe("false");
    expect(fold.attrs["aria-controls"]).toBe("sc-list");
    expect(fold.attrs["type"]).toBe("button");
  });

  it("Given a hostile lock, Then the countermeasures are on top, the rest is behind the fold", async () => {
    const w = await at(68);
    const shown = rows(w);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown.map(rowText)[0]).toMatch(/^Leurres · verrouillage hostile H maintenir défaut$/);
    expect(shown.map(rowText)[1]).toMatch(/^Brouillage · verrouillage hostile J défaut$/);
    expect(buttons(w)[0]).toMatch(/^Voir les \d+ autres ▸$/);
  });

  it("Given a ship on the ground, Then taking off is first", async () => {
    const w = await made(flight({}, { landed: true, gear: "deployed" }));
    expect(rowText(rows(w)[0]!)).toBe("Demander le décollage");
    expect(zoneText(w)).toContain("· Posé");
  });

  it("Given a seat before the ship's frames arrive, Then Flight Ready is offered with its doubt", async () => {
    const w = await at(14);
    expect(rowText(rows(w)[0]!)).toBe(
      "Flight Ready (démarrer le vaisseau) · si c’est un vaisseau R défaut",
    );
  });

  it("Given the gear out and the ship in the air, Then auto land is offered conditionally, with no key", async () => {
    const w = await made(flight({}, { gear: "deployed" }));
    const first = rowText(rows(w)[0]!);
    expect(first).toBe("Atterrissage automatique · si la demande est accordée");
    expect(zoneText(w)).toContain("· Train sorti, en vol");
  });

  it("Given EVA, a ground vehicle and a stopped ship, Then each has its own reminders", async () => {
    let w = await made({ pilot: { locomotion: "eva" } });
    expect(rows(w).map(rowText)).toEqual(["Lampe de combinaison · si besoin T défaut"]);
    w = await made({ pilot: { locomotion: "seated" }, derived: { ground_vehicle: "ARGO_ATLS" } });
    expect(rows(w).map(rowText)[0]).toBe("Phares · état non lu");
    w = await made(flight({ conditions: [{ id: "powerplant_off", level: "info" }] }));
    expect(rowText(rows(w)[0]!)).toBe("Flight Ready (démarrer le vaisseau) R défaut");
  });

  it("Given the quantum mode, Then holding B is the first reminder", async () => {
    const w = await made(flight({ derived: { in_quantum_mode: true } }));
    expect(rowText(rows(w)[0]!)).toBe("Engager le saut quantique B maintenir défaut");
  });
});

describe("Feature: nothing is shown when nothing is known", () => {
  it("Given the menu, a disconnection or a closed game, Then the zone is hidden", async () => {
    for (const state of ["menu", "disconnected", "closed"]) {
      const w = await made(flight({ connection: { ...ONLINE, state } }));
      // `made` sets a fixed connection after the patch only if the patch does not name one
      expect(isShown(zone(w)), state).toBe(false);
      expect(rows(w), state).toEqual([]);
    }
  });

  it("Given a server with the telemetry off, Then the zone is hidden", async () => {
    const w = await made({ state: "off", frame_age_ms: null });
    expect(isShown(zone(w))).toBe(false);
  });

  it("Given frames that stopped coming, Then the zone is hidden once the values are grey", async () => {
    const w = await at(9);
    expect(isShown(zone(w))).toBe(true);
    w.scenario.cut = true;
    await w.advance(40 * SECOND);
    expect(w.root.attrs["data-grey"]).toBe("1");
    expect(isShown(zone(w))).toBe(false);
  });

  it("Given a context the poll cannot name, Then the compact view shows nothing and full screen says so", async () => {
    const compact = await made({ pilot: { locomotion: "mystery" } });
    expect(isShown(zone(compact))).toBe(false);
    const full = await made({ pilot: { locomotion: "mystery" } }, { fullscreen: true });
    expect(isShown(zone(full))).toBe(true);
    expect(zoneText(full)).toContain("Contexte inconnu : aucun rappel pour l’instant.");
    expect(rows(full)).toEqual([]);
    expect(buttons(full)).toEqual([]);
  });
});

describe("Feature: full screen shows up to six reminders, the rest sits behind one button", () => {
  it("Given a lock, shields down and a planet below, Then six show, the others open with the fold, and nothing else is a tab stop", async () => {
    const w = await at(68, { fullscreen: true });
    expect(rows(w)).toHaveLength(6);
    expect(zoneText(w)).toContain("· En vol, près d’une planète");
    const fold = buttons(w)[0]!;
    expect(fold).toMatch(/^Voir les 2 autres ▸$/);
    unfold(w);
    await w.advance(100);
    expect(rows(w)).toHaveLength(8);
    expect(buttons(w)).toEqual(["Voir les 2 autres ▴", "Il fait sombre"]);
    expect(FakeNode.focused?.className).toContain("sc-fold");
    // the explanation of the keys is written, not only a tip
    expect(zoneText(w)).toContain(shortcutsKeyNote());
    unfold(w);
    await w.advance(100);
    expect(rows(w)).toHaveLength(6);
  });

  it("Given a key, Then its tip is for the pointer: it says 'défaut', and no key is a tab stop", async () => {
    const w = await at(68, { fullscreen: true });
    const caps = findAll(zone(w), (n) => n.className === "sc-k" && isShown(n));
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.attrs["data-tip"]).toBe(shortcutsKeyNote());
      expect(c.attrs["tabindex"]).toBeUndefined();
      expect(c.attrs["role"]).toBeUndefined();
    }
    const stops = findAll(zone(w), (n) => n.attrs["tabindex"] !== undefined);
    expect(stops).toEqual([]);
  });
});

describe("Feature: 'Il fait sombre' is the player's word, kept in this View's memory only", () => {
  it("Given the button pressed on foot, Then the lamp loses its 'si besoin'; pressed again, it is back", async () => {
    const storage = new Map<string, string>();
    const w = await startPage({ scenario: new Scenario(), storage });
    await w.advance(9 * SECOND);
    unfold(w);
    await w.advance(100);
    const writes = [...storage.keys()];
    press(w, "Il fait sombre");
    await w.advance(100);
    const dark = findAll(
      zone(w),
      (n) => n.tag === "button" && n.textContent === "Il fait sombre",
    )[0]!;
    expect(dark.attrs["aria-pressed"]).toBe("true");
    expect(rows(w).map(rowText)).toEqual(["Lampe de combinaison T défaut"]);
    press(w, "Il fait sombre");
    await w.advance(100);
    expect(dark.attrs["aria-pressed"]).toBe("false");
    expect(rows(w).map(rowText)).toEqual(["Lampe de combinaison · si besoin T défaut"]);
    // nothing was remembered anywhere
    expect([...storage.keys()]).toEqual(writes);
  });

  it("Given the button pressed in a ship, Then the lights lead, without any claim on their state", async () => {
    const w = await made(flight());
    unfold(w);
    await w.advance(100);
    press(w, "Il fait sombre");
    await w.advance(100);
    expect(rowText(rows(w)[0]!)).toBe("Phares");
    expect(zoneText(w)).not.toMatch(/éteint/i);
  });

  it("Given a context without lights (powerplant off), Then the button is not offered", async () => {
    const w = await made(flight({ conditions: [{ id: "powerplant_off", level: "info" }] }));
    unfold(w);
    await w.advance(100);
    expect(buttons(w)).not.toContain("Il fait sombre");
  });
});

describe("Feature: what the zone never does", () => {
  it("Given lights_on false, Then no text of the zone says the lights are off", async () => {
    const w = await made(flight({}, { lights_on: false, landed: true }));
    unfold(w);
    await w.advance(100);
    expect(zoneText(w)).toContain("Phares");
    expect(zoneText(w)).not.toMatch(/éteint/i);
  });

  it("Given the balance shown, Then no figure reaches the zone", async () => {
    const w = await at(14);
    findAll(w.root, (n) => n.tag === "button" && n.textContent === "Afficher le solde")[0]!.click();
    await w.advance(2 * SECOND);
    expect(visibleText(w.root)).toMatch(/250/); // the balance is on screen, so the check below means something
    expect(zoneText(w)).not.toMatch(/\d{3}/);
  });

  it("Given the zone, Then it is no live region, adds no region, and the page keeps its three at most", async () => {
    const w = await at(68, { fullscreen: true });
    expect(
      findAll(zone(w), (n) => n.attrs["aria-live"] !== undefined || n.attrs["role"] === "status"),
    ).toEqual([]);
    expect(findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length).toBeLessThanOrEqual(
      3,
    );
    expect(zone(w).attrs["aria-label"]).toBe("Raccourcis");
  });

  it("Given its code, Then it sets text only through textContent and uses no storage, network or markup string", () => {
    const code = String(shortcutsPanel);
    expect(code).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttp|api\.set/,
    );
  });

  it("Given every button of the zone, Then it has a name", async () => {
    const w = await at(68, { fullscreen: true });
    unfold(w);
    await w.advance(100);
    for (const b of findAll(zone(w), (n) => n.tag === "button")) {
      expect(b.textContent || b.attrs["aria-label"]).toBeTruthy();
    }
  });
});
