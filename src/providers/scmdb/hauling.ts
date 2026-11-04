/* eslint-disable @typescript-eslint/no-explicit-any --
   The SCMDB files are untyped JSON. store.ts checks the collections read elsewhere exist; this module reads the
   hauling fields defensively and returns a small, typed record: unknown stays null, never 0. */

import { stripTags } from "../../core/text.js";
import { cleanLabel } from "../../core/untrusted.js";

/**
 * Hauling contract TEMPLATES, extracted from SCMDB's `merged.contracts`. Pure: no network, no file.
 *
 * What SCMDB holds is the game's contract DEFINITIONS, not the offers on a player's mobiGlas: a pickup or a
 * destination is a pool of candidates and the game picks the concrete place when it offers the contract. So
 * nothing here says what is available now. Each field below is labelled by how sure it is:
 *
 *  - datamined: a field of the data, passed through (reward, rank, illegal flag, container size, pools);
 *  - deduced:   a reading of the data that is consistent with every description read but not documented
 *               (an order with `maxSCU` 0 and `minSCU` above 0 is a FIXED quantity of `minSCU`);
 *  - unknown:   null (a placeholder commodity, an order with no SCU, an availability pool that is empty).
 *
 * `timeToComplete` and the cooldown times have no stated unit: they are kept raw in the record, are never used
 * in a ranking and must never be turned into a rate.
 */

export class HaulingFormatError extends Error {}

export interface RankGate {
  name: string;
  /** Position on the Hauling reputation scale (0 = Trainee), null when the gate is on another scale. */
  index: number | null;
  scope: string | null;
  min_reputation: number | null;
}

export interface HaulingOrder {
  commodity: string | null;
  /** SCMDB names the resource a placeholder (the commodity is not known). */
  commodity_is_placeholder: boolean;
  min_scu: number | null;
  max_scu: number | null;
  /** range: minSCU and maxSCU both given; fixed_when_max_is_zero: DEDUCED; unknown: no SCU (null). */
  scu_rule: "range" | "fixed_when_max_is_zero" | "unknown";
  /** Largest cargo container (SCU) this order can come in. */
  max_container_size: number | null;
  /** Orders counted in items (no SCU). */
  items: { min: number | null; max: number | null } | null;
}

export interface PoolSummary {
  count: number;
  /** Place types in the pool (Star, Planet, Moon, Station, Destination, ...) with their counts. */
  types: Record<string, number>;
  sample: string[];
}

export interface PayoutTier {
  from_percent: number;
  to_percent: number;
  /** Share of the reward paid when the contract ends with that part done. */
  reward_multiplier: number;
}

export interface HaulingTemplate {
  id: string;
  debug_name: string | null;
  title: string | null;
  mission_type: string;
  contractor: string | null;
  category: string | null;
  systems: string[];
  illegal: boolean | null;
  rank_min: RankGate | null;
  rank_max: RankGate | null;
  is_intro: boolean;
  /** Titles of the contracts that must have been done first (an intro). */
  required_intros: string[];
  /** Highest crime stat the player may carry, null when the data sets none. */
  crime_stat_max: number | null;
  /** The reward in aUEC: one fixed number in the data, null when absent. */
  reward_auec: number | null;
  orders: HaulingOrder[];
  commodities: string[];
  /** Whole-contract SCU: the sums of the orders; null when any order has no SCU. */
  scu: { min: number; max: number } | null;
  /** True when at least one order uses the DEDUCED fixed-quantity rule. */
  scu_uses_deduction: boolean;
  container_size_max: number | null;
  pickup_count: number | null;
  delivery_count: number | null;
  pickup_pool: PoolSummary;
  destination_pool: PoolSummary;
  location_sets: number;
  /** Index of the partial-payout table (see HaulingDataset.partial_payout_tables), null when none. */
  partial_payout_index: number | null;
  once_only: boolean | null;
  has_personal_cooldown: boolean | null;
  can_be_shared: boolean | null;
  max_players_per_instance: number | null;
  /** Number of definitions SCMDB merged into this contract (same title, possibly other places). */
  merged_definitions: number;
  /** Raw, unit not stated by the source: display only. */
  time_to_complete_raw: number | null;
}

export interface HaulingDataset {
  /** The build the data was read at, as the merged file states it (for example "4.10.2-live.12913470"). */
  data_version: string | null;
  templates: HaulingTemplate[];
  rank_scale: { name: string; index: number; min_reputation: number | null }[];
  partial_payout_tables: Record<number, PayoutTier[]>;
  /** Whether the data says anything about how often a contract is offered. Today it does not. */
  availability_known: boolean;
  counts: {
    contracts_in_file: number;
    hauling: number;
    with_scu: number;
    with_scu_range: number;
    orders: number;
    orders_fixed_by_deduction: number;
    orders_unknown_commodity: number;
    illegal: number;
    requiring_intro: number;
  };
}

const PLACEHOLDER = /placeholder/i;
const MAX_POOL_SAMPLE = 4;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const posNum = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** Third-party text: tags removed, invisible characters out, one line, bounded. */
const text = (v: unknown, max: number): string | null =>
  typeof v === "string" ? cleanLabel(stripTags(v), max) : null;

