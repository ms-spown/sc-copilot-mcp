import type { HttpClient } from "../core/http.js";
import { resolveCommodityNames } from "../providers/wiki/commodities.js";

/**
 * The names of the goods of the player's trade runs, for the dashboard: the game log names a good by its resource GUID only,
 * and the Star Citizen Wiki's public commodity list carries the same GUID (providers/wiki/commodities.ts, the lookup
 * `sc_trade_journal` already uses).
 *
 * Read this before changing anything:
 *  - The lookup NEVER runs in the poll's hot path. `current()` answers from memory at once; a GUID not yet known starts ONE
 *    background lookup (one at a time, never two in flight) and the next poll finds the name.
 *  - What is requested is the whole paginated list of the wiki (at most 10 pages, cached on disk and in memory by
 *    `fetchWithCache`), identical for every player: nothing from the player's log is sent, the matching is local. The
 *    client is the wiki's guarded one (allowed host only).
 *  - A GUID is looked for at most once every five minutes, found or not (an outage or an unknown good is not hammered), at
 *    most 16 GUIDs at a time, and at most 64 names are kept.
 *  - A name is third-party text: `resolveCommodityNames` cleans and caps it; it reaches the page as text only.
 */

export const COMMODITY_RETRY_MS = 5 * 60 * 1000;
export const COMMODITY_MAX_WANTED = 16;
export const COMMODITY_MAX_NAMES = 64;

export class CommodityNameResolver {
  private readonly names = new Map<string, string>();
  private readonly tried = new Map<string, number>();
  private job: Promise<void> | null = null;

  constructor(
    private readonly client: HttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The names known right now, by lower-case GUID. Synchronous. Starts the background lookup for the GUIDs asked for that
   * are neither known nor tried in the last five minutes.
   */
  current(guids: Iterable<string>): ReadonlyMap<string, string> {
    const at = this.now();
    const wanted: string[] = [];
    for (const g of guids) {
      if (typeof g !== "string") continue;
      const key = g.toLowerCase();
      if (this.names.has(key) || wanted.includes(key)) continue;
      const last = this.tried.get(key);
      if (last !== undefined && at - last < COMMODITY_RETRY_MS) continue;
      wanted.push(key);
      if (wanted.length >= COMMODITY_MAX_WANTED) break;
    }
    if (wanted.length > 0 && this.job === null) {
      for (const key of wanted) this.tried.set(key, at);
      if (this.tried.size > COMMODITY_MAX_NAMES * 2) {
        const oldest = [...this.tried.entries()].sort((a, b) => a[1] - b[1]);
        for (const [key] of oldest.slice(0, this.tried.size - COMMODITY_MAX_NAMES)) {
          this.tried.delete(key);
        }
      }
      const job: Promise<void> = this.lookup(wanted).finally(() => {
        this.job = null;
      });
      this.job = job;
    }
    return this.names;
  }

  /** Resolves when the lookup in flight has ended. For tests and for a clean stop. */
  async idle(): Promise<void> {
    while (this.job !== null) await this.job.catch(() => undefined);
  }

  private async lookup(guids: string[]): Promise<void> {
    const found = await resolveCommodityNames(this.client, guids);
    for (const [guid, name] of found.names) {
      if (this.names.size >= COMMODITY_MAX_NAMES) break;
      this.names.set(guid, name);
    }
  }
}
