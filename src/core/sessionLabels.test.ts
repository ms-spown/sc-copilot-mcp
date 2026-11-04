import { describe, expect, it } from "vitest";
import { sessionInterruptionLabel, sessionQualityLabel } from "../dashboard/sessionPanel.js";
import * as neutral from "./sessionLabels.js";

/**
 * The dashboard page carries its own copies of these two functions (it serialises them and cannot import); the session report
 * uses the neutral ones. They must say the same words.
 */
describe("Feature: the report and the dashboard name breaks and balance qualities alike", () => {
  it("Given every kind and quality, Then the two copies agree", () => {
    for (const k of ["game_closed", "unclean", "anything"])
      expect(neutral.sessionInterruptionLabel(k)).toBe(sessionInterruptionLabel(k));
    for (const q of ["game_start", "first_seen", "new_session", "late", null, "weird"])
      expect(neutral.sessionQualityLabel(q)).toBe(sessionQualityLabel(q));
  });
});
