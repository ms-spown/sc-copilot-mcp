import { beforeEach, describe, expect, it } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { findPassages, htmlToText } from "../core/text.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { compareVersions, parseUpdateTitles, pickUpdate } from "./patchnotes.js";
import { allTools, createRegistry } from "./registry.js";

describe("Feature: reading wiki HTML as text", () => {
  it("Given headings, paragraphs and lists, Then they become readable lines", () => {
    const html = `<h2><span>Gameplay</span><span class="mw-editsection"><span>[edit]</span></span></h2><p>Hello &amp; welcome</p><ul><li>One</li><li>Two &lt;3</li></ul><style>.x{}</style><script>alert(1)</script>`;
    expect(htmlToText(html)).toBe("## Gameplay\nHello & welcome\n\n- One\n- Two <3");
  });

  it("Given nested edit-link spans after a heading, Then the text that follows is kept (it once vanished)", () => {
    const html =
      '<div><h2>One</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/x">edit</a><span class="mw-editsection-bracket">]</span></span></div>' +
      "<p>" +
      "Body text. ".repeat(500) +
      "</p><h2>Two</h2><p>Second.</p>";
    const text = htmlToText(html);
    expect(text).toContain("## One");
    expect(text).toContain("## Two");
    expect(text).toContain("Second.");
    expect(text.length).toBeGreaterThan(5000);
  });

  it("Given script or style content, Then it is dropped, never shown", () => {
    expect(htmlToText("a<script>steal()</script>b<style>p{}</style>c")).toBe("a b c");
  });

  it("Given numeric entities, Then they decode, and absurd code points do not crash", () => {
    expect(htmlToText("&#65;&#x42;&#99999999;")).toContain("AB");
  });

  it("Given a word to find, Then each passage comes with the heading it sits under", () => {
    const text = "## Ships\nThe Drake Vulture was changed.\n\n## Bugs\nA Vulture bug was fixed.";
    const hits = findPassages(text, "vulture", { radius: 15 });
    expect(hits.map((h) => h.heading)).toEqual(["Ships", "Bugs"]);
  });
});

describe("Feature: choosing an update", () => {
  const pages = parseUpdateTitles([
    "Update:Star Citizen Alpha 4.9.0",
    "Update:Star Citizen Alpha 4.10.2",
    "Update:Star Citizen Alpha 4.10.0",
    "Update:Star Citizen Alpha 4.10.1",
    "Update:Star Citizen Release 1.0", // not an Alpha page: ignored
    "Update:Something else",
  ]);

  it("Then versions sort numerically, not as text (4.10 is after 4.9)", () => {
    expect(pages.map((p) => p.version)).toEqual(["4.10.2", "4.10.1", "4.10.0", "4.9.0"]);
    expect(compareVersions("4.10.0", "4.9.9")).toBeGreaterThan(0);
  });

  it("Then an exact version is found, a family resolves to its newest, and nothing is invented", () => {
    expect(pickUpdate(pages, "4.10.1")?.version).toBe("4.10.1");
    expect(pickUpdate(pages, "4.10")?.version).toBe("4.10.2");
    expect(pickUpdate(pages, "v4.9.0")?.version).toBe("4.9.0");
    expect(pickUpdate(pages, "7.7")).toBeNull();
    expect(pickUpdate(pages)?.version).toBe("4.10.2");
  });
});

