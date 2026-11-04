import { describe, expect, it } from "vitest";
import { dashboardHtml } from "./page.js";

/**
 * The View is one self-contained page that the host loads at every open: its size is a budget, not an accident. At the
 * time of writing it is about 267 kB (script and styles of the cockpit, the ship sheet, the ledger and the commerce
 * card). The bound leaves headroom for growth; passing it should be a decision made in a review, not a surprise.
 */
// Raised from 330 000 to 380 000: the page is now about 345 kB with the sessions bar, the action bar and the balance
// movements block. A decision of this review, see the pull request.
const BUDGET_BYTES = 380_000;

describe("Feature: the generated page stays within its size budget", () => {
  it("Given the assembled page, When its size is measured, Then it is under the budget", () => {
    const bytes = Buffer.byteLength(dashboardHtml(), "utf8");
    expect(bytes).toBeGreaterThan(50_000); // a blank page would be a bug too
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });
});
