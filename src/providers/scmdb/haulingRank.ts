import {
  haulingRankIndex,
  type HaulingDataset,
  type HaulingTemplate,
  type PayoutTier,
} from "./hauling.js";

/**
 * `templates` mode of scmdb_rank_hauling: contract FAMILIES of the datamined hauling list, ranked for a ship.
 * Pure. A family is a group of templates that are identical in everything shown below (SCMDB repeats a
 * contract for several contractors or places); `variants` says how many were merged.
 *
 * Honest limits, all repeated in the answer:
 *  - the data holds ONE fixed reward and a SCU range: the reward per SCU is a range, never a point;
 *  - nothing here says what is on offer now, and no time is derived (no pickup or drop-off is known);
 *  - the container and hold checks are a rule of thumb (a ship whose largest container size is at least the
 *    contract's takes its boxes; one trip carries the SCU when it is at most the hold), not verified in game.
 */

export interface ShipFacts {
  name: string | null;
  hold_scu: number | null;
  /** Largest container size (SCU) the ship's grid takes, null when unknown. */
  max_container_size: number | null;
}

export type ContainerFit = "fits" | "too_big" | "unknown";
export type HoldFit = "one_trip" | "depends_on_roll" | "several_trips" | "unknown";

export interface Fit {
  container: ContainerFit;
  hold: HoldFit;
  /** Trips needed to move the whole quantity, as a range over the SCU range. */
  trips: { min: number; max: number } | null;
}

/** Does the cargo fit the ship? `needed` is the largest container the cargo can come in. */
export function fitFor(
  ship: ShipFacts | null,
  scu: { min: number; max: number } | null,
  needed: number | null,
): Fit {
  const container: ContainerFit =
    ship?.max_container_size == null || needed === null
      ? "unknown"
      : needed <= ship.max_container_size
        ? "fits"
        : "too_big";
  if (!ship || ship.hold_scu == null || ship.hold_scu < 1 || !scu || scu.max <= 0) {
    return { container, hold: "unknown", trips: null };
  }
  const hold = ship.hold_scu;
  const trips = { min: Math.ceil(scu.min / hold), max: Math.ceil(scu.max / hold) };
  const holdFit: HoldFit =
    scu.max <= hold ? "one_trip" : scu.min <= hold ? "depends_on_roll" : "several_trips";
  return { container, hold: holdFit, trips };
}

export type RankSort = "reward_per_scu" | "reward";

export interface RankQuery {
  ship: ShipFacts | null;
  /** The player's Hauling rank name; null = no rank filter. */
  rank: string | null;
  system: string | null;
  includeIllegal: boolean;
  /** Keep contracts whose containers are too big for the ship (flagged). */
  includeUnfit: boolean;
  sort: RankSort;
  limit: number;
}

export interface RankRow {
  id: string;
  variants: number;
  title: string | null;
  contractor: string | null;
  type: string;
  systems: string[];
  reward_auec: number | null;
  scu: { min: number; max: number; fixed: boolean; deduced_fixed_quantity: boolean } | null;
  reward_per_scu: { low: number; high: number } | null;
  commodities: string[];
  unknown_commodity_orders: number;
  orders: number;
  container_size_max: number | null;
  fit: Fit;
  rank: {
    required: string | null;
    max: string | null;
    scale: "hauling" | "other" | "none";
    check: "eligible" | "not_checked";
  };
  illegal: boolean | null;
  flags: string[];
  pickups: { count: number; sample: string[] };
  destinations: { count: number; sample: string[] };
  stops: { pickups: number | null; deliveries: number | null };
  partial_payout_index: number | null;
}

export interface RankResult {
  total_templates: number;
  total_families: number;
  matching_families: number;
  excluded: Record<string, number>;
  rows: RankRow[];
  payout_tables: Record<number, PayoutTier[]>;
  rank_applied: { name: string; index: number } | null;
  known_systems: string[];
}