const cache = new WeakMap<object, HaulingDataset>();

function summarisePool(ids: unknown, places: Record<string, any>): PoolSummary {
  const list = Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : [];
  const types: Record<string, number> = {};
  const sample: string[] = [];
  for (const id of list) {
    const p = places[id];
    const type = text(p?.type, 30) ?? "Unknown";
    types[type] = (types[type] ?? 0) + 1;
    const name = text(p?.name, 60);
    if (name && sample.length < MAX_POOL_SAMPLE && !sample.includes(name)) sample.push(name);
  }
  return { count: list.length, types, sample };
}

function gate(raw: any, scale: Map<string, number>, haulingScope: string | null): RankGate | null {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name, 40);
  if (!name) return null;
  const scope = text(raw.scopeName, 40);
  const onHauling = haulingScope !== null && scope === haulingScope;
  return {
    name,
    index: onHauling ? (scale.get(name.toLowerCase()) ?? null) : null,
    scope,
    min_reputation: num(raw.minReputation),
  };
}

function extractOrder(raw: any, resources: Record<string, any>): HaulingOrder {
  const rawName =
    typeof resources[raw?.resource]?.name === "string" ? resources[raw.resource].name : null;
  const placeholder = rawName !== null && PLACEHOLDER.test(rawName);
  const min = num(raw?.minSCU);
  const max = num(raw?.maxSCU);
  const hasAmount = raw?.minAmount !== undefined || raw?.maxAmount !== undefined;
  let minScu: number | null = null;
  let maxScu: number | null = null;
  let rule: HaulingOrder["scu_rule"] = "unknown";
  if (min !== null && max !== null && max > 0 && min >= 0 && min <= max) {
    minScu = min;
    maxScu = max;
    rule = "range";
  } else if (min !== null && min > 0 && (max === 0 || max === null)) {
    // maxSCU 0 with a minimum: read as a FIXED quantity. Not documented; consistent with every description read.
    minScu = min;
    maxScu = min;
    rule = "fixed_when_max_is_zero";
  }
  return {
    commodity: placeholder || rawName === null ? null : text(rawName, 60),
    commodity_is_placeholder: placeholder,
    min_scu: minScu,
    max_scu: maxScu,
    scu_rule: rule,
    max_container_size: posNum(raw?.maxContainerSize),
    items:
      hasAmount && rule === "unknown"
        ? { min: num(raw?.minAmount), max: num(raw?.maxAmount) }
        : null,
  };
}

function payoutTables(merged: any, used: Set<number>): Record<number, PayoutTier[]> {
  const pools: unknown[] = Array.isArray(merged.partialRewardPayoutPools)
    ? merged.partialRewardPayoutPools
    : [];
  const out: Record<number, PayoutTier[]> = {};
  for (const index of used) {
    const pool = pools[index];
    if (!Array.isArray(pool) || pool.length === 0) continue;
    const tiers: PayoutTier[] = [];
    for (const t of pool as any[]) {
      const from = num(t?.minPercentage);
      const to = num(t?.maxPercentage);
      const mult = num(t?.currencyRewardMultiplier);
      if (from !== null && to !== null && mult !== null) {
        tiers.push({ from_percent: from, to_percent: to, reward_multiplier: mult });
      }
    }
    if (tiers.length) out[index] = tiers;
  }
  return out;
}

/**
 * The hauling templates of a parsed `merged` file. Throws HaulingFormatError when the file has no hauling
 * contract or none with orders: an empty answer would hide a changed format.
 */
