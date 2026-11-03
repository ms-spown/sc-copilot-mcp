import { rowTimestamp } from "./freshness.js";
import { amount, label, toNumber, type Row } from "./normalize.js";
import { cycleSeconds, type TravelModel } from "./travel.js";
import type { Distance, DistanceBasis } from "./distances.js";

/**
 * Pure part of `uex_plan_trade`: from UEX price rows to ranked trade plans. No network, no clock
 * (the caller passes `now`), so every rule below is covered by a test.
 *
 * The price graph is `commodities_prices_all` (one call, about 2 600 rows). A row is a price a player
 * reported at a terminal for a commodity, at `date_modified`; old rows are NOT removed by UEX (the
 * oldest was 599 days old), so age is filtered here. The file does not say whether a price is a
 * player report or a UEX estimate: that is checked afterwards, for the plans that will be shown.
 */

export interface PriceRow {
  commodityId: number;
  terminalId: number;
  commodity: string;
  terminal: string;
  priceBuy: number;
  priceSell: number;
  /** SCU available to buy at the terminal. */
  scuBuy: number;
  /** SCU the terminal says it still wants to buy, when UEX gives it (0 = not given). */
  demandScu: number;
  statusBuy: number;
  statusSell: number;
  /** When a player last reported the price (epoch ms); null = UEX gives no date. */
  updatedAt: number | null;
}

export function parsePriceRows(rows: readonly Row[]): PriceRow[] {
  const out: PriceRow[] = [];
  for (const r of rows) {
    const commodityId = toNumber(r.id_commodity);
    const terminalId = toNumber(r.id_terminal);
    if (commodityId === undefined || terminalId === undefined) continue;
    out.push({
      commodityId,
      terminalId,
      commodity: label(r.commodity_name, 60) ?? `commodity ${commodityId}`,
      terminal: label(r.terminal_name, 80) ?? `terminal ${terminalId}`,
      priceBuy: amount(r.price_buy),
      priceSell: amount(r.price_sell),
      scuBuy: amount(r.scu_buy),
      demandScu: amount(r.scu_sell),
      statusBuy: amount(r.status_buy),
      statusSell: amount(r.status_sell),
      updatedAt: rowTimestamp(r),
    });
  }
  return out;
}

/** Can a player buy this at the terminal now? A price, some stock, and not "out of stock" (code 1). */
export const canBuy = (r: PriceRow): boolean => r.priceBuy > 0 && r.scuBuy > 0 && r.statusBuy !== 1;
/** Would the terminal pay for it? A price, and not "maximum inventory / no demand" (code 7). */
export const canSell = (r: PriceRow): boolean => r.priceSell > 0 && r.statusSell !== 7;

export interface Leg {
  commodityId: number;
  commodity: string;
  fromId: number;
  toId: number;
  from: string;
  to: string;
  buyPrice: number;
  sellPrice: number;
  profitPerScu: number;
  scu: number;
  cost: number;
  profit: number;
  /** SCU the destination says it wants, 0 when not given. */
  demandScu: number;
  buyUpdatedAt: number | null;
  sellUpdatedAt: number | null;
  /** Which end limited the quantity. */
  limitedBy: "cargo" | "budget" | "stock";
}

export interface LegOptions {
  cargoScu: number;
  budget?: number;
  now: number;
  maxAgeDays: number;
  includeStale: boolean;
  commodityId?: number;
}

export interface LegSet {
  /** The best leg (most profit for the cargo) for each ordered terminal pair `${from}>${to}`. */
  best: Map<string, Leg>;
  considered_buy_rows: number;
  considered_sell_rows: number;
  excluded_stale_rows: number;
  undated_rows: number;
}

const DAY_MS = 86_400_000;
export const pairKey = (from: number, to: number): string => `${from}>${to}`;

export function ageOk(
  r: PriceRow,
  o: Pick<LegOptions, "now" | "maxAgeDays" | "includeStale">,
): boolean {
  if (o.includeStale) return true;
  return r.updatedAt !== null && o.now - r.updatedAt <= o.maxAgeDays * DAY_MS;
}

