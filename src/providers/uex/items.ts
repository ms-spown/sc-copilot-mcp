import { fold, queryWords, searchByName } from "../scmdb/fuzzy.js";
import { compareVersions, rowUpdatedAt, versionParts } from "./freshness.js";
import { ageDays, placeOf, toNumber, toPrice, type Row } from "./rows.js";

/**
 * Shop items (ship components, weapons, armor, food...) from UEX: the catalogue (`items`), the
 * stats (`items_attributes`) and the shop prices (`items_prices`).
 *
 * `items_prices_all` is deliberately never used (see the tool file): it is 6.4 MB.
 * Item prices are shop prices that move rarely, but their rows can be months old: every row
 * carries its age and a stale flag, and the answer says so instead of passing them off as current.
 */

/** A shop price older than this is flagged stale. Item prices are slow-moving, so this is generous. */
export const ITEM_STALE_DAYS = 30;

/** Most categories one query may open (each is a 100-300 KB catalogue). */
export const MAX_CATEGORIES = 4;

export type CategoryMatch =
  | { kind: "ok"; categories: Row[] }
  | { kind: "too_many"; categories: Row[] }
  | { kind: "none"; suggestions: string[] };

/** Item categories (not services or contracts) from UEX's category list. */
export function itemCategories(categories: Row[]): Row[] {
  return categories.filter((c) => c.type === "item");
}

/**
 * "Quantum Drives", "quantum drive", "Guns", "Foods", or a whole section such as "Armor" (several
 * categories). Exact category name first, then the section name, then a partial match.
 */
export function matchCategories(categories: Row[], query: string): CategoryMatch {
  const q = fold(query);
  const all = itemCategories(categories);
  if (!q) return { kind: "none", suggestions: all.map((c) => String(c.name)) };
  const pick = (hits: Row[]): CategoryMatch | null =>
    hits.length === 0
      ? null
      : hits.length > MAX_CATEGORIES
        ? { kind: "too_many", categories: hits }
        : { kind: "ok", categories: hits };
  const exact = pick(all.filter((c) => fold(c.name) === q));
  if (exact) return exact;
  const section = pick(all.filter((c) => fold(c.section) === q));
  if (section) return section;
  const words = queryWords(query);
  const { hits } = searchByName(all, words, (c) => `${String(c.name)} ${String(c.section)}`);
  const partial = pick(hits);
  if (partial) return partial;
  return { kind: "none", suggestions: all.map((c) => String(c.name)) };
}

export interface ItemFilters {
  company?: string;
  size?: number;
}

/** Catalogue rows matching the typed name (every word), then company and size. Exact names come first. */
export function matchItems(
  items: Row[],
  name: string,
  filters: ItemFilters = {},
): { hits: Row[]; loose: boolean } {
  const words = queryWords(name);
  const { hits, loose } = searchByName(items, words, (i) => String(i.name ?? ""));
  const company = filters.company ? fold(filters.company) : "";
  const kept = hits.filter((i) => {
    if (company && !fold(i.company_name).includes(company)) return false;
    if (filters.size !== undefined && toNumber(i.size) !== filters.size) return false;
    return true;
  });
  const target = words.join(" ");
  kept.sort(
    (a, b) =>
      Number(fold(b.name) === target) - Number(fold(a.name) === target) ||
      String(a.name).localeCompare(String(b.name)) ||
      (toNumber(a.size) ?? 0) - (toNumber(b.size) ?? 0),
  );
  return { hits: kept, loose };
}

/** The catalogue facts worth showing for an item. */
export function itemView(i: Row) {
  return {
    id_item: i.id,
    name: i.name,
    category: i.category,
    section: i.section,
    company: i.company_name,
    size: toNumber(i.size) ?? i.size ?? null,
    game_version: i.game_version,
  };
}

export interface PriceRowView {
  terminal: unknown;
  location: string | null;
  price: number;
  updated_at: string | null;
  data_age_days: number | null;
  stale: boolean;
  game_version: unknown;
  older_than_live: boolean | null;
}

/** One shop price row: the price on the chosen side, its age, a stale flag and whether its game version is older than LIVE. */
export function priceRowView(
  r: Row,
  side: "price_buy" | "price_sell",
  now: number,
  live: unknown,
): PriceRowView | null {
  const price = toPrice(r[side]);
  if (price === null) return null;
  const age = ageDays(r.date_modified, now);
  const rowVersion = versionParts(r.game_version);
  const liveVersion = versionParts(live);
  return {
    terminal: r.terminal_name,
    location: placeOf(r),
    price,
    updated_at: rowUpdatedAt(r),
    data_age_days: age,
    stale: age === null || age > ITEM_STALE_DAYS,
    game_version: r.game_version ?? null,
    older_than_live:
      rowVersion && liveVersion ? compareVersions(rowVersion, liveVersion) < 0 : null,
  };
}

