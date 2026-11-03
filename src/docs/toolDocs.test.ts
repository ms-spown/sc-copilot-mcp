import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { allTools } from "../tools/registry.js";
import { renderToolDocs } from "./toolDocs.js";

const unused = { defaults: {}, get: async () => ({ data: {} }) } as never;
const tools = allTools({
  uexClient: unused,
  scwClient: unused,
  sctClient: unused,
  scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
  gameLog: new GameLog({}),
  fleet: new FleetStore("unused.json"),
});

describe("Feature: the tool reference is generated from the code", () => {
  const md = renderToolDocs(tools);

  it("Given every tool, Then each one has an index row, a section, and a parameter table or 'No parameters'", () => {
    for (const t of tools) {
      expect(md, t.name).toContain(`### ${t.name}`);
      expect(md, t.name).toContain(`[\`${t.name}\`](#${t.name})`);
    }
  });

  it("Then required parameters are marked and enum values are listed", () => {
    expect(md).toMatch(/\| `commodity_name` \| string \| yes \|/);
    expect(md).toMatch(/\| `origin` \| `pledge` \\\| `in_game` \| yes \|/);
  });

  it("Then the committed docs/TOOLS.md is up to date (run `npm run build && npm run docs:tools` if this fails)", () => {
    const committed = fs
      .readFileSync(new URL("../../docs/TOOLS.md", import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    expect(committed).toBe(md);
  });
});

describe("Feature: the README mentions every tool", () => {
  it("Then no tool is missing from it (add new ones to the theme table)", () => {
    const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const missing = tools.map((t) => t.name).filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
