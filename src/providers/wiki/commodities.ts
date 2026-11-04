import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { cleanLabel } from "../../core/untrusted.js";
import { SCW_MAX_PAGE_SIZE } from "./pagination.js";

/**
 * Commodity names by the game's resource GUID, from the Star Citizen Wiki's commodity list.
 *
 * The cargo kiosks in Game.log name a commodity only by `resourceGUID`. The wiki's
 * `/commodities` rows carry that same GUID as `uuid` (checked on six GUIDs from a real log;
 * for three of them the log's own hauling-contract names agree: Waste, Scrap, Stims).
 *
 * Privacy: the request is the WHOLE paginated list, identical for every user, so nothing from
 * the player's log is sent. Matching is done here, locally.
 */

const MAX_PAGES = 10;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommodityNames {
  /** GUID (lower case) to a cleaned name. Only the GUIDs asked for, and only those found. */
  names: Map<string, string>;
  /** Set when the list could not be read (the journal then says "unknown commodity"). */
  error: string | null;
  /** Oldest fetch time among the pages, epoch ms. */
  fetchedAt: number | null;
  stale: boolean;
}

export async function resolveCommodityNames(
  client: HttpClient,
  guids: string[],
): Promise<CommodityNames> {
  const wanted = new Set(guids.map((g) => g.toLowerCase()).filter((g) => GUID.test(g)));
  const out: CommodityNames = { names: new Map(), error: null, fetchedAt: null, stale: false };
  if (!wanted.size) return out;
  try {
    let page = 1;
    let last = 1;
    do {
      const r = await fetchWithCache(
        client,
        "/commodities",
        { params: { "page[number]": page, "page[size]": SCW_MAX_PAGE_SIZE } },
        { record: false },
      );
      const rows = r.data?.data;
      if (!Array.isArray(rows)) throw new Error("unexpected shape: no data array");
      out.fetchedAt = out.fetchedAt === null ? r.fetchedAt : Math.min(out.fetchedAt, r.fetchedAt);
      if (r.cache === "stale-disk") out.stale = true;
      for (const row of rows) {
        const uuid = typeof row?.uuid === "string" ? row.uuid.toLowerCase() : "";
        if (!wanted.has(uuid)) continue;
        const name = cleanLabel(row.name, 60);
        if (name) out.names.set(uuid, name);
      }
      const lp = r.data?.meta?.last_page;
      last = typeof lp === "number" ? Math.min(lp, MAX_PAGES) : page;
      page += 1;
    } while (page <= last && out.names.size < wanted.size);
  } catch (error) {
    out.error = error instanceof Error ? error.message.slice(0, 120) : "request failed";
  }
  return out;
}