export function buildLegs(rows: readonly PriceRow[], o: LegOptions): LegSet {
  const byCommodity = new Map<number, PriceRow[]>();
  const set: LegSet = {
    best: new Map(),
    considered_buy_rows: 0,
    considered_sell_rows: 0,
    excluded_stale_rows: 0,
    undated_rows: 0,
  };
  for (const r of rows) {
    if (o.commodityId !== undefined && r.commodityId !== o.commodityId) continue;
    if (!canBuy(r) && !canSell(r)) continue;
    if (r.updatedAt === null) set.undated_rows++;
    if (!ageOk(r, o)) {
      set.excluded_stale_rows++;
      continue;
    }
    const list = byCommodity.get(r.commodityId);
    if (list) list.push(r);
    else byCommodity.set(r.commodityId, [r]);
  }
  for (const list of byCommodity.values()) {
    const buys = list.filter(canBuy);
    const sells = list.filter(canSell);
    set.considered_buy_rows += buys.length;
    set.considered_sell_rows += sells.length;
    for (const a of buys) {
      for (const b of sells) {
        if (a.terminalId === b.terminalId) continue;
        const perScu = b.priceSell - a.priceBuy;
        if (perScu <= 0) continue;
        const caps: [number, Leg["limitedBy"]][] = [
          [o.cargoScu, "cargo"],
          [a.scuBuy, "stock"],
        ];
        if (o.budget !== undefined) caps.push([Math.floor(o.budget / a.priceBuy), "budget"]);
        const [scu, limitedBy] = caps.reduce((m, c) => (c[0] < m[0] ? c : m));
        if (scu < 1) continue;
        const key = pairKey(a.terminalId, b.terminalId);
        const profit = scu * perScu;
        const held = set.best.get(key);
        if (held && held.profit >= profit) continue;
        set.best.set(key, {
          commodityId: a.commodityId,
          commodity: a.commodity,
          fromId: a.terminalId,
          toId: b.terminalId,
          from: a.terminal,
          to: b.terminal,
          buyPrice: a.priceBuy,
          sellPrice: b.priceSell,
          profitPerScu: perScu,
          scu,
          cost: scu * a.priceBuy,
          profit,
          demandScu: b.demandScu,
          buyUpdatedAt: a.updatedAt,
          sellUpdatedAt: b.updatedAt,
          limitedBy,
        });
      }
    }
  }
  return set;
}

export type PlanMode = "one_way" | "round_trip" | "two_leg";

export interface Plan {
  mode: PlanMode;
  legs: Leg[];
  /** Distances (Gm) of the flights in one cycle, in order; a round trip includes the way back. */
  flightsGm: number[];
  distanceBasis: DistanceBasis[];
  stops: number;
  /** Terminals visited, in order (the start is not repeated at the end of a round trip). */
  stopIds: number[];
  returnsToStart: boolean;
  profit: number;
  cost: number;
  cycleSeconds: number | null;
  profitPerHour: number | null;
}

export type DistanceFn = (fromId: number, toId: number) => Distance;

interface Skipped {
  unknownDistance: number;
}

function finish(
  mode: PlanMode,
  legs: Leg[],
  flights: Extract<Distance, { kind: "known" }>[],
  stops: number,
  returnsToStart: boolean,
  model: TravelModel,
): Plan {
  const profit = legs.reduce((s, l) => s + l.profit, 0);
  const seconds = cycleSeconds(
    stops,
    flights.map((f) => f.gm),
    model,
  );
  return {
    mode,
    legs,
    flightsGm: flights.map((f) => f.gm),
    distanceBasis: flights.map((f) => f.basis),
    stops,
    stopIds: [legs[0].fromId, ...legs.map((l) => l.toId)].filter(
      (id, i, a) => !(returnsToStart && i === a.length - 1 && id === a[0]),
    ),
    returnsToStart,
    profit,
    cost: Math.max(...legs.map((l) => l.cost)),
    cycleSeconds: seconds,
    profitPerHour: seconds === null || seconds <= 0 ? null : (profit / seconds) * 3600,
  };
}

/** A plan ranks by profit per hour when the time is known, else by profit; the unknown-time plans go last. */
export function byValue(a: Plan, b: Plan): number {
  if (a.profitPerHour !== null && b.profitPerHour !== null)
    return b.profitPerHour - a.profitPerHour;
  if (a.profitPerHour !== null) return -1;
  if (b.profitPerHour !== null) return 1;
  return b.profit - a.profit;
}

export type Rank = (a: Plan, b: Plan) => number;

export interface PlanSearch {
  plans: Plan[];
  skipped: Skipped;
  /** How many candidate plans were scored before cutting to `pool`. */
  scored: number;
}

/**
 * Round trips A -> B -> A: the best commodity out and the best commodity back, then back at A.
 * Each pair is counted once (A -> B -> A and B -> A -> B are the same cycle).
 */
