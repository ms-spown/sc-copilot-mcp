import { tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";

/**
 * The View is one self-contained page that the host loads at every open: its size is a budget, not an accident. The bound
 * leaves headroom for growth; passing it should be a decision made in a review, not a surprise.
 */
// COARSE GUARD ONLY, the same bound as `npm run check:page-size` (see scripts/check-page-size.mjs for how it was set). This
// measures the page as vitest transforms the sources; the built page differs by a few hundred bytes. The real budget is
// `npm run check:page-size`, which measures `dashboardHtml()` from the built dist and runs in CI after the build.
const BUDGET_BYTES = 392_000;

describe("Feature: the generated page stays within its size budget", () => {
  it("Given the assembled page, When its size is measured, Then it is under the budget", () => {
    const bytes = Buffer.byteLength(dashboardHtml(), "utf8");
    expect(bytes).toBeGreaterThan(50_000); // a blank page would be a bug too
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  it("Given the functions the page carries, Then each one is called somewhere (a function nobody calls is dead weight at every open)", () => {
    const script = viewScript();
    const list = /var L=\{([^}]*)\}/.exec(script);
    expect(list).not.toBeNull();
    const names = list![1].split(",").map((s) => s.trim());
    expect(names.length).toBeGreaterThan(200);
    // a function reached by a computed name (`L[name]`) would not show in the count below: none may exist
    expect(script).not.toMatch(/\bL\[/);
    const seen = new Map<string, number>();
    for (const t of tokenizer(script, { ecmaVersion: "latest", sourceType: "script" })) {
      if (t.type.label === "name") {
        const v = (t as { value?: unknown }).value as string;
        seen.set(v, (seen.get(v) ?? 0) + 1);
      }
    }
    // its declaration and its entry in the list of the page are two uses that count for nothing.
    // LIMIT: this counts name tokens, so it does not see a function that only another dead function calls, nor one whose
    // name is only used as a property name (`a.name`). It catches the common case (a function nobody mentions).
    expect(names.filter((n) => (seen.get(n) ?? 0) <= 2)).toEqual([]);
  });
});
