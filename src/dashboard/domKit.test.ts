/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { VIEW_FUNCTIONS, domKit } from "./viewLogic.js";

/** The one copy of the DOM helpers the panels share (they used to hold eight). */
const fakeDoc = () => {
  const calls: string[] = [];
  const doc = {
    createElement: (tag: string) => {
      const n: any = {
        tag,
        children: [] as any[],
        style: { setProperty: (k: string, v: string) => calls.push(`var ${k}=${v}`) },
        setAttribute: (k: string, v: string) => calls.push(`attr ${k}=${v}`),
        appendChild: (c: any) => n.children.push(c),
      };
      let text: string | undefined;
      Object.defineProperty(n, "textContent", {
        get: () => text,
        set: (v: string) => {
          calls.push(`text ${v}`);
          text = v;
        },
      });
      return n;
    },
  };
  return { doc, calls };
};

describe("Feature: the shared DOM helpers", () => {
  it("Given the page's function list, Then domKit is in it, so that the shipped script holds it once", () => {
    expect(VIEW_FUNCTIONS).toContain(domKit);
  });

  it("Given el, Then the class and the text are only set when given, and add skips empty kids", () => {
    const { doc } = fakeDoc();
    const { el, add } = domKit(doc);
    const bare = el("div");
    expect(bare.className).toBeUndefined();
    expect(bare.textContent).toBeUndefined();
    const full = el("p", "a b", "");
    expect(full.className).toBe("a b");
    expect(full.textContent).toBe("");
    expect(add(bare, full, null, undefined, "")).toBe(bare);
    expect(bare.children).toEqual([full]);
  });

  it("Given setText, setAttr, setVar and show, Then each writes only when the value changed", () => {
    const { doc, calls } = fakeDoc();
    const { el, setText, setAttr, setVar, show } = domKit(doc);
    const n = el("span");
    setText(n, "x");
    setText(n, "x");
    setAttr(n, "title", "t");
    setAttr(n, "title", "t");
    setVar(n, "--w", "1px");
    setVar(n, "--w", "1px");
    show(n, true);
    show(n, true);
    show(n, false);
    expect(calls).toEqual([
      "text x",
      "attr title=t",
      "var --w=1px",
      "attr data-hidden=0",
      "attr data-hidden=1",
    ]);
  });
});
