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

  it("Then README.fr.md and docs/USING_WITH_CLAUDE.fr.md keep tool/variable names intact and are linked", () => {
    const readmeEn = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const readmeFr = fs.readFileSync(new URL("../../README.fr.md", import.meta.url), "utf8");
    const claudeEn = fs.readFileSync(
      new URL("../../docs/USING_WITH_CLAUDE.md", import.meta.url),
      "utf8",
    );
    const claudeFr = fs.readFileSync(
      new URL("../../docs/USING_WITH_CLAUDE.fr.md", import.meta.url),
      "utf8",
    );

    expect(readmeEn).toContain("(README.fr.md)");
    expect(claudeEn).toContain("(USING_WITH_CLAUDE.fr.md)");
    expect(readmeFr).toContain("(docs/USING_WITH_CLAUDE.fr.md)");

    const missingInFr = tools
      .map((t) => t.name)
      .filter((name) => !readmeFr.includes(`\`${name}\``));
    expect(missingInFr).toEqual([]);

    for (const envVar of [
      "UEXTOKEN",
      "SCMCP_PROFILES",
      "SCMCP_TOOLS",
      "SC_INSTALL_DIR",
      "SC_GAME_LOG_PATH",
      "SCMCP_FLEET_FILE",
      "SCMCP_CACHE_DIR",
      "SCMCP_DATA_DIR",
      "SCMCP_CONFIG_DIR",
      "SCMCP_UEX_BASE_URL",
      "SCMCP_SCW_BASE_URL",
      "SCMCP_SCT_BASE_URL",
      "SCMCP_SCMDB_REPO",
      "SCMCP_DATA_REPO",
      "SCMCP_DATA_REPO_PATH",
      "SCMCP_GITHUB_TOKEN",
      "SCMCP_GAME_DATA_DIR",
    ]) {
      expect(readmeFr, envVar).toContain(`\`${envVar}\``);
    }

    for (const claudeTool of [
      "sc_data_status",
      "sc_fleet_get",
      "sc_fleet_upsert",
      "sc_fleet_remove",
      "uex_get_ship_prices",
      "scw_get_vehicle",
      "scw_get_ship_comparison",
      "uex_get_trade_routes",
      "uex_get_commodity_prices",
      "sc_patch_notes",
      "scmdb_changes",
      "scmdb_search_missions",
      "scmdb_search_crafting",
      "scmdb_search_mining",
      "sct_search",
      "sct_get_article",
      "scw_search",
      "sc_log_context",
      "sc_log_recent_events",
      "sc_log_sessions",
      "sc_log_status",
    ]) {
      expect(claudeFr, claudeTool).toContain(claudeTool);
    }
  });
});