export class RankQueryError extends Error {}

const HOLD_ORDER: Record<HoldFit, number> = {
  one_trip: 0,
  depends_on_roll: 1,
  several_trips: 2,
  unknown: 3,
};

/** Lower is more suitable: containers that fit before those that do not, then the fewest trips. */
const suitability = (fit: Fit): number =>
  (fit.container === "too_big" ? 10 : 0) + HOLD_ORDER[fit.hold];

const fingerprint = (t: HaulingTemplate): string =>
  JSON.stringify([
    t.title,
    t.contractor,
    t.mission_type,
    t.reward_auec,
    t.rank_min?.name ?? null,
    t.rank_min?.scope ?? null,
    t.rank_max?.name ?? null,
    t.illegal,
    t.scu,
    t.container_size_max,
    t.commodities,
    t.orders.length,
    t.systems,
    t.required_intros,
    t.is_intro,
    t.pickup_pool.count,
    t.destination_pool.count,
    t.once_only,
    t.has_personal_cooldown,
    t.partial_payout_index,
  ]);

interface Family {
  first: HaulingTemplate;
  variants: number;
}

function perScu(t: HaulingTemplate): RankRow["reward_per_scu"] {
  if (t.reward_auec === null || !t.scu || t.scu.min <= 0 || t.scu.max <= 0) return null;
  return {
    low: Math.round(t.reward_auec / t.scu.max),
    high: Math.round(t.reward_auec / t.scu.min),
  };
}

function rankView(t: HaulingTemplate, playerIndex: number | null): RankRow["rank"] {
  const min = t.rank_min;
  const scale = !min ? "none" : min.index === null ? "other" : "hauling";
  // Judged only when the gate is on the Hauling scale and a rank was given.
  let check: "eligible" | "not_checked" = "not_checked";
  if (playerIndex !== null && min && min.index !== null) check = "eligible";
  return { required: min?.name ?? null, max: t.rank_max?.name ?? null, scale, check };
}

