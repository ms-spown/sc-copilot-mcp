import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { COVERAGE } from "../providers/telemetry/coverage.js";
import { coverageOf, coverageSection, withCoverage, type Lang } from "./coverageDoc.js";

const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const DOCS: [Lang, string][] = [
  ["en", "docs/TELEMETRY.md"],
  ["fr", "docs/TELEMETRY.fr.md"],
];

describe("Feature: the coverage tables of the documentation come from the code", () => {
  it.each(DOCS)(
    "Given %s, Then docs section equals the generated one (run `npm run docs:coverage` to fix)",
    (lang, file) => {
      expect(coverageOf(read(file), lang)).toBe(coverageSection(lang));
    },
  );

  it("Given both languages, Then they list the same field identifiers, in the same order", () => {
    const ids = (lang: Lang, file: string) =>
      [...coverageOf(read(file), lang)!.matchAll(/^\| `([A-Za-z]+\.[a-z_0-9]+)` \|/gm)].map(
        (m) => m[1],
      );
    const en = ids("en", "docs/TELEMETRY.md");
    expect(en).toEqual(Object.keys(COVERAGE));
    expect(ids("fr", "docs/TELEMETRY.fr.md")).toEqual(en);
  });

  it("Given a document with or without the section, Then withCoverage replaces or inserts it once", () => {
    const base = "# T\n\ntext\n\n## What the tools do with it\n\nmore\n";
    const once = withCoverage(base, "en", "## What the tools do with it");
    expect(once.match(/^## Coverage$/gm)).toHaveLength(1);
    expect(once).toContain("## What the tools do with it");
    expect(withCoverage(once, "en", "## What the tools do with it")).toBe(once);
  });
});
