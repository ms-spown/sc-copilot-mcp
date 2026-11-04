import type { ToolMeta } from "../core/provenance.js";

/**
 * What each tool's data is and who may see the tool, declared in one place.
 *
 * `profiles` scope what is advertised (SCMCP_PROFILES). `core` is the everyday copilot set and
 * must stay under 15 tools INCLUDING the ones later milestones add; `sc_data_status` belongs
 * to every profile (the registry adds it regardless).
 */
export const PROFILE_NAMES = ["core", "trade", "data", "local"] as const;
export type Profile = (typeof PROFILE_NAMES)[number];

export interface CatalogEntry extends ToolMeta {
  profiles: Profile[];
}

const uex = { source: "uex", kind: "crowdsourced", trust: "structured", channel: "live" } as const;
const wiki = {
  source: "star-citizen.wiki",
  kind: "datamined",
  trust: "untrusted_text",
  channel: "live",
} as const;
const sct = {
  source: "starcitizen.tools",
  kind: "editorial",
  trust: "untrusted_text",
  channel: "live",
} as const;
// The dump repository is configurable (SCMCP_DATA_REPO) and is third-party: tag names, record
// names and every changed field value are its text, so these tools are untrusted_text. The
// guard test is dumps.behaviour.test.ts.
const dumps = {
  source: "sc-gamedata-dumps",
  kind: "datamined",
  trust: "untrusted_text",
  channel: "unknown",
} as const;
// SCMDB is a community-maintained repository: every string it returns (titles, descriptions,
// names, the maintainer's notes) is third-party text, so all its tools are untrusted_text. A
// test (scmdb.behaviour.test.ts) fails if a string from the data reaches a tool declared
// "structured".
const scmdb = {
  source: "scmdb",
  kind: "datamined",
  trust: "untrusted_text",
  channel: "live",
} as const;
const local = {
  source: "local-files",
  kind: "datamined",
  trust: "structured",
  channel: "unknown",
} as const;

const liveTelemetry = {
  source: "game telemetry (local, 127.0.0.1)",
  kind: "local_telemetry",
  trust: "structured",
  channel: "unknown",
} as const;

