import { fold, queryWords, searchByName } from "../scmdb/fuzzy.js";
import { rowUpdatedAt } from "./freshness.js";
import { ageDays, median, placeOf, toNumber, toPrice, type Row } from "./rows.js";

/**
 * Refining, from what UEX really has: a yield BONUS per (ore, refinery) reported by players, the
 * refineries' "capacity" value, ratings (1 to 3) for the refining methods, and prices.
 *
 * What UEX does NOT have, and this module therefore never invents: the base ratio between the SCU
 * of ore and the SCU of refined product, the cost of a refining job in aUEC, a processing time in
 * minutes. So nothing here computes a profit. The output ranks refineries (by their yield bonus)
 * and ranks ores (by an index of refined value times yield, scaled so that the best is 100): a
 * comparison, not an amount of aUEC.
 */

/** A report older than this is flagged stale. Yield reports are 10 to 18 days old when UEX is healthy. */
export const REFINING_STALE_DAYS = 30;

/** Names listed per ore for the refineries tied at the best bonus (the answer must stay bounded). */
export const MAX_BEST_REFINERIES = 5;

export interface Ore {
  id: number;
  name: string;
  /** The commodity UEX links to as the refined product, when it can be found. */
  refined: Row | null;
  /** The newest yield report per refinery. */
  yields: Row[];
}

const idOf = (v: unknown): number | null => {
  const n = toNumber(v);
  return n === null ? null : n;
};

/** Keep, for each (ore, refinery) pair, the newest report: a pair should have one but the API does not promise it. */
export function newestPerPair(rows: Row[]): Row[] {
  const best = new Map<string, Row>();
  for (const r of rows) {
    const key = `${String(r.id_commodity)}/${String(r.id_terminal)}`;
    const kept = best.get(key);
    const t = (x: Row) => toNumber(x.date_modified) ?? 0;
    if (!kept || t(r) > t(kept)) best.set(key, r);
  }
  return [...best.values()];
}

/**
 * The refined product of an ore. UEX links the two through `id_parent`, but not always in both
 * directions (Taranite (Raw) has parent 0 while Taranite points at it), so both are tried. The
 * target must be marked refined: a parent of any other kind is not a refined product.
 */
export function refinedProductOf(oreId: number, commodities: Row[]): Row | null {
  const ore = commodities.find((c) => idOf(c.id) === oreId);
  const parentId = ore ? idOf(ore.id_parent) : null;
  const viaParent =
    parentId && parentId !== 0
      ? commodities.find((c) => idOf(c.id) === parentId && c.is_refined === 1)
      : undefined;
  if (viaParent) return viaParent;
  return commodities.find((c) => idOf(c.id_parent) === oreId && c.is_refined === 1) ?? null;
}

/** Group the yield reports by ore (one entry per ore that has at least one report). */
export function groupOres(yields: Row[], commodities: Row[]): Ore[] {
  const byOre = new Map<number, Row[]>();
  for (const r of newestPerPair(yields)) {
    const id = idOf(r.id_commodity);
    if (id === null || toNumber(r.value) === null) continue;
    byOre.set(id, [...(byOre.get(id) ?? []), r]);
  }
  return [...byOre.entries()].map(([id, rows]) => {
    const own = commodities.find((c) => idOf(c.id) === id);
    const name = String(own?.name ?? rows[0].commodity_name ?? `commodity ${id}`);
    return { id, name, refined: refinedProductOf(id, commodities), yields: rows };
  });
}

export type OreMatch =
  | { kind: "one"; ore: Ore; loose: boolean }
  | { kind: "several"; candidates: Ore[] }
  | { kind: "none"; suggestions: string[] };

/** "laranite" finds "Laranite (Raw)"; a close spelling is accepted when nothing matches exactly. */
export function matchOre(ores: Ore[], query: string): OreMatch {
  const words = queryWords(query);
  if (!words.length) return { kind: "none", suggestions: ores.map((o) => o.name).slice(0, 10) };
  const { hits, loose } = searchByName(ores, words, (o) => o.name);
  if (hits.length === 1) return { kind: "one", ore: hits[0], loose };
  if (hits.length > 1) {
    // "Gold" must not be ambiguous with "Gold (Ore)" alone: an exact folded name wins.
    const exact = hits.filter((o) => fold(o.name) === words.join(" "));
    if (exact.length === 1) return { kind: "one", ore: exact[0], loose };
    // The name without "(Raw)" / "(Ore)" is what players type.
    const bare = hits.filter((o) => fold(o.name.replace(/\((raw|ore)\)/i, "")) === words.join(" "));
    if (bare.length === 1) return { kind: "one", ore: bare[0], loose };
    return { kind: "several", candidates: hits };
  }
  return { kind: "none", suggestions: ores.map((o) => o.name).slice(0, 10) };
}