export function rankHauling(dataset: HaulingDataset, q: RankQuery): RankResult {
  const knownSystems = [...new Set(dataset.templates.flatMap((t) => t.systems))].sort();
  let playerIndex: number | null = null;
  let rankApplied: RankResult["rank_applied"] = null;
  if (q.rank !== null) {
    playerIndex = haulingRankIndex(dataset, q.rank);
    if (playerIndex === null) {
      throw new RankQueryError(
        `No Hauling rank called "${q.rank.slice(0, 40)}" in the data. Ranks: ${dataset.rank_scale.map((r) => r.name).join(", ")}.`,
      );
    }
    rankApplied = {
      name: dataset.rank_scale.find((r) => r.index === playerIndex)?.name ?? q.rank,
      index: playerIndex,
    };
  }
  const systemWanted = q.system?.trim().toLowerCase() ?? null;
  if (systemWanted && !knownSystems.some((s) => s.toLowerCase() === systemWanted)) {
    throw new RankQueryError(
      `No hauling contract runs in "${(q.system ?? "").slice(0, 30)}". Systems in the data: ${knownSystems.join(", ")}.`,
    );
  }

  const excluded: Record<string, number> = {};
  const bump = (k: string) => {
    excluded[k] = (excluded[k] ?? 0) + 1;
  };

  const families = new Map<string, Family>();
  for (const t of dataset.templates) {
    const key = fingerprint(t);
    const f = families.get(key);
    if (f) f.variants++;
    else families.set(key, { first: t, variants: 1 });
  }

  const kept: { family: Family; row: RankRow }[] = [];
  for (const family of families.values()) {
    const t = family.first;
    if (t.illegal !== false && !q.includeIllegal) {
      // Unknown legality (null) is treated like illegal: it is not shown unless asked for.
      bump("illegal_or_unknown_legality");
      continue;
    }
    if (systemWanted && !t.systems.some((s) => s.toLowerCase() === systemWanted)) {
      bump("other_system");
      continue;
    }
    if (playerIndex !== null) {
      const min = t.rank_min?.index ?? null;
      const max = t.rank_max?.index ?? null;
      if (min !== null && playerIndex < min) {
        bump("rank_too_low");
        continue;
      }
      if (max !== null && playerIndex > max) {
        bump("rank_above_the_contract_maximum");
        continue;
      }
    }
    const fit = fitFor(q.ship, t.scu, t.container_size_max);
    if (fit.container === "too_big" && !q.includeUnfit) {
      bump("containers_too_big_for_the_ship");
      continue;
    }
    const flags: string[] = [];
    if (t.once_only) flags.push("once_only");
    if (t.has_personal_cooldown) flags.push("personal_cooldown");
    if (t.is_intro) flags.push("intro_contract");
    if (t.required_intros.length) flags.push(`needs_intro: ${t.required_intros[0]}`);
    if (t.scu_uses_deduction) flags.push("scu_fixed_quantity_is_deduced");
    if (t.scu === null) flags.push("scu_unknown");
    if (fit.container === "too_big") flags.push("containers_too_big_for_the_ship");
    kept.push({
      family,
      row: {
        id: t.id.slice(0, 8),
        variants: family.variants,
        title: t.title,
        contractor: t.contractor,
        type: t.mission_type,
        systems: t.systems,
        reward_auec: t.reward_auec,
        scu: t.scu
          ? {
              min: t.scu.min,
              max: t.scu.max,
              fixed: t.scu.min === t.scu.max,
              deduced_fixed_quantity: t.scu_uses_deduction,
            }
          : null,
        reward_per_scu: perScu(t),
        commodities: t.commodities.slice(0, 4),
        unknown_commodity_orders: t.orders.filter((o) => o.commodity === null).length,
        orders: t.orders.length,
        container_size_max: t.container_size_max,
        fit,
        rank: rankView(t, playerIndex),
        illegal: t.illegal,
        flags,
        pickups: { count: t.pickup_pool.count, sample: t.pickup_pool.sample.slice(0, 3) },
        destinations: {
          count: t.destination_pool.count,
          sample: t.destination_pool.sample.slice(0, 3),
        },
        stops: { pickups: t.pickup_count, deliveries: t.delivery_count },
        partial_payout_index: t.partial_payout_index,
      },
    });
  }

  const none = Number.NEGATIVE_INFINITY;
  kept.sort((a, b) => {
    const A = a.row;
    const B = b.row;
    // With a ship, suitability comes first: containers that fit, then fewer trips, then the chosen sort.
    const bySuitability = q.ship ? suitability(A.fit) - suitability(B.fit) : 0;
    if (bySuitability !== 0) return bySuitability;
    const byScu =
      (B.reward_per_scu?.low ?? none) - (A.reward_per_scu?.low ?? none) ||
      (B.reward_per_scu?.high ?? none) - (A.reward_per_scu?.high ?? none);
    const byReward = (B.reward_auec ?? none) - (A.reward_auec ?? none);
    const primary = q.sort === "reward" ? byReward || byScu : byScu || byReward;
    return (
      (Number.isNaN(primary) ? 0 : primary) ||
      (A.title ?? "").localeCompare(B.title ?? "") ||
      a.family.first.id.localeCompare(b.family.first.id)
    );
  });

  const rows = kept.slice(0, q.limit).map((k) => k.row);
  const payout: Record<number, PayoutTier[]> = {};
  for (const r of rows) {
    if (r.partial_payout_index !== null) {
      const table = dataset.partial_payout_tables[r.partial_payout_index];
      if (table) payout[r.partial_payout_index] = table;
    }
  }
  return {
    total_templates: dataset.templates.length,
    total_families: families.size,
    matching_families: kept.length,
    excluded,
    rows,
    payout_tables: payout,
    rank_applied: rankApplied,
    known_systems: knownSystems,
  };
}
