import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProvenance } from "../core/provenance.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { CATALOG, PROFILE_NAMES } from "../tools/catalog.js";
import { allTools } from "../tools/registry.js";

/**
 * Feature: docs/CAPABILITIES.md, the guide to every capability, cannot drift away from the code.
 * No network: the tools are only built (never called) with a client that answers nothing.
 */

const unused = { defaults: {}, get: async () => ({ data: {} }) } as never;
const tools = allTools({
  uexClient: unused,
  scwClient: unused,
  sctClient: unused,
  scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
  gameLog: new GameLog({}),
  fleet: new FleetStore("unused.json"),
});
const toolNames = new Set(tools.map((t) => t.name));

const read = (rel: string) =>
  fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const doc = read("docs/CAPABILITIES.md");

/** Every `inline code` span of a markdown text. */
const codeSpans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

const TOOL_NAME = /^(sc|uex|scw|scmdb|sct)_[a-z0-9_]+$/;

/** GitHub's heading anchors: lower case, punctuation dropped (not "-" or "_"), spaces to "-". */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
const anchorsOf = (text: string) =>
  new Set(
    [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].trim())).filter((s) => s.length > 0),
  );

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("Feature: the capabilities guide names real tools and misses none", () => {
  it("Given the guide, When every tool-like name in backticks is read, Then each one exists", () => {
    const named = codeSpans(doc).filter((s) => TOOL_NAME.test(s));
    expect(named.length).toBeGreaterThan(40);
    const unknown = [...new Set(named)].filter((n) => !toolNames.has(n));
    expect(unknown).toEqual([]);
  });

  it("Given every implemented tool, When the guide is read, Then each one is mentioned and the count is right", () => {
    const mentioned = new Set(codeSpans(doc));
    const missing = [...toolNames].filter((n) => !mentioned.has(n));
    expect(missing).toEqual([]);
    expect(doc).toContain(`${tools.length} tools exist`);
  });

  it("Given a tool in a profile, When the guide gives the profile sizes, Then they match the catalog", () => {
    for (const profile of PROFILE_NAMES) {
      const size = new Set(
        tools.filter((t) => CATALOG[t.name]?.profiles.includes(profile)).map((t) => t.name),
      );
      size.add("sc_data_status");
      expect(doc, profile).toContain(`**${profile}** (${size.size})`);
    }
  });

  it("Given the telemetry tools, When telemetry is off, Then the guide's count of listed tools is right", () => {
    const hidden = tools.filter((t) => t.advertised?.() === false).map((t) => t.name);
    // With no telemetry client, the tools that need it are not advertised (the dashboard ones also need a View).
    expect(hidden.sort()).toEqual([
      "sc_live_dashboard",
      "sc_live_events",
      "sc_live_mark",
      "sc_live_poll",
      "sc_live_state",
      "sc_session_current",
      "sc_session_end",
      "sc_session_list",
      "sc_session_new",
      "sc_session_stats",
    ]);
    expect(doc).toContain(`${tools.length - hidden.length} are listed`);
  });
});

describe("Feature: every variable the guide mentions exists", () => {
  it("Given a variable in backticks, When the source is searched, Then the code reads or sets it", () => {
    const code = srcFiles(fileURLToPath(new URL("../", import.meta.url)))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    const names = codeSpans(doc)
      .map((s) => s.split("=")[0])
      .filter((s) => /^(SCMCP|SC)_[A-Z0-9_]+$|^UEXTOKEN$|^GRPC_CLIENT_SERVER_ENABLED$/.test(s));
    expect(names.length).toBeGreaterThan(15);
    const unknown = [...new Set(names)].filter((n) => !code.includes(n));
    expect(unknown).toEqual([]);
  });
});

describe("Feature: the provenance fields the guide explains are the ones the code produces", () => {
  it("Given a stale answer with dated rows, When provenance is built, Then every documented field is present", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const p = buildProvenance(
      { source: "uex", kind: "crowdsourced", trust: "structured", channel: "live" },
      {
        fetches: [{ fetchedAt: now - 60_000, cache: "stale-disk", staleReason: "HTTP 503" }],
        dataDates: { oldest: now - 3_600_000, newest: now - 60_000, basis: ["test"] },
        notes: [],
      },
      "4.10.2",
      now,
    );
    const documented = [
      "source",
      "kind",
      "channel",
      "game_version",
      "fetched_at",
      "cache_age",
      "data_age",
      "data_date",
      "data_age_note",
      "stale",
      "stale_reason",
      "trust",
    ];
    for (const field of documented) {
      expect(Object.keys(p), field).toContain(field);
      expect(doc, field).toContain(`\`${field}\``);
    }
  });

  it("Given no source date, When provenance is built, Then data_age is null with a note, as the guide says", () => {
    const p = buildProvenance(
      { source: "x", kind: "datamined", trust: "structured", channel: "unknown" },
      { fetches: [], notes: [] },
      null,
    );
    expect(p.data_age).toBeNull();
    expect(p.data_age_note.length).toBeGreaterThan(10);
  });
});

