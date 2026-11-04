import { describe, expect, it } from "vitest";
import { dashboardHtml } from "./page.js";

/**
 * The View is one self-contained page that the host loads at every open: its size is a budget, not an accident. At the
 * time of writing it is about 267 kB (script and styles of the cockpit, the ship sheet, the ledger and the commerce
 * card). The bound leaves headroom for growth; passing it should be a decision made in a review, not a surprise.
 */
const BUDGET_BYTES = 330_000;

describe("Feature: the generated page stays within its size budget", () => {
  it("Given the assembled page, When its size is measured, Then it is under the budget", () => {
    const bytes = Buffer.byteLength(dashboardHtml(), "utf8");
    expect(bytes).toBeGreaterThan(50_000); // a blank page would be a bug too
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
