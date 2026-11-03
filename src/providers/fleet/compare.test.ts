import { describe, expect, it } from "vitest";
import { compareSources, parseUexCrew, parseWikiCrew } from "./compare.js";

describe("parseUexCrew: a range or nothing, never a wrong figure", () => {
  it.each([
    ["1", { min: 1, max: 1 }],
    ["1,2", { min: 1, max: 2 }],
    ["1-2", { min: 1, max: 2 }],
    ["1 to 2", { min: 1, max: 2 }],
    ["10-20 crew", { min: 10, max: 20 }],
    ["1 to 2 (pilot + co)", { min: 1, max: 2 }],
    [" 4 ", { min: 4, max: 4 }],
    [3, { min: 3, max: 3 }],
  ])("%j gives %j", (raw, want) => {
    expect(parseUexCrew(raw)).toEqual(want);
  });

  it.each(["2+", "-1", "1-2-3", "0", "0,2", "", "many", "1 2", "1.5", null, undefined, -1, 0])(
    "%j gives no figure",
    (raw) => {
      expect(parseUexCrew(raw)).toBeUndefined();
    },
  );
});

describe("parseWikiCrew", () => {
  it("reads {min, max}, a single number, and one bound standing for both", () => {
    expect(parseWikiCrew({ min: 2, max: 4 })).toEqual({ min: 2, max: 4 });
    expect(parseWikiCrew(3)).toEqual({ min: 3, max: 3 });
    expect(parseWikiCrew("3")).toEqual({ min: 3, max: 3 });
    expect(parseWikiCrew({ min: 1, max: null })).toEqual({ min: 1, max: 1 });
  });

  it("treats 0, negatives and empty values as not provided", () => {
    expect(parseWikiCrew({ min: 0, max: 0 })).toBeUndefined();
    expect(parseWikiCrew({ min: 1, max: 0 })).toBeUndefined();
    expect(parseWikiCrew(0)).toBeUndefined();
    expect(parseWikiCrew({ min: -1, max: 2 })).toBeUndefined();
    expect(parseWikiCrew({})).toBeUndefined();
    expect(parseWikiCrew(null)).toBeUndefined();
  });
});

describe("compareSources cargo tolerance", () => {
  const cargo = (a: number, b: number) =>
    compareSources({ scu: a }, { cargo_capacity: b }).cargo_scu?.conflict;
  it("ignores a gap under half a percent and flags a real one", () => {
    expect(cargo(12, 12.0001)).toBe(false);
    expect(cargo(696, 720)).toBe(true);
    expect(cargo(100, 100.4)).toBe(false);
    expect(cargo(100, 101)).toBe(true);
  });
});