describe("Feature: every capability section has the same fixed table", () => {
  const rows = [
    "What it is for",
    "Example questions",
    "Tools",
    "Source",
    "Freshness",
    "Limits",
    "Prerequisites",
    "Local or network",
  ];

  it("Given 11 sections and the local-files table, When the rows are counted, Then each row appears in all 12", () => {
    for (const row of rows) {
      const count = doc.split("\n").filter((l) => l.startsWith(`| ${row} |`)).length;
      expect(count, row).toBe(12);
    }
  });

  it("Given the required topics, Then each has its own heading, in the requested order", () => {
    const order = [
      "## 1. Market and trade routes (UEX)",
      "## 2. Ships, items and lore (wikis)",
      "## 3. Missions (SCMDB)",
      "## 4. Crafting (SCMDB)",
      "## 5. Mining (SCMDB)",
      "## 6. Patches and patch notes",
      "## 7. Game log (Game.log)",
      "## 8. Your fleet",
      "## 9. Live telemetry",
      "## 10. Data freshness and source status",
      "## 11. MCP prompts",
      "## 12. Profiles, settings and local data files",
    ];
    const at = order.map((h) => doc.indexOf(`\n${h}\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("Given the telemetry section, Then it says off by default, two switches, and the balance is withheld", () => {
    const start = doc.indexOf("\n## 9. Live telemetry\n");
    const section = doc.slice(start, doc.indexOf("\n## 10."));
    expect(section).toMatch(/Off by default/);
    expect(section).toMatch(/two explicit switches/);
    expect(section).toMatch(/balance is withheld by default/);
    expect(section).toContain("TELEMETRY.md");
  });
});

describe("Feature: the links inside the guide lead somewhere", () => {
  it("Given a link to a heading of this page or of TELEMETRY.md, Then the heading exists", () => {
    const own = anchorsOf(doc);
    const telemetry = anchorsOf(read("docs/TELEMETRY.md"));
    const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      if (/^https?:/.test(link)) continue;
      const [file, anchor] = link.split("#");
      if (file)
        expect(fs.existsSync(new URL(`../../docs/${file}`, import.meta.url)), link).toBe(true);
      if (!anchor) continue;
      if (!file) expect(own.has(anchor), link).toBe(true);
      else if (file === "TELEMETRY.md") expect(telemetry.has(anchor), link).toBe(true);
    }
  });
});

describe("Feature: the guide stays within the rules for documentation", () => {
  it("Given the text, Then no invisible, bidi, tag or non-breaking character is present", () => {
    const bad = [...doc].filter((c) => {
      const cp = c.codePointAt(0) as number;
      return (
        (cp < 0x20 && c !== "\n") ||
        cp === 0x7f ||
        (cp >= 0x80 && cp <= 0xa0) ||
        cp === 0xad ||
        (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2060 && cp <= 0x2069) ||
        cp === 0xfeff ||
        (cp >= 0xe0000 && cp <= 0xe007f)
      );
    });
    expect(bad).toEqual([]);
  });

  it("Given the text, Then it is ASCII plus Latin letters only, so no word can mix scripts", () => {
    const odd = [...new Set([...doc].filter((c) => !/[\x20-\x7e\n]|[À-ÿ]/u.test(c)))];
    expect(odd).toEqual([]);
  });

  it("Given the text, Then it has no HTML comment and no HTML tag", () => {
    expect(doc).not.toContain("<!--");
    expect(doc).not.toMatch(/<\/?[A-Za-z]/);
  });

  it("Given absolute links, Then they only go to the allowed hosts", () => {
    const allowed = new Set([
      "github.com",
      "img.shields.io",
      "keepachangelog.com",
      "modelcontextprotocol.io",
      "semver.org",
      "star-citizen.wiki",
      "starcitizen.tools",
      "uexcorp.space",
    ]);
    const hosts = [...doc.matchAll(/https?:\/\/([^/\s)]+)/g)].map((m) => m[1]);
    expect(hosts.filter((h) => !allowed.has(h))).toEqual([]);
  });

  it("Given the telemetry wording, Then it never calls the feature safe, undetectable or approved", () => {
    expect(doc).not.toMatch(/\b(safe|safely|undetectable|approved)\b/i);
  });
});