/** Refinery capacity by terminal id. The unit is not stated by UEX (its docs say "percentage", the values go to 1075). */
export function capacityByTerminal(capacities: Row[]): Map<number, Row> {
  const out = new Map<number, Row>();
  for (const c of capacities) {
    const id = idOf(c.id_terminal);
    if (id === null) continue;
    const kept = out.get(id);
    if (!kept || (toNumber(c.date_modified) ?? 0) > (toNumber(kept.date_modified) ?? 0))
      out.set(id, c);
  }
  return out;
}

export interface RefineryRow {
  rank: number;
  terminal: unknown;
  location: string | null;
  yield_bonus_percent: number;
  capacity_value_unit_unverified: number | null;
  updated_at: string | null;
  data_age_days: number | null;
  stale: boolean;
}

/** Refineries for one ore, best yield bonus first; equal bonuses share a rank and are ordered by name. */
export function rankRefineries(
  ore: Ore,
  capacities: Map<number, Row>,
  now: number,
  system?: string,
): { rows: RefineryRow[]; source: Row[] } {
  const wanted = system?.trim().toLowerCase();
  const kept = ore.yields
    .filter(
      (r) =>
        !wanted ||
        (typeof r.star_system_name === "string" && r.star_system_name.toLowerCase() === wanted),
    )
    .sort(
      (a, b) =>
        (toNumber(b.value) as number) - (toNumber(a.value) as number) ||
        String(a.terminal_name).localeCompare(String(b.terminal_name)),
    );
  const rows = kept.map((r) => {
    const value = toNumber(r.value) as number;
    const terminal = idOf(r.id_terminal);
    const cap = terminal === null ? undefined : capacities.get(terminal);
    const age = ageDays(r.date_modified, now);
    return {
      rank: 1 + kept.filter((o) => (toNumber(o.value) as number) > value).length,
      terminal: r.terminal_name,
      location: placeOf(r),
      yield_bonus_percent: value,
      capacity_value_unit_unverified: cap ? toNumber(cap.value) : null,
      updated_at: rowUpdatedAt(r),
      data_age_days: age,
      stale: age === null || age > REFINING_STALE_DAYS,
    };
  });
  return { rows, source: kept };
}

export interface OreSalePrices {
  terminals_with_a_price: number;
  lowest: number | null;
  median: number | null;
  highest: number | null;
  /** Prices at a refinery's ore-sales terminal often differ a lot (one ore, two price levels): they are listed, not averaged away. */
  best_terminals: {
    terminal: unknown;
    price_sell: number;
    updated_at: string | null;
    data_age_days: number | null;
    stale: boolean;
  }[];
  rows_older_than_days: { days: number; count: number };
  newest_update: string | null;
  oldest_update: string | null;
}

/** What players are paid for the ORE at refinery ore-sales terminals (commodities_raw_prices_all). Unit not stated by UEX. */
export function oreSalePrices(
  rawPrices: Row[],
  oreId: number,
  now: number,
  top = 3,
): OreSalePrices {
  const rows = rawPrices.filter(
    (r) => idOf(r.id_commodity) === oreId && toPrice(r.price_sell) !== null,
  );
  const prices = rows.map((r) => toPrice(r.price_sell) as number);
  const ages = rows.map((r) => ageDays(r.date_modified, now));
  const times = rows
    .map((r) => rowUpdatedAt(r))
    .filter((t): t is string => t !== null)
    .sort();
  return {
    terminals_with_a_price: rows.length,
    lowest: prices.length ? Math.min(...prices) : null,
    median: median(prices),
    highest: prices.length ? Math.max(...prices) : null,
    best_terminals: [...rows]
      .sort((a, b) => (toPrice(b.price_sell) as number) - (toPrice(a.price_sell) as number))
      .slice(0, top)
      .map((r) => {
        const age = ageDays(r.date_modified, now);
        return {
          terminal: r.terminal_name,
          price_sell: toPrice(r.price_sell) as number,
          updated_at: rowUpdatedAt(r),
          data_age_days: age,
          stale: age === null || age > REFINING_STALE_DAYS,
        };
      }),
    rows_older_than_days: {
      days: REFINING_STALE_DAYS,
      count: ages.filter((a) => a === null || a > REFINING_STALE_DAYS).length,
    },
    newest_update: times.length ? times[times.length - 1] : null,
    oldest_update: times.length ? times[0] : null,
  };
}