export interface PriceSummary {
  /** Where the item is for sale, cheapest first. */
  buy_locations: PriceRowView[];
  /** Where a terminal buys the item from the player, best price first. */
  sell_locations: PriceRowView[];
  buy_locations_total: number;
  sell_locations_total: number;
  cheapest: PriceRowView | null;
  /** The cheapest place whose price is not stale; null when every price is stale. */
  cheapest_not_stale: PriceRowView | null;
  stale_rows: number;
}

/** Price rows of one item: where to buy cheapest, where to sell, and what is stale. `star_system` keeps one system. */
export function summarisePrices(
  rows: Row[],
  now: number,
  live: unknown,
  top: number,
  starSystem?: string,
): { summary: PriceSummary; used: Row[] } {
  const wanted = starSystem?.trim().toLowerCase();
  const inSystem = rows.filter(
    (r) =>
      !wanted ||
      (typeof r.star_system_name === "string" && r.star_system_name.toLowerCase() === wanted),
  );
  const side = (field: "price_buy" | "price_sell", cheapestFirst: boolean) =>
    inSystem
      .map((r) => ({ r, v: priceRowView(r, field, now, live) }))
      .filter((x): x is { r: Row; v: PriceRowView } => x.v !== null)
      .sort((a, b) => (cheapestFirst ? a.v.price - b.v.price : b.v.price - a.v.price));
  const buy = side("price_buy", true);
  const sell = side("price_sell", false);
  const shownBuy = buy.slice(0, top);
  const shownSell = sell.slice(0, top);
  return {
    summary: {
      buy_locations: shownBuy.map((x) => x.v),
      sell_locations: shownSell.map((x) => x.v),
      buy_locations_total: buy.length,
      sell_locations_total: sell.length,
      cheapest: buy[0]?.v ?? null,
      cheapest_not_stale: buy.find((x) => !x.v.stale)?.v ?? null,
      stale_rows: [...buy, ...sell].filter((x) => x.v.stale).length,
    },
    used: [...shownBuy, ...shownSell].map((x) => x.r),
  };
}

export interface AttributeView {
  attribute: string;
  value: string | number | null;
  unit: string | null;
}

/** Stats of an item as UEX gives them: the value is a string; a numeric one becomes a number. */
export function attributeViews(rows: Row[]): AttributeView[] {
  return rows
    .filter((r) => typeof r.attribute_name === "string" && r.attribute_name)
    .map((r) => {
      const n = toNumber(r.value);
      const unit = typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : null;
      return {
        attribute: String(r.attribute_name),
        value: n ?? (typeof r.value === "string" && r.value ? r.value : null),
        unit,
      };
    });
}

export interface AttributeComparison {
  attribute: string;
  a: { value: string | number | null; unit: string | null } | null;
  b: { value: string | number | null; unit: string | null } | null;
  /** b minus a, only when both are numbers in the same unit. */
  difference: number | null;
  /** The difference as a percent of a, only when a is not 0. */
  difference_percent: number | null;
}

/** Side by side, in the order of the first item's attributes then the second's extras. No "better": UEX does not say which direction is better. */
export function compareAttributes(a: AttributeView[], b: AttributeView[]): AttributeComparison[] {
  const key = (x: AttributeView) => fold(x.attribute);
  const names = [...a, ...b].map(key).filter((k, i, arr) => arr.indexOf(k) === i);
  return names.map((k) => {
    const x = a.find((v) => key(v) === k);
    const y = b.find((v) => key(v) === k);
    const comparable =
      x && y && typeof x.value === "number" && typeof y.value === "number" && x.unit === y.unit;
    const diff = comparable ? (y.value as number) - (x.value as number) : null;
    return {
      attribute: (x ?? y)!.attribute,
      a: x ? { value: x.value, unit: x.unit } : null,
      b: y ? { value: y.value, unit: y.unit } : null,
      difference: diff === null ? null : Math.round(diff * 1000) / 1000,
      difference_percent:
        diff !== null && (x!.value as number) !== 0
          ? Math.round((diff / (x!.value as number)) * 1000) / 10
          : null,
    };
  });
}
