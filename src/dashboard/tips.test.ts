/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { pageCss } from "./page.js";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  walk,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";

/**
 * The long reading of a short label ("Données de 0,8 s", the dial legend, the name of a lamp) used to be a native `title`,
 * which only a hovering mouse reaches. It is now one shared bubble that a keyboard (focus, Enter, Escape) and a finger (tap)
 * reach too. The fake DOM has no bubbling: the View listens on the body, so the tests fire the events there.
 */

const SECOND = 1000;

async function live() {
  const w = await startPage();
  await w.advance(30 * SECOND);
  return w;
}

/** An event as the browser delivers it to the body, from `target`. Returns the object so a test can read preventDefault. */
function fire(w: PageWorld, type: string, target: FakeNode | null, extra: object = {}): any {
  const event: any = {
    target,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    ...extra,
  };
  for (const fn of w.doc.body.listeners[type] ?? []) fn(event);
  return event;
}

const age = (w: PageWorld) => findAll(w.root, (n) => n.className === "age")[0]!;
const bubble = (w: PageWorld) => findAll(w.root, (n) => n.className === "tip")[0]!;
const lamp = (w: PageWorld) => findAll(w.root, (n) => n.className === "lamp")[0]!;
const open = (w: PageWorld) => isShown(bubble(w));

describe("Feature: a tip is reachable without a mouse", () => {
  it("Given the compact header, Then the age is a labelled button in the tab order and carries no native title", async () => {
    const w = await live();
    const a = age(w);
    expect(a.attrs["title"]).toBeUndefined();
    expect(a.attrs["data-tip"]).toMatch(/^Données de \d+(,\d)? s$/);
    expect(a.attrs["tabindex"]).toBe("0");
    expect(a.attrs["role"]).toBe("button");
    expect(a.attrs["aria-expanded"]).toBe("false");
    expect(open(w)).toBe(false);
  });

  it("Given the focus reaches the age, Then the bubble opens, is tied by aria-describedby, and closes when the focus leaves", async () => {
    const w = await live();
    const a = age(w);
    fire(w, "focusin", a);
    expect(open(w)).toBe(true);
    expect(bubble(w).textContent).toBe(a.attrs["data-tip"]);
    expect(a.attrs["aria-describedby"]).toBe(bubble(w).attrs["id"]);
    expect(a.attrs["aria-expanded"]).toBe("true");
    fire(w, "focusout", a);
    expect(open(w)).toBe(false);
    expect(a.attrs["aria-describedby"]).toBe("");
    expect(a.attrs["aria-expanded"]).toBe("false");
  });

  it("Given an open bubble, Then Escape closes it, and Enter or Space opens it again and a second one closes it", async () => {
    const w = await live();
    const a = age(w);
    fire(w, "focusin", a);
    fire(w, "keydown", a, { key: "Escape" });
    expect(open(w)).toBe(false);
    expect(a.attrs["aria-expanded"]).toBe("false");
    // Enter pins it: leaving with the mouse no longer closes it
    const enter = fire(w, "keydown", a, { key: "Enter" });
    expect(enter.prevented).toBe(true);
    expect(open(w)).toBe(true);
    fire(w, "mouseout", a);
    expect(open(w)).toBe(true);
    fire(w, "keydown", a, { key: " " });
    expect(open(w)).toBe(false);
    // another key does nothing
    fire(w, "keydown", a, { key: "a" });
    expect(open(w)).toBe(false);
  });

  it("Given a mouse, Then hover opens and leaving closes; given a tap, Then the first tap pins it and a tap elsewhere closes it", async () => {
    const w = await live();
    const a = age(w);
    fire(w, "mouseover", a);
    expect(open(w)).toBe(true);
    fire(w, "mouseout", a);
    expect(open(w)).toBe(false);
    // a tap: the browser sends mouseover then click
    fire(w, "mouseover", a);
    fire(w, "click", a);
    fire(w, "mouseout", a);
    expect(open(w)).toBe(true);
    fire(w, "click", w.root);
    expect(open(w)).toBe(false);
    expect(a.attrs["aria-expanded"]).toBe("false");
  });

  it("Given a lamp or a power node (information the text already carries), Then the tip is for the pointer and the finger, not a tab stop", async () => {
    const w = await live();
    findButton(w.root, "Plein écran").click();
    await w.advance(SECOND);
    const l = lamp(w);
    expect(l.attrs["data-tip"]).toMatch(/ : /);
    expect(l.attrs["tabindex"]).toBeUndefined();
    expect(l.attrs["role"]).toBeUndefined();
    // the event comes from a child of the lamp: the tip is found upwards
    fire(w, "mouseover", l.children[0]!);
    expect(open(w)).toBe(true);
    expect(bubble(w).textContent).toBe(l.attrs["data-tip"]);
    fire(w, "mouseout", l.children[0]!);
    expect(open(w)).toBe(false);
    fire(w, "click", l.children[0]!);
    expect(open(w)).toBe(true);
  });

  it("Given the page, Then no element but a button keeps a hover-only native title, and every tab stop added is a named button", async () => {
    const w = await live();
    walk(w.root, (n) => {
      if (n.attrs["title"] !== undefined) expect(n.tag, n.className).toBe("button");
      if (n.attrs["tabindex"] === "0") {
        expect(n.attrs["role"], n.className).toBe("button");
        expect(n.attrs["data-tip"], n.className).toBeTruthy();
      }
    });
  });

  it("Given an open bubble, Then it is no live region and follows its label as the age ticks", async () => {
    const w = await live();
    expect(bubble(w).attrs["role"]).toBe("tooltip");
    expect(bubble(w).attrs["aria-live"]).toBeUndefined();
    const a = age(w);
    fire(w, "focusin", a);
    const before = bubble(w).textContent;
    // the frames stop coming: the age grows
    w.scenario.cut = true;
    await w.advance(2 * SECOND);
    expect(bubble(w).textContent).toBe(a.attrs["data-tip"]);
    expect(bubble(w).textContent).not.toBe(before);
    expect(open(w)).toBe(true);
  });

  it("Given full screen, Then the age says it in words and has no tip to reach", async () => {
    const w = await live();
    findButton(w.root, "Plein écran").click();
    await w.advance(SECOND);
    const a = age(w);
    expect(a.textContent).toMatch(/^Données de /);
    expect(a.attrs["data-tip"]).toBe("");
    expect(a.attrs["tabindex"]).toBe("-1");
  });

  it("Given a label that loses its text while its bubble is open, Then the bubble closes", async () => {
    const w = await live();
    fire(w, "focusin", age(w));
    expect(open(w)).toBe(true);
    // the stream is cut for good: the age goes away with the live state
    w.scenario.cut = true;
    await w.advance(120 * SECOND);
    expect(age(w).attrs["data-tip"]).toBe("");
    expect(open(w)).toBe(false);
  });
});

describe("Feature: the style sheet gives the tips a ring, a bubble that never takes the pointer, and one title per session card", () => {
  const css = pageCss();

  it("Then a focused tip has the same ring as a button, and the bubble lets the pointer through", () => {
    expect(css).toMatch(/\[data-tip\]:focus-visible/);
    expect(css).toMatch(/\.tip \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.tip \{[^}]*position: fixed/);
  });

  it("Then the title of the card is hidden only where the fold button already says it (compact view, unfolded)", () => {
    expect(css).toContain('[data-mode=inline] .ses[data-fold="0"] .ses-title { display: none; }');
    // the full-screen card has no fold button: its title is never hidden
    expect(css).not.toMatch(/\[data-mode=fullscreen\][^{]*\.ses-title \{ display: none/);
  });
});
