import { describe, expect, it } from "vitest";
import { WIDGETS } from "../providers/telemetry/coverage.js";
import { fullAnswers } from "./testing/fullPoll.js";
import { Scenario } from "./testing/scenario.js";
import {
  FakeNode,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  walk,
} from "./testing/pageHarness.js";

const SECOND = 1000;
const FULL = "Plein écran";

async function cockpit(seconds = 30) {
  const w = await startPage({ scenario: new Scenario() });
  await w.advance(seconds * SECOND);
  findButton(w.root, FULL).click();
  await w.advance(2 * SECOND);
  return w;
}

describe("Feature: every widget of the coverage table exists in the page", () => {
  it("Given the cockpit, Then every `data-w` id of coverage.ts is present, and no page widget is missing from the table", async () => {
    const w = await cockpit(60);
    const present = new Set<string>();
    walk(w.root, (n) => {
      const id = n.attrs["data-w"];
      if (id) present.add(id);
    });
    for (const id of Object.keys(WIDGETS)) expect(present.has(id), `widget ${id}`).toBe(true);
    const known = new Set([...Object.keys(WIDGETS), "conditions", "events"]);
    for (const id of present) expect(known.has(id), `unlisted widget ${id}`).toBe(true);
  });

  it("Given an answer in which every field of the stream is filled, Then the page shows it without NaN, undefined or a hole", async () => {
    const w = await cockpit(30);
    const poll = JSON.parse(JSON.stringify(fullAnswers().poll));
    poll.state = "live";
    w.host.overrides.poll = (base) => ({
      ...poll,
      at: base.at,
      frame_age_ms: 50,
      unchanged: undefined,
      hash: undefined,
      not_in_stream: base.not_in_stream,
    });
    await w.advance(3 * SECOND);
    const text = visibleText(w.root);
    expect(text).not.toMatch(/NaN|undefined|null|\[object/);
    // Unverified values are listed and labelled as such; the heading compass is valid (inside a planet's frame).
    expect(text).toContain("Valeurs non vérifiées");
    expect(text).toContain("Oxygène");
    expect(text).toContain("non vérifié");
    const compass = findAll(w.root, (n) => n.attrs["data-w"] === "heading")[0]!;
    expect(compass.attrs["data-valid"]).toBe("1");
  });
});

describe("Feature: a ship that is off gives a calm view, not twenty zeros", () => {
  it("Given the powerplant off, Then the banner says so, the dials are dashes and hydrogen is not a red zero", async () => {
    const w = await cockpit(30);
    w.host.overrides.poll = (base) => ({
      ...base,
      unchanged: undefined,
      ship: {
        ...base.ship,
        instruments: {
          ...base.ship.instruments,
          speed_ms: 0,
          hydrogen_fuel: 0,
          vertical_speed_ms: 0,
          g: { current: 0, max: 9 },
        },
        power: { powerplants: false, engines: false, weapons: false, shield_generators: false },
      },
      conditions: [
        { id: "powerplant_off", level: "critical", confidence: "confirmed", since: base.at - 5000 },
      ],
    });
    await w.advance(3 * SECOND);
    const text = visibleText(w.root);
    expect(w.root.attrs["data-ship"]).toBe("off");
    expect(text).toContain("Vaisseau éteint");
    expect(text).toContain("la centrale est hors service");
    expect(text).toContain("hors service");
    expect(text).not.toMatch(/\n0\s?%\n/); // no "0 %" hydrogen
    const hydrogen = findAll(w.root, (n) => n.attrs["data-w"] === "hydrogen")[0]!;
    expect(hydrogen.attrs["data-level"]).toBe("none");
    // Only the plant condition is a chip: the rest are consequences.
    const verdict = findAll(w.root, (n) => n.className === "verdict")[0]!;
    expect(verdict.textContent).toBe("Vaisseau éteint");
  });
});

describe("Feature: a datum keeps its age and goes grey with the stream", () => {
  it("Given a cut stream, Then the cards are greyed and no cheerful verdict remains", async () => {
    const w = await cockpit(30);
    expect(visibleText(w.root)).toContain("Tout va bien");
    w.scenario.cut = true;
    await w.advance(12 * SECOND);
    expect(w.root.attrs["data-grey"]).toBe("1");
    expect(visibleText(w.root)).not.toContain("Tout va bien");
  });
});

describe("Feature: the confirmation of a button appears next to the buttons and goes away by itself", () => {
  it("Given 'Analyser ma situation' in the cockpit, Then a polite message shows in the card and clears after a few seconds", async () => {
    const w = await cockpit(30);
    findButton(w.root, "Analyser ma situation").click();
    await w.advance(500);
    const toast = findAll(w.root, (n) => n.className === "toast")[0]!;
    expect(toast.textContent).toContain("Message envoyé à Claude");
    expect(toast.attrs["aria-live"]).toBe("polite");
    await w.advance(7 * SECOND);
    expect(toast.textContent).toBe("");
  });

  it("Given a message sent from the compact view, Then it shows under the header; hidden, no timer remains", async () => {
    const w = await startPage({ scenario: new Scenario() });
    await w.advance(30 * SECOND);
    findButton(w.root, "Analyser").click();
    await w.advance(300);
    const top = findAll(w.root, (n) => n.className === "toast toast-top")[0]!;
    expect(top.textContent).toContain("Message envoyé");
    w.setHidden(true);
    await w.advance(100);
    expect(w.pendingTimers()).toBe(0);
  });
});

describe("Feature: one chronology with filters", () => {
  it("Given events and a marker, Then 'Alertes' keeps the alerts and 'Mes marqueurs' the markers", async () => {
    const w = await cockpit(30);
    findButton(w.root, "Début de session").click();
    await w.advance(72 * SECOND);
    const list = () => visibleText(findAll(w.root, (n) => n.attrs["data-w"] === "events")[0]!);
    expect(list()).toContain("Début de session");
    expect(list()).toContain("Touché");
    findButton(w.root, "Alertes").click();
    expect(list()).not.toContain("Posé");
    expect(list()).not.toContain("Début de session");
    expect(list()).toMatch(/Boucliers tombés|Touché|Verrouillage/);
    findButton(w.root, "Mes marqueurs").click();
    expect(list()).toContain("Début de session");
    expect(list()).not.toContain("Touché");
    expect(findButton(w.root, "Mes marqueurs").attrs["aria-pressed"]).toBe("true");
  });

  it("Given no session marker, Then the session card says how to start one instead of listing dashes", async () => {
    const w = await cockpit(30);
    const text = visibleText(w.root);
    expect(text).toContain("Appuie sur « Début de session »");
    expect(text).not.toContain("Atterrissages");
  });
});

describe("Feature: rendering only touches what changed", () => {
  it("Given data that does not change, Then a second of rendering writes almost nothing to the page", async () => {
    const w = await cockpit(30);
    const frozen = JSON.parse(JSON.stringify(w.scenario.poll(false)));
    w.host.overrides.poll = (base) => ({
      ...frozen,
      at: base.at,
      unchanged: undefined,
      hash: base.hash,
    });
    await w.advance(5 * SECOND);
    const children = FakeNode.writes;
    FakeNode.writes = 0;
    await w.advance(10 * SECOND);
    const perSecond = FakeNode.writes / 10;
    // The ages tick, nothing else: no rebuild (a rebuild would be hundreds of writes a second).
    expect(perSecond).toBeLessThan(40);
    expect(children).toBeGreaterThan(0);
    // No node is ever added after the first build.
    let nodes = 0;
    walk(w.root, () => nodes++);
    await w.advance(10 * SECOND);
    let after = 0;
    walk(w.root, () => after++);
    expect(after).toBe(nodes);
  });

  it("Given the compact view, Then it renders cheaper still", async () => {
    const w = await startPage({ scenario: new Scenario() });
    await w.advance(30 * SECOND);
    const frozen = JSON.parse(JSON.stringify(w.scenario.poll(false)));
    w.host.overrides.poll = (base) => ({
      ...frozen,
      at: base.at,
      unchanged: undefined,
      hash: base.hash,
    });
    await w.advance(5 * SECOND);
    FakeNode.writes = 0;
    await w.advance(10 * SECOND);
    expect(FakeNode.writes / 10).toBeLessThan(20);
  });
});

describe("Feature: the keyboard reaches every control", () => {
  it("Given the cockpit, Then every interactive element is a real button or a summary (focusable, named)", async () => {
    const w = await cockpit(30);
    const buttons = findAll(w.root, (n) => n.tag === "button");
    expect(buttons.length).toBeGreaterThan(15);
    for (const b of buttons) {
      const name = b.textContent || b.attrs["aria-label"] || b.attrs["title"];
      expect(name, "a button without a name").toBeTruthy();
    }
    // Icon-only pins say what they pin and whether they are on.
    const pins = findAll(w.root, (n) => n.tag === "button" && n.className === "pin");
    expect(pins.length).toBeGreaterThanOrEqual(8);
    for (const p of pins) {
      expect(p.attrs["aria-label"]).toMatch(/^Épingler : /);
      expect(["true", "false"]).toContain(p.attrs["aria-pressed"]);
    }
    // Only one polite live region carries the stream state, one the confirmation, one the commerce search (written
    // only when its situation changes): no per-second announcement.
    const live = findAll(w.root, (n) => n.attrs["aria-live"] !== undefined);
    expect(live.length).toBeLessThanOrEqual(3);
    expect(isShown(findButton(w.root, "Réduire"))).toBe(true);
  });
});
