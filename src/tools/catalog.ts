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
const dumps = {
  source: "sc-gamedata-dumps",
  kind: "datamined",
  trust: "structured",
  channel: "unknown",
} as const;
const scmdb = {
  source: "scmdb",
  kind: "datamined",
  trust: "structured",
  channel: "live",
} as const;
const local = {
  source: "local-files",
  kind: "datamined",
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
  uex_get_commodity_prices: { ...uex, profiles: ["core", "trade"] },
  uex_get_trade_routes: { ...uex, profiles: ["core", "trade"] },
  uex_get_ship_prices: { ...uex, profiles: ["core", "trade"] },
  uex_get_commodities: { ...uex, profiles: ["trade"] },
  uex_get_commodity_averages: { ...uex, profiles: ["trade"] },
  uex_get_commodity_ranking: { ...uex, profiles: ["trade"] },
  uex_get_terminals: { ...uex, profiles: ["trade"] },
  uex_get_terminal_inventory: { ...uex, profiles: ["trade"] },
  scw_search_ships_by_vendor: { ...uex, profiles: ["trade"] },
  // Player-written ads: the only UEX tool whose text is not ours to trust.
  uex_search_marketplace: { ...uex, trust: "untrusted_text", profiles: ["trade"] },

  scw_get_vehicle: { ...wiki, profiles: ["core"] },
  scw_get_item: { ...wiki, profiles: ["core"] },
  scw_list_vehicles: { ...wiki, profiles: ["data"] },
  scw_get_ship_comparison: { ...wiki, profiles: ["core"] },
  scw_search: { ...wiki, kind: "editorial", profiles: ["core"] },
  scw_list_items: { ...wiki, profiles: ["data"] },
  scw_get_filters: { ...wiki, trust: "structured", profiles: ["data"] },
  scw_snapshot_save: { ...wiki, source: "star-citizen.wiki + local snapshots", profiles: ["data"] },
  scw_snapshot_list: {
    ...wiki,
    source: "local snapshots",
    trust: "structured",
    profiles: ["data"],
  },
  scw_snapshot_diff: { ...wiki, source: "star-citizen.wiki + local snapshots", profiles: ["data"] },

  sct_search: { ...sct, profiles: ["core"] },
  sct_get_article: { ...sct, maxText: 20_000, profiles: ["core"] },

  scmdb_search_missions: { ...scmdb, profiles: ["core", "data"] },
  // The maintainer's own notes come with it, hence untrusted text.
  scmdb_changes: { ...scmdb, trust: "untrusted_text", profiles: ["core", "data"] },
  scmdb_search_crafting: { ...scmdb, profiles: ["data"] },
  scmdb_search_mining: { ...scmdb, profiles: ["data"] },

  sc_list_builds: { ...dumps, profiles: ["data"] },
  sc_diff_versions: { ...dumps, profiles: ["data"] },
  // Names merged from several sources, some of them community-editable: short strings only.
  sc_get_vocabulary: {
    ...wiki,
    source: "uex + star-citizen.wiki + local-files",
    maxText: 80,
    profiles: ["data"],
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

  sc_local_datasets: { ...local, profiles: ["local"] },
  sc_search_local: { ...local, profiles: ["local"] },
  sc_read_local_collection: { ...local, profiles: ["local"] },
};
