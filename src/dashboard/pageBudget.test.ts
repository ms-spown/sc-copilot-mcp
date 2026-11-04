import { describe, expect, it } from "vitest";
import { compact, dashboardHtml, viewScript } from "./page.js";

/**
 * The View is one self-contained page that the host loads at every open: its size is a budget, not an accident. At the
 * time of writing it is about 267 kB (script and styles of the cockpit, the ship sheet, the ledger and the commerce
 * card). The bound leaves headroom for growth; passing it should be a decision made in a review, not a surprise.
 */
// COARSE GUARD ONLY. This measures the page as vitest transforms the sources (comments, and the indentation of the
// functions that hold a template literal, kept), NOT what ships: the built page is smaller since page.ts drops the
// indentation (about 331 kB). The real budget is `npm run check:page-size`, which measures `dashboardHtml()` from the
// built dist and runs in CI after the build.
// 380 kB -> 395 kB with the pre-flight block (about 15 kB of source as vitest sees it, comments included).
const BUDGET_BYTES = 395_000;

describe("Feature: the generated page stays within its size budget", () => {
  it("Given function sources, Then compact drops the indentation, and leaves alone a function that holds a template literal", () => {
    expect(compact("function f() {\n\tif (a) {\n\t\treturn 1;\n\t}\n    return 2;\n}")).toBe(
      "function f() {\nif (a) {\nreturn 1;\n}\nreturn 2;\n}",
    );
    const withTemplate = "function g() {\n  return `a\n    b`;\n}";
    expect(compact(withTemplate)).toBe(withTemplate);
    // A string continued over a line break would lose its indentation: none may exist in the page.
    expect(viewScript()).not.toContain("\\\n");
  });

  it("Given the assembled page, When its size is measured, Then it is under the budget", () => {
    const bytes = Buffer.byteLength(dashboardHtml(), "utf8");
    expect(bytes).toBeGreaterThan(50_000); // a blank page would be a bug too
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