export const CATALOG: Record<string, CatalogEntry> = {
  sc_data_status: {
    source: "sc-copilot-mcp",
    kind: "computed",
    trust: "structured",
    channel: "unknown",
    profiles: ["core", "trade", "data", "local"],
  },

  uex_get_game_versions: { ...uex, profiles: ["core", "trade"] },
  uex_get_commodity_prices: {
    ...uex,
    trust: "untrusted_text",
    maxText: 200,
    profiles: ["core", "trade"],
  },
  uex_get_trade_routes: { ...uex, profiles: ["core", "trade"] },
  uex_get_ship_prices: {
    ...uex,
    trust: "untrusted_text",
    maxText: 200,
    profiles: ["core", "trade"],
  },
  // These return UEX's rows as they come (no projection): whatever text a row holds goes with it,
  // so they are untrusted_text. The guard test is untrusted.hardening.behaviour.test.ts.
  uex_get_commodities: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_get_commodity_averages: {
    ...uex,
    trust: "untrusted_text",
    maxText: 200,
    profiles: ["trade"],
  },
  uex_get_commodity_ranking: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_get_terminals: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_get_terminal_inventory: { ...uex, profiles: ["trade"] },
  scw_search_ships_by_vendor: { ...uex, profiles: ["trade"] },
  // Player-written ads: the only UEX tool whose text is not ours to trust.
  uex_search_marketplace: { ...uex, trust: "untrusted_text", profiles: ["trade"] },

  // Trade intelligence (uexIntel.ts). Names are cleaned labels and every figure is a number: structured. The
  // planner also reads the wiki ship sheet (quantum speed) when a ship is named; the answer says so.
  uex_get_price_history: { ...uex, profiles: ["trade"] },
  uex_get_market_status: { ...uex, profiles: ["trade"] },
  uex_plan_trade: { ...uex, kind: "computed", profiles: ["trade"] },
  // Refining, shop items and the player marketplace (uexCommerce.ts). They return UEX names (ores, terminals,
  // items, attributes) from player-driven data, so they are untrusted_text like the other row-returning UEX tools.
  uex_get_refining_margins: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_get_item_prices: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_compare_items: { ...uex, trust: "untrusted_text", maxText: 200, profiles: ["trade"] },
  uex_get_marketplace_prices: {
    ...uex,
    trust: "untrusted_text",
    maxText: 200,
    profiles: ["trade"],
  },

  scw_get_vehicle: { ...wiki, profiles: ["core"] },
  scw_get_item: { ...wiki, profiles: ["core"] },
  scw_list_vehicles: { ...wiki, profiles: ["data"] },
  scw_get_ship_comparison: { ...wiki, profiles: ["core"] },
  scw_search: { ...wiki, kind: "editorial", profiles: ["data"] },
  scw_list_items: { ...wiki, profiles: ["data"] },
  // The filter values are the wiki's own strings (manufacturers, roles, careers): short, but text.
  scw_get_filters: { ...wiki, maxText: 80, profiles: ["data"] },
  scw_snapshot_save: { ...wiki, source: "star-citizen.wiki + local snapshots", profiles: ["data"] },
  scw_snapshot_list: {
    ...wiki,
    source: "local snapshots",
    trust: "structured",
    profiles: ["data"],
  },
  scw_snapshot_diff: { ...wiki, source: "star-citizen.wiki + local snapshots", profiles: ["data"] },

  // A community transcription of the official notes; the official ones are on RSI's site, not read here.
  sc_patch_notes: { ...sct, maxText: 12_000, profiles: ["core", "data"] },
  sct_search: { ...sct, profiles: ["core"] },
  sct_get_article: { ...sct, maxText: 20_000, profiles: ["core"] },

  // Mission descriptions are cut at 300 characters by the query; titles and names are short.
  scmdb_search_missions: { ...scmdb, maxText: 400, profiles: ["core", "data"] },
  // The maintainer's own notes come with it (cut at 500 characters by the query).
  scmdb_changes: { ...scmdb, maxText: 600, profiles: ["core", "data"] },
  // Recipe lines, blueprint names and the titles of the missions that reward them.
  scmdb_search_crafting: { ...scmdb, maxText: 300, profiles: ["data"] },
  // Ore names and the equipment entries as the data gives them (not projected).
  scmdb_search_mining: { ...scmdb, maxText: 300, profiles: ["data"] },

  sc_list_builds: { ...dumps, profiles: ["data"] },
  sc_diff_versions: { ...dumps, profiles: ["data"] },
  // Names merged from several sources, some of them community-editable: short strings only.
  sc_get_vocabulary: {
    ...wiki,
    source: "uex + star-citizen.wiki + local-files",
    maxText: 80,
    profiles: ["data"],
  },

  // The player's own list, in a local file: nothing here comes from a website.
  sc_fleet_get: {
    source: "fleet file (local) + uex + star-citizen.wiki",
    kind: "user",
    // The wiki's role, career and error text come back with the player's own notes (up to 500 chars).
    trust: "untrusted_text",
    maxText: 500,
    channel: "unknown",
    profiles: ["core", "local"],
  },
  sc_fleet_upsert: {
    source: "fleet file (local)",
    kind: "user",
    trust: "structured",
    channel: "unknown",
    profiles: ["local"],
  },
  sc_fleet_remove: {
    source: "fleet file (local)",
    kind: "user",
    trust: "structured",
    channel: "unknown",
    profiles: ["local"],
  },

  sc_log_status: {
    source: "Game.log (local)",
    kind: "local_log",
    trust: "structured",
    channel: "unknown",
    profiles: ["local"],
  },
  // Contract titles, objectives and item names come out of the log: treat them as text.
  sc_log_recent_events: {
    source: "Game.log (local)",
    kind: "local_log",
    trust: "untrusted_text",
    channel: "unknown",
    profiles: ["local"],
  },

  sc_log_context: {
    source: "Game.log (local)",
    kind: "local_log",
    trust: "untrusted_text",
    channel: "unknown",
    profiles: ["local"],
  },
  // Shop names and item class names come out of the log, commodity names from the wiki's public
  // list: all text from elsewhere, so untrusted_text (cut at 400 characters).
  sc_trade_journal: {
    source: "Game.log (local) + star-citizen.wiki (commodity names)",
    kind: "local_log",
    trust: "untrusted_text",
    maxText: 400,
    channel: "unknown",
    profiles: ["local"],
  },
  sc_log_sessions: {
    source: "Game.log (local)",
    kind: "local_log",
    trust: "structured",
    channel: "unknown",
    profiles: ["local"],
  },

  // The game's own local telemetry stream: off by default, in memory only. Game identifiers, no
  // player-written text. The channel is unknown unless the handler reads it from Game.log.
  sc_live_status: { ...liveTelemetry, profiles: ["local"] },
  sc_live_state: { ...liveTelemetry, profiles: ["local"] },
  sc_live_events: { ...liveTelemetry, profiles: ["local"] },
  // The dashboard View (MCP App): same stream, same trust. Listed only with telemetry on and a client that renders Views.
  sc_live_dashboard: { ...liveTelemetry, profiles: ["local"] },
  sc_live_poll: { ...liveTelemetry, profiles: ["local"] },
  sc_live_mark: { ...liveTelemetry, profiles: ["local"] },
  // The commerce action bar of the View: UEX planner answers (names are cleaned and capped, never the balance), so it is
  // declared like uex_plan_trade. App-only, listed with the dashboard.
  sc_trade_suggest: {
    ...uex,
    kind: "computed",
    trust: "untrusted_text",
    maxText: 200,
    profiles: ["local"],
  },

  sc_local_datasets: { ...local, profiles: ["local"] },
  sc_search_local: { ...local, profiles: ["local"] },
  sc_read_local_collection: { ...local, profiles: ["local"] },
};