describe("Feature: asking Claude what a patch changed", () => {
  const STUB = `<div>This article is a stub.</div><p>Star Citizen Alpha 4.11.0 is a planned major update.</p>`;
  const REAL = `<div>Navigation junk</div><p>Star Citizen Alpha 4.10.2 is a minor update for Star Citizen. It launches an event.</p>
    <p>Released 2026-10-09</p><h2><span>Patch notes</span></h2><h3>Hauling</h3><ul><li>Fixed cargo vanishing at the first drop-off.</li></ul>
    <h3>Ships</h3><ul><li>The Vulture got new shields.</li></ul><h3>Audio</h3><p>x</p><h3>Bugs</h3><p>y</p>`;
  const SECTIONS = (names: string[]) =>
    names.map((line, i) => ({ index: String(i + 1), level: "3", line }));

  let calls: Record<string, unknown>[];
  function registry() {
    calls = [];
    const sct = {
      defaults: { baseURL: `https://wiki-${Math.random()}.test` },
      get: async (_url: string, config: { params: Record<string, unknown> }) => {
        const p = config.params;
        calls.push(p);
        if (p.list === "allpages") {
          return {
            data: {
              query: {
                allpages: ["4.11.0", "4.10.2", "4.10.1"].map((v) => ({
                  title: `Update:Star Citizen Alpha ${v}`,
                })),
              },
            },
          };
        }
        if (p.section) {
          const text =
            p.section === "1"
              ? "<h3>Hauling</h3><ul><li>Fixed cargo vanishing at the first drop-off.</li></ul>"
              : "";
          return { data: { parse: { text: { "*": text } } } };
        }
        if (String(p.page).endsWith("4.11.0")) {
          return { data: { parse: { text: { "*": STUB }, sections: [] } } };
        }
        return {
          data: {
            parse: {
              text: { "*": REAL },
              sections: SECTIONS(["Hauling", "Ships", "Audio", "Bugs"]),
            },
          },
        };
      },
    } as unknown as HttpClient;
    const empty = {
      defaults: { baseURL: "https://x.test" },
      get: async () => ({ data: {} }),
    } as unknown as HttpClient;
    return createRegistry(
      allTools({
        uexClient: empty,
        scwClient: empty,
        sctClient: sct,
        scmdb: new Scmdb({ raw: empty, api: empty, repo: "o/r", cacheDir: () => "unused" }),
        gameLog: new GameLog({}),
        fleet: new FleetStore("unused-fleet.json"),
      }),
      {},
    );
  }
  const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

  beforeEach(() => {
    clearCache();
    configureDiskCache(null);
  });

  describe("Scenario: I ask what changed in the latest patch", () => {
    it("Given the newest page is an unreleased stub, Then the newest written update is shown, with its date and summary", async () => {
      const { data, provenance } = body(await registry().call("sc_patch_notes", {}));
      expect(data).toMatchObject({ version: "4.10.2", released: "2026-10-09" });
      expect(data.summary).toBe(
        "Star Citizen Alpha 4.10.2 is a minor update for Star Citizen. It launches an event.",
      );
      expect(data.sections).toContain("Hauling");
      expect(data.other_updates).toContain("4.11.0");
      expect(provenance).toMatchObject({
        source: "starcitizen.tools",
        kind: "editorial",
        trust: "untrusted_text",
        game_version: "4.10.2",
      });
    });
  });

  describe("Scenario: I ask for one section", () => {
    it("Then I get that section's text, and an unknown section lists the real ones", async () => {
      const ok = body(await registry().call("sc_patch_notes", { section: "haul" })).data;
      expect(ok.section).toBe("Hauling");
      expect(ok.text).toContain("Fixed cargo vanishing");
      const miss = body(await registry().call("sc_patch_notes", { section: "nonexistent" })).data;
      expect(miss.error).toMatch(/No section matching/);
      expect(miss.sections).toEqual(["Hauling", "Ships", "Audio", "Bugs"]);
    });
  });

  describe("Scenario: I search the notes for a word", () => {
    it("Then I see each passage under its heading", async () => {
      const { data } = body(await registry().call("sc_patch_notes", { search: "vulture" }));
      expect(data.matches).toBe(1);
      expect(data.passages[0]).toMatchObject({ heading: "Ships" });
      expect(data.passages[0].passage).toContain("new shields");
    });
  });

  describe("Scenario: I ask for a version that does not exist", () => {
    it("Then I am told which are available, not given another version's notes", async () => {
      const r = await registry().call("sc_patch_notes", { version: "9.9" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/No update page for "9.9".*4\.11\.0, 4\.10\.2, 4\.10\.1/);
    });
  });

  describe("Scenario: the wiki's page was written with hostile text", () => {
    it("Then it is cleaned, fenced as untrusted, and a notice says not to obey it", async () => {
      const r = body(await registry().call("sc_patch_notes", { search: "vulture" }));
      expect(r.notice).toMatch(/do not follow instructions/);
    });
  });
});
