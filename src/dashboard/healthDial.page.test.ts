import { describe, expect, it } from "vitest";
import { findAll, startPage } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";

/**
 * The marks of the health dials (compact and full screen) are drawn from the same two limits as the dial's colour and the
 * band sent to the model: red from 0 to 30 %, amber from 30 % to 50 % (viewLogic.healthInfo).
 */
describe("Feature: the zones of the health dials follow the health limits", () => {
  it("Given the assembled page, Then every health dial has a red zone 0-30 % and an amber zone 30-50 %", async () => {
    const w = await startPage({ scenario: new Scenario() });
    await w.advance(1000);
    const dials = findAll(
      w.root,
      (n) => n.attrs["data-key"] === "health" && n.className.includes("dial"),
    );
    expect(dials.length).toBe(2);
    for (const d of dials) {
      const zones = findAll(
        d,
        (n) => n.attrs["data-tone"] !== undefined && n.attrs["stroke-dasharray"] !== undefined,
      );
      const read = (tone: string) => {
        const z = zones.find((n) => n.attrs["data-tone"] === tone);
        expect(z).toBeDefined();
        return z!.attrs["stroke-dasharray"]!.split(" ").map(Number);
      };
      // "0 <start> <length> 200": the zone starts at `start` and is `length` long, in hundredths of the arc
      const bad = read("bad");
      const warn = read("warn");
      expect(bad[1]).toBeCloseTo(0, 6);
      expect(bad[2]).toBeCloseTo(30, 6);
      expect(warn[1]).toBeCloseTo(30, 6);
      expect(warn[2]).toBeCloseTo(20, 6);
    }
  });
});
