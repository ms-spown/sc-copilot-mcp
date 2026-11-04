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
    stopped: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {
      event.stopped = true;
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

  it("Given an open bubble, Then Escape closes it and is taken; given none, Then Escape goes on to the host untouched", async () => {
    const w = await live();
    const a = age(w);
    // nothing open: the View keeps its hands off Escape
    const idle = fire(w, "keydown", a, { key: "Escape" });
    expect(idle.prevented).toBe(false);
    expect(idle.stopped).toBe(false);
    fire(w, "focusin", a);
    const taken = fire(w, "keydown", a, { key: "Escape" });
    expect(open(w)).toBe(false);
    expect(taken.prevented).toBe(true);
    expect(taken.stopped).toBe(true);
    expect(a.attrs["aria-expanded"]).toBe("false");
  });

  it("Given the focus opened the bubble, Then Enter closes it, the next Enter opens it and keeps it (what is on screen decides)", async () => {
    const w = await live();
    const a = age(w);
    fire(w, "focusin", a);
    expect(open(w)).toBe(true);
    // the first Enter after an opening by focus used to change nothing visible: it now closes
    const first = fire(w, "keydown", a, { key: "Enter" });
    expect(first.prevented).toBe(true);
    expect(open(w)).toBe(false);
    expect(a.attrs["aria-expanded"]).toBe("false");
    // the next one opens it and pins it: leaving with the mouse no longer closes it
    fire(w, "keydown", a, { key: "Enter" });
    expect(open(w)).toBe(true);
    fire(w, "mouseout", a);
    expect(open(w)).toBe(true);
    // Space does the same as Enter, and a Space on a button must not scroll the page
    const space = fire(w, "keydown", a, { key: " " });
    expect(space.prevented).toBe(true);
    expect(open(w)).toBe(false);
    // another key does nothing
    const other = fire(w, "keydown", a, { key: "a" });
    expect(other.prevented).toBe(false);
    expect(open(w)).toBe(false);
  });

  it("Given a mouse leaving the label, Then the bubble stays while the pointer goes to a child of the label and closes otherwise", async () => {
    const w = await live();
    findButton(w.root, "Plein écran").click();
    await w.advance(SECOND);
    const l = lamp(w);
    const child = l.children[0]!;
    fire(w, "mouseover", l);
    expect(open(w)).toBe(true);
    fire(w, "mouseout", l, { relatedTarget: child });
    expect(open(w)).toBe(true);
    fire(w, "mouseout", child, { relatedTarget: w.root });
    expect(open(w)).toBe(false);
  });

  it("Given a bubble open on a label that gets hidden, Then it closes at the next render", async () => {
    const w = await live();
    findButton(w.root, "Plein écran").click();
    await w.advance(SECOND);
    const l = lamp(w);
    fire(w, "mouseover", l);
    expect(open(w)).toBe(true);
    l.parentNode!.attrs["data-hidden"] = "1";
    await w.advance(2 * SECOND);
    expect(open(w)).toBe(false);
  });

  it("Given a pinned bubble, When the page scrolls or resizes, Then it closes; an unpinned one stays (the focus may have scrolled)", async () => {
    const w = await live();
    const a = age(w);
    fire(w, "focusin", a);
    w.fireWindow("scroll");
    expect(open(w)).toBe(true);
    fire(w, "click", a);
    w.fireWindow("scroll");
    expect(open(w)).toBe(false);
    fire(w, "click", a);
    expect(open(w)).toBe(true);
    w.fireWindow("resize");
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
    // not a tab stop, but named in full for a screen reader (the abbreviation THR says nothing)
    expect(l.attrs["role"]).toBe("img");
    expect(l.attrs["aria-label"]).toBe(l.attrs["data-tip"]!.replace(" : ", ", "));
    expect(l.attrs["aria-label"]).toMatch(/^Poussée, /);
    // the event comes from a child of the lamp: the tip is found upwards
    fire(w, "mouseover", l.children[0]!);
    expect(open(w)).toBe(true);
    expect(bubble(w).textContent).toBe(l.attrs["data-tip"]);
    fire(w, "mouseout", l.children[0]!);
    expect(open(w)).toBe(false);
    fire(w, "click", l.children[0]!);
    expect(open(w)).toBe(true);
  });

  it("Given full screen, Then every lamp and power node says its full name and state to a screen reader, and none is a tab stop", async () => {
    const w = await live();
    findButton(w.root, "Plein écran").click();
    await w.advance(SECOND);
    const lamps = findAll(w.root, (n) => n.className === "lamp");
    expect(lamps).toHaveLength(10);
    for (const l of lamps) {
      const abbreviation = l.children[0]!.textContent;
      expect(l.attrs["role"]).toBe("img");
      expect(l.attrs["aria-label"], abbreviation).toMatch(/^[^,]{4,}, [a-zé]/);
      expect(l.attrs["aria-label"], abbreviation).not.toMatch(new RegExp("^" + abbreviation + ","));
      expect(l.attrs["tabindex"]).toBeUndefined();
    }
    expect(lamps.map((l) => l.attrs["aria-label"]!.split(",")[0])).toContain(
      "Radar : verrouillage hostile",
    );
    const nodes = findAll(w.root, (n) => n.className === "pwr-node" && n.attrs["role"] === "img");
    expect(nodes).toHaveLength(8);
    for (const n of nodes) {
      expect(n.attrs["aria-label"]).toMatch(/ : (alimenté|coupé|inconnu)$/);
      expect(n.attrs["tabindex"]).toBeUndefined();
    }
    expect(nodes.map((n) => n.attrs["aria-label"]!.split(" : ")[0])).toContain(
      "Générateurs de boucliers",
    );
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