export function extractHauling(merged: any): HaulingDataset {
  const known = cache.get(merged);
  if (known) return known;

  const contracts: any[] = Array.isArray(merged?.contracts) ? merged.contracts : [];
  const hauling = contracts.filter(
    (c) => typeof c?.missionType === "string" && c.missionType.startsWith("Hauling"),
  );
  if (hauling.length === 0 || !hauling.some((c) => Array.isArray(c.haulingOrders))) {
    throw new HaulingFormatError(
      "SCMDB's contract list holds no hauling contract with orders (missionType starting with 'Hauling', field haulingOrders); the format may have changed.",
    );
  }

  const places: Record<string, any> = merged.locationPools ?? {};
  const resources: Record<string, any> = merged.resourcePools ?? {};

  // The Hauling reputation scale, from the data (never hard-coded).
  const scopes: any[] = Object.values(merged.scopes ?? {});
  const haulingScope = scopes.find((s) => s?.scopeName === "Hauling");
  const rankScale: HaulingDataset["rank_scale"] = (
    Array.isArray(haulingScope?.ranks) ? haulingScope.ranks : []
  )
    .map((r: any, i: number) => ({
      name: text(r?.name, 40) ?? "",
      index: num(r?.rankIndex) ?? i,
      min_reputation: num(r?.minReputation),
    }))
    .filter((r: { name: string }) => r.name)
    .sort((a: { index: number }, b: { index: number }) => a.index - b.index);
  const scale = new Map<string, number>(
    rankScale.map((r: { name: string; index: number }) => [r.name.toLowerCase(), r.index]),
  );
  const scopeName = haulingScope ? text(haulingScope.scopeName, 40) : null;

  const payoutUsed = new Set<number>();
  const counts = {
    contracts_in_file: contracts.length,
    hauling: hauling.length,
    with_scu: 0,
    with_scu_range: 0,
    orders: 0,
    orders_fixed_by_deduction: 0,
    orders_unknown_commodity: 0,
    illegal: 0,
    requiring_intro: 0,
  };

  const templates: HaulingTemplate[] = hauling.map((c) => {
    const orders: HaulingOrder[] = (Array.isArray(c.haulingOrders) ? c.haulingOrders : []).map(
      (o: any) => extractOrder(o, resources),
    );
    const allScu =
      orders.length > 0 && orders.every((o) => o.min_scu !== null && o.max_scu !== null);
    const scu = allScu
      ? {
          min: orders.reduce((s, o) => s + (o.min_scu as number), 0),
          max: orders.reduce((s, o) => s + (o.max_scu as number), 0),
        }
      : null;
    const containers = orders
      .map((o) => o.max_container_size)
      .filter((n): n is number => n !== null);
    const payout = num(c.partialRewardPayoutIndex);
    if (payout !== null && payout >= 0) payoutUsed.add(payout);
    const required: any[] = Array.isArray(c.requiredIntros) ? c.requiredIntros : [];
    const crime = c.prerequisites?.crimeStat;
    const reward = posNum(c.rewardUEC);

    counts.orders += orders.length;
    counts.orders_fixed_by_deduction += orders.filter(
      (o) => o.scu_rule === "fixed_when_max_is_zero",
    ).length;
    counts.orders_unknown_commodity += orders.filter((o) => o.commodity === null).length;
    if (scu) {
      counts.with_scu++;
      if (scu.min < scu.max) counts.with_scu_range++;
    }
    if (c.illegal === true) counts.illegal++;
    if (required.length > 0) counts.requiring_intro++;

    return {
      id: String(c.id),
      debug_name: text(c.debugName, 120),
      title: text(c.title, 120),
      mission_type: text(c.missionType, 40) ?? "Hauling",
      contractor: text(c.contractorName, 60),
      category: text(c.category, 30),
      systems: (Array.isArray(c.systems) ? c.systems : (c.availableSystems ?? []))
        .map((s: unknown) => text(s, 30))
        .filter((s: string | null): s is string => s !== null),
      illegal: bool(c.illegal),
      rank_min: gate(c.minStanding, scale, scopeName),
      rank_max: gate(c.maxStanding, scale, scopeName),
      is_intro: c.isIntro === true,
      required_intros: required
        .map((r) => text(r?.title, 60))
        .filter((t): t is string => t !== null)
        .slice(0, 3),
      crime_stat_max: num(crime?.max),
      reward_auec: reward,
      orders,
      commodities: [
        ...new Set(orders.map((o) => o.commodity).filter((n): n is string => n !== null)),
      ],
      scu,
      scu_uses_deduction: orders.some((o) => o.scu_rule === "fixed_when_max_is_zero"),
      container_size_max: containers.length ? Math.max(...containers) : null,
      pickup_count: posNum(c.pickupCount),
      delivery_count: posNum(c.deliveryCount),
      pickup_pool: summarisePool(c.locations, places),
      destination_pool: summarisePool(c.destinations, places),
      location_sets: Array.isArray(c.locationSets) ? c.locationSets.length : 0,
      partial_payout_index: payout !== null && payout >= 0 ? payout : null,
      once_only: bool(c.onceOnly),
      has_personal_cooldown: bool(c.hasPersonalCooldown),
      can_be_shared: bool(c.canBeShared),
      max_players_per_instance: posNum(c.maxPlayersPerInstance),
      merged_definitions: Array.isArray(c.contractDefinitionIds)
        ? Math.max(1, c.contractDefinitionIds.length)
        : 1,
      time_to_complete_raw: num(c.timeToComplete),
    };
  });

  const tables = payoutTables(merged, payoutUsed);
  // Drop the references to tables that are empty or missing: a template has a partial payout or says nothing.
  for (const t of templates) {
    if (t.partial_payout_index !== null && !tables[t.partial_payout_index]) {
      t.partial_payout_index = null;
    }
  }

  const availability: unknown[] = Array.isArray(merged.availabilityPools)
    ? merged.availabilityPools
    : [];
  const dataset: HaulingDataset = {
    data_version: text(merged.version, 80),
    templates,
    rank_scale: rankScale,
    partial_payout_tables: tables,
    availability_known: availability.some(
      (a) => a && typeof a === "object" && Object.keys(a as object).length > 0,
    ),
    counts,
  };
  cache.set(merged, dataset);
  return dataset;
}

/** The index of a Hauling rank by name (case does not matter); null when the scale has no such rank. */
export function haulingRankIndex(dataset: HaulingDataset, name: string): number | null {
  const wanted = name.trim().toLowerCase();
  return dataset.rank_scale.find((r) => r.name.toLowerCase() === wanted)?.index ?? null;
}
