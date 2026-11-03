import { describe, expect, it } from "vitest";
import {
  ALLOWED_NAMESPACE_URIS,
  ALLOWED_UI_RESOURCE_PREFIX,
  checkTexts,
  type Finding,
  type TextFile,
} from "./docsSafety.js";

// URLs are assembled from pieces: this file must pass the check it tests.
const COLON_SLASHES = ":" + "//";
const ui = (rest: string) => "ui" + COLON_SLASHES + rest;
const http = (rest: string) => "http" + COLON_SLASHES + rest;
const SVG = http("www.w3.org/2000/svg");

const file = (path: string, text: string): TextFile => ({ path, text });
const rules = (findings: Finding[]) => findings.map((f) => f.rule);

describe("Feature: the two exact exceptions of the link check", () => {
  describe("Scenario: the MCP App resource URI", () => {
    it("Given the ui URI of this server in a source file, Then it passes", () => {
      const text = `export const URI = "${ui("sc-copilot/live-dashboard.html")}";\n`;
      expect(checkTexts([file("src/dashboard/constants.ts", text)])).toEqual([]);
    });

    it("Given the prefix constant, Then it is exactly the one the server serves", () => {
      expect(ALLOWED_UI_RESOURCE_PREFIX).toBe(ui("sc-copilot/"));
    });

    it.each([
      ["another authority", ui("evil/page.html")],
      ["a look-alike prefix", ui("sc-copilot.evil/page.html")],
      ["no trailing path of this server", ui("sc-copilot")],
      ["a different scheme with the same name", "uix" + COLON_SLASHES + "sc-copilot/page.html"],
    ])("Given %s, Then it is still refused", (_label, uri) => {
      const found = checkTexts([file("src/dashboard/constants.ts", `const U = "${uri}";\n`)]);
      expect(rules(found)).toContain("link-scheme");
    });

    it("Given the allowed URI followed by a second, foreign one on the same line, Then the foreign one is refused", () => {
      const text = `const A = "${ui("sc-copilot/a.html")}", B = "${ui("other/b.html")}";\n`;
      expect(rules(checkTexts([file("src/dashboard/constants.ts", text)]))).toContain(
        "link-scheme",
      );
    });
  });

  describe("Scenario: the SVG namespace", () => {
    it("Given the namespace in its one allowed file, Then it passes", () => {
      const text = `const NS = "${SVG}";\n`;
      expect(checkTexts([file("src/dashboard/viewApp.ts", text)])).toEqual([]);
    });

    it("Given the same name in any other file, Then it is refused (plain http)", () => {
      const found = checkTexts([file("src/dashboard/other.ts", `const NS = "${SVG}";\n`)]);
      expect(rules(found)).toContain("link-host");
    });

    it("Given the allowed file with another http address, Then it is refused", () => {
      const text = `const NS = "${SVG}";\nconst X = "${http("www.w3.org/1999/xhtml")}";\n`;
      expect(rules(checkTexts([file("src/dashboard/viewApp.ts", text)]))).toContain("link-host");
    });

    it("Given a decoy host that starts with the namespace, Then it is refused", () => {
      const text = `const NS = "${SVG}.evil.example/x";\n`;
      expect(rules(checkTexts([file("src/dashboard/viewApp.ts", text)]))).toContain("link-host");
    });

    it("Given the list, Then it holds exactly one entry with a reason", () => {
      expect(ALLOWED_NAMESPACE_URIS).toHaveLength(1);
      expect(ALLOWED_NAMESPACE_URIS[0]!.reason.length).toBeGreaterThan(20);
    });
  });
});