export function roundTrips(
  legs: LegSet,
  distance: DistanceFn,
  model: TravelModel,
  pool: number,
  startsAt: (terminalId: number) => boolean = () => true,
  rank: Rank = byValue,
): PlanSearch {
  const plans: Plan[] = [];
  const skipped: Skipped = { unknownDistance: 0 };
  let scored = 0;
  for (const out of legs.best.values()) {
    const back = legs.best.get(pairKey(out.toId, out.fromId));
    if (!back) continue;
    if (out.fromId > out.toId) continue;
    if (!startsAt(out.fromId) && !startsAt(out.toId)) continue;
    const d = distance(out.fromId, out.toId);
    if (d.kind === "unknown") {
      skipped.unknownDistance++;
      continue;
    }
    scored++;
    plans.push(finish("round_trip", [out, back], [d, d], 2, true, model));
  }
  plans.sort(rank);
  return { plans: plans.slice(0, pool), skipped, scored };
}

/** Two legs A -> B -> C (C is neither A nor B); the plan ends at C, it does not return. */
export function twoLegChains(
  legs: LegSet,
  distance: DistanceFn,
  model: TravelModel,
  pool: number,
  startsAt: (terminalId: number) => boolean = () => true,
  rank: Rank = byValue,
): PlanSearch {
  const outOf = new Map<number, Leg[]>();
  for (const l of legs.best.values()) {
    const list = outOf.get(l.fromId);
    if (list) list.push(l);
    else outOf.set(l.fromId, [l]);
  }
  const plans: Plan[] = [];
  const skipped: Skipped = { unknownDistance: 0 };
  let scored = 0;
  // Keep only the best `pool` while scanning: the full product can be large.
  const keep = () => {
    plans.sort(rank);
    plans.length = Math.min(plans.length, pool);
  };
  for (const first of legs.best.values()) {
    if (!startsAt(first.fromId)) continue;
    const next = outOf.get(first.toId);
    if (!next) continue;
    const d1 = distance(first.fromId, first.toId);
    if (d1.kind === "unknown") {
      skipped.unknownDistance++;
      continue;
    }
    for (const second of next) {
      if (second.toId === first.fromId || second.toId === first.toId) continue;
      const d2 = distance(second.fromId, second.toId);
      if (d2.kind === "unknown") {
        skipped.unknownDistance++;
        continue;
      }
      scored++;
      plans.push(finish("two_leg", [first, second], [d1, d2], 3, false, model));
      if (plans.length > pool * 8) keep();
    }
  }
  keep();
  return { plans, skipped, scored };
}

export interface RouteInput {
  /** The raw `commodities_routes` row. */
  row: Row;
  cargoScu?: number;
  budget?: number;
}

/**
 * Size one `commodities_routes` row for the cargo that fits, like `uex_get_trade_routes` does: the
 * quantity is the smallest of the hold, the route's reachable volume and what the budget buys.
 * Returns null when nothing can be hauled or the margin is not positive.
 */
export function routeLeg(i: RouteInput): Leg | null {
  const r = i.row;
  const buy = amount(r.price_origin);
  const sell = amount(r.price_destination);
  const perScu = sell - buy;
  const fromId = toNumber(r.id_terminal_origin);
  const toId = toNumber(r.id_terminal_destination);
  const commodityId = toNumber(r.id_commodity);
  if (
    buy <= 0 ||
    perScu <= 0 ||
    fromId === undefined ||
    toId === undefined ||
    commodityId === undefined
  ) {
    return null;
  }
  const caps: [number, Leg["limitedBy"]][] = [];
  if (i.cargoScu !== undefined) caps.push([i.cargoScu, "cargo"]);
  const reachable = toNumber(r.scu_reachable);
  if (reachable !== undefined) caps.push([reachable, "stock"]);
  if (i.budget !== undefined) caps.push([Math.floor(i.budget / buy), "budget"]);
  if (caps.length === 0) return null;
  const [scu, limitedBy] = caps.reduce((m, c) => (c[0] < m[0] ? c : m));
  if (scu < 1) return null;
  return {
    commodityId,
    commodity: label(r.commodity_name, 60) ?? `commodity ${commodityId}`,
    fromId,
    toId,
    from: label(r.origin_terminal_name, 80) ?? `terminal ${fromId}`,
    to: label(r.destination_terminal_name, 80) ?? `terminal ${toId}`,
    buyPrice: buy,
    sellPrice: sell,
    profitPerScu: perScu,
    scu,
    cost: scu * buy,
    profit: scu * perScu,
    demandScu: amount(r.scu_destination),
    buyUpdatedAt: null,
    sellUpdatedAt: null,
    limitedBy,
  };
}

/**
 * A one-way route repeated: stock up at A, sell at B, fly back empty to A. One cycle = a stop at each
 * end and two flights of the same length.
 */
export function oneWayPlan(
  leg: Leg,
  d: Extract<Distance, { kind: "known" }>,
  model: TravelModel,
): Plan {
  return finish("one_way", [leg], [d, d], 2, true, model);
}