/** The refined product's reference sell price from UEX's commodity list (an average across terminals, undated). */
export function refinedReferencePrice(refined: Row | null): number | null {
  return refined ? toPrice(refined.price_sell) : null;
}

export interface OreRankRow {
  rank: number;
  ore: string;
  refined_product: string;
  refined_reference_sell_price: number;
  best_yield_bonus_percent: number;
  /** At most MAX_BEST_REFINERIES names; best_refineries_total says how many share the best bonus. */
  best_refineries: string[];
  best_refineries_total: number;
  value_index_best_is_100: number;
  ore_sale_median_unit_unverified: number | null;
  refineries_reporting: number;
  /** Fewer than 5 refineries reported this ore: its best yield rests on very few reports. */
  thin_data: boolean;
  /** The best bonus decides the rank, so the age of the report behind it is shown: the freshest one at that bonus. */
  best_report_updated_at: string | null;
  best_report_age_days: number | null;
  stale: boolean;
}

/**
 * Ores ranked by an INDEX: refined reference price times (1 + best yield bonus / 100), scaled so the
 * best is 100. It is not aUEC and not a margin: the base ratio between ore and refined SCU and the cost
 * of refining are unknown to UEX, and the ore's own sale price is a different unit. It only says which
 * ore is worth more once refined, at its best refinery, if the unknown ratio were the same for all.
 */
export function rankOres(
  ores: Ore[],
  rawPrices: Row[],
  now: number,
  system?: string,
): { ranked: OreRankRow[]; not_ranked: { ore: string; reason: string }[] } {
  const wanted = system?.trim().toLowerCase();
  const scored: (Omit<OreRankRow, "rank" | "value_index_best_is_100"> & { value: number })[] = [];
  const notRanked: { ore: string; reason: string }[] = [];
  for (const ore of ores) {
    const rows = ore.yields.filter(
      (r) =>
        !wanted ||
        (typeof r.star_system_name === "string" && r.star_system_name.toLowerCase() === wanted),
    );
    if (rows.length === 0) continue;
    const price = refinedReferencePrice(ore.refined);
    if (price === null) {
      notRanked.push({
        ore: ore.name,
        reason: ore.refined
          ? "UEX gives no sell price for its refined product"
          : "UEX does not link this ore to a refined product",
      });
      continue;
    }
    const best = Math.max(...rows.map((r) => toNumber(r.value) as number));
    const sales = oreSalePrices(rawPrices, ore.id, now).median;
    // The report(s) that decide the rank: the freshest among those at the best bonus.
    const deciding = rows
      .filter((r) => toNumber(r.value) === best)
      .sort((a, b) => (toNumber(b.date_modified) ?? 0) - (toNumber(a.date_modified) ?? 0))[0];
    const age = ageDays(deciding.date_modified, now);
    const atBest = rows
      .filter((r) => toNumber(r.value) === best)
      .map((r) => String(r.terminal_name))
      .sort();
    scored.push({
      ore: ore.name,
      refined_product: String(ore.refined?.name ?? ""),
      refined_reference_sell_price: price,
      best_yield_bonus_percent: best,
      best_refineries: atBest.slice(0, MAX_BEST_REFINERIES),
      best_refineries_total: atBest.length,
      ore_sale_median_unit_unverified: sales,
      refineries_reporting: rows.length,
      thin_data: rows.length < 5,
      best_report_updated_at: rowUpdatedAt(deciding),
      best_report_age_days: age,
      stale: age === null || age > REFINING_STALE_DAYS,
      value: price * (1 + best / 100),
    });
  }
  scored.sort((a, b) => b.value - a.value || a.ore.localeCompare(b.ore));
  const top = scored.length ? scored[0].value : 1;
  const ranked = scored.map(({ value, ...rest }, i) => ({
    rank: i + 1,
    ...rest,
    value_index_best_is_100: Math.round((value / top) * 1000) / 10,
  }));
  return { ranked, not_ranked: notRanked };
}

export interface MethodRow {
  method: string;
  code: unknown;
  yield_rating: number | null;
  cost_rating: number | null;
  speed_rating: number | null;
}

/** The refining methods with their 1 to 3 ratings, exactly as UEX gives them. */
export function methodRows(methods: Row[]): MethodRow[] {
  return methods.map((m) => ({
    method: String(m.name),
    code: m.code,
    yield_rating: toNumber(m.rating_yield),
    cost_rating: toNumber(m.rating_cost),
    speed_rating: toNumber(m.rating_speed),
  }));
}
