import { describe, it, expect } from "vitest";
import {
  formatOutput,
  formatOutputRaw,
  optimizeData,
  summarizeItem,
  summarizeList,
  summarizeVehicle,
} from "./format.js";

/** A record fat enough to blow the output budget on its own, as wiki records do. */
function bulkyVehicle(name: string) {
  return {
    name,
    manufacturer: { name: "Aegis Dynamics", code: "AEGS" },
    role: "Interceptor",
    career: "Combat",
    size: 2,
    crew: { min: 1, max: 1 },
    health: 11900,
    shield_hp: 4488,
    speed: { scm: 205, max: 1150 },
    msrp: 60,
    slug: name.toLowerCase(),
    description: {
      en_EN: "x".repeat(9000),
      de_DE: "y".repeat(9000),
      fr_FR: "z".repeat(9000),
    },
    hardpoints: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "q".repeat(200) })),
  };
}

describe("formatOutput size handling", () => {
  it("returns valid JSON for a payload that fits", () => {
    const out = formatOutput({ hello: "world", n: 3 });
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual({ hello: "world", n: 3 });
  });

  it("never emits unparseable JSON when a list overflows the cap", () => {
    // Each record fits on its own; together they do not. This is the common case
    // and must degrade by dropping whole entries, not by cutting a string.
    const midsize = (i: number) => ({
      name: `Ship${i}`,
      description: { en_EN: "x".repeat(1500) },
    });
    const payload = { data: Array.from({ length: 40 }, (_, i) => midsize(i)) };
    const out = formatOutput(payload);
    expect(out.length).toBeLessThanOrEqual(40000);
    // The original bug cut the string mid-token, so this threw.
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data.length).toBeLessThan(40);
    expect(parsed.truncated).toMatch(/showing \d+ of 40/);
  });

  it("respects a caller-supplied maxChars instead of always truncating at 40k", () => {
    // The bug this guards: sc_get_vocabulary's response carries term_count computed
    // before truncation and a terms array truncated after it, so a caller trusting
    // term_count silently got fewer terms than it said - 658 delivered, 2633 claimed.
    // Completeness is the entire point of that tool, so it needs a real ceiling above
    // the browsing-tool default, not silent data loss.
    const terms = Array.from({ length: 2633 }, (_, i) => `Weapon Attachment Item Name ${i}`);
    const payload = { term_count: terms.length, terms };

    const default_ = formatOutput(payload);
    expect(JSON.parse(default_).terms.length).toBeLessThan(terms.length);

    const raised = formatOutput(payload, 200_000);
    const parsedRaised = JSON.parse(raised);
    expect(parsedRaised.terms.length).toBe(terms.length);
    expect(parsedRaised.term_count).toBe(parsedRaised.terms.length);
    expect(parsedRaised.truncated).toBeUndefined();
  });

  it("reports an error rather than truncating a single oversized record", () => {
    const out = formatOutput({ data: [bulkyVehicle("OnlyOne")] });
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.error ?? parsed.truncated).toBeDefined();
  });
});

describe("optimizeData stripping", () => {
  it("drops zeros and nulls to save context", () => {
    expect(optimizeData({ a: 1, b: 0, c: null, d: "" })).toEqual({ a: 1 });
  });

  it("is why diff summaries must bypass it: a zero count is the answer", () => {
    const summary = { added: 0, removed: 0, changed: 0, unchanged: 1 };
    expect(optimizeData(summary)).toEqual({ unchanged: 1 });

    // formatOutputRaw preserves the zeros so "nothing changed" stays legible.
    const parsed = JSON.parse(formatOutputRaw({ summary }));
    expect(parsed.summary).toEqual(summary);
  });
});

describe("list projections", () => {
  it("shrinks a vehicle to its decision-relevant fields", () => {
    const summary = summarizeVehicle(bulkyVehicle("Avenger"));
    expect(summary.name).toBe("Avenger");
    expect(summary.manufacturer).toBe("Aegis Dynamics");
    expect(summary.speed_scm).toBe(205);
    expect(summary.health).toBe(11900);
    // The prose and hardpoints are what made the raw record unusable.
    expect(JSON.stringify(summary)).not.toContain("xxxx");
    expect(JSON.stringify(summary).length).toBeLessThan(500);
  });

  it("keeps a whole page of vehicles inside the output budget", () => {
    const payload = { data: Array.from({ length: 50 }, (_, i) => bulkyVehicle(`Ship${i}`)) };
    const out = formatOutput(summarizeList(payload, summarizeVehicle));
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(40000);
    expect(JSON.parse(out).data).toHaveLength(50);
  });

  it("pulls weapon stats up to the top level of an item summary", () => {
    const summary = summarizeItem({
      name: "AD5B Ballistic Gatling",
      type_label: "Gun",
      size: 5,
      grade: "A",
      manufacturer: { name: "Behring Applied Technology" },
      vehicle_weapon: { damage_per_shot: 102.5, rpm: 900, range: 4003 },
    });
    expect(summary.damage_per_shot).toBe(102.5);
    expect(summary.rpm).toBe(900);
    expect(summary.manufacturer).toBe("Behring Applied Technology");
  });

  it("passes through a payload that is not a list", () => {
    expect(summarizeList({ error: "nope" }, summarizeVehicle)).toEqual({ error: "nope" });
  });
});
