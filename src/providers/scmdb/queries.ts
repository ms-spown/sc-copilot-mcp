/* eslint-disable @typescript-eslint/no-explicit-any --
   The SCMDB files are untyped JSON. store.ts checks the collections read here exist; these
   functions read fields defensively and return small, projected rows, never a whole file. */

/**
 * Targeted lookups over SCMDB data. Pure functions: they take parsed files and return rows
 * already cut to a size an answer can hold. Nothing here returns a file, or a long list.
 */

import { stripTags } from "../../core/text.js";

export const MAX_ROWS = 30;
export const DEFAULT_ROWS = 10;

const clampLimit = (limit: number | undefined, fallback = DEFAULT_ROWS) =>
  Math.min(Math.max(Math.floor(limit ?? fallback), 1), MAX_ROWS);

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
const tokens = (q?: string) => (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
/** Every word of the query must appear somewhere in the text. */
const matchesAll = (text: string, words: string[]) => words.every((w) => text.includes(w));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Game text carries markup such as <EM4>…</EM4>. */
const plain = (s: unknown, max = 300) => {
  const t = typeof s === "string" ? stripTags(s).replace(/\s+/g, " ").trim() : "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// ---------------------------------------------------------------- missions

export interface MissionQuery {
  query?: string;
  mission_type?: string;
  category?: string;
  faction?: string;
  location?: string;
  illegal?: boolean;
  min_reward?: number;
  reward_blueprint?: string;
  limit?: number;
}

interface MissionIndex {
  placeName: (id: string) => string;
  placeText: (id: string) => string;
  poolBlueprints: Map<string, string[]>;
}

const indexes = new WeakMap<object, MissionIndex>();

function missionIndex(merged: any): MissionIndex {
  const cached = indexes.get(merged);
  if (cached) return cached;
  const places: Record<string, any> = merged.locationPools ?? {};
  const pools: Record<string, any> = merged.blueprintPools ?? {};
  const poolBlueprints = new Map<string, string[]>();
  for (const [guid, pool] of Object.entries(pools)) {
    poolBlueprints.set(
      guid,
      (pool.blueprints ?? []).map((b: any) => b.name).filter((n: unknown) => typeof n === "string"),
    );
  }
  const index: MissionIndex = {
    placeName: (id) => places[id]?.name ?? id,
    placeText: (id) => {
      const p = places[id];
      return p ? [p.name, p.planet, p.moon, p.system].filter(Boolean).join(" ") : id;
    },
    poolBlueprints,
  };
  indexes.set(merged, index);
  return index;
}

function rewardBlueprintNames(c: any, ix: MissionIndex): string[] {
  const out: string[] = [];
  for (const r of c.blueprintRewards ?? [])
    out.push(...(ix.poolBlueprints.get(r.blueprintPool) ?? []));
  return out;
}

export function searchMissions(merged: any, q: MissionQuery) {
  const ix = missionIndex(merged);
  const words = tokens(q.query);
  const limit = clampLimit(q.limit);

  const hits = (merged.contracts as any[]).filter((c) => {
    if (q.mission_type && !lower(c.missionType).includes(q.mission_type.toLowerCase()))
      return false;
    if (q.category && lower(c.category) !== q.category.toLowerCase()) return false;
    if (q.faction && !lower(c.contractorName).includes(q.faction.toLowerCase())) return false;
    if (q.illegal !== undefined && Boolean(c.illegal) !== q.illegal) return false;
    if (q.min_reward !== undefined && num(c.rewardUEC) < q.min_reward) return false;

    const placeText = (c.locations ?? []).map(ix.placeText).join(" ").toLowerCase();
    const systems = (c.systems ?? c.availableSystems ?? []).join(" ").toLowerCase();
    if (q.location && !`${placeText} ${systems}`.includes(q.location.toLowerCase())) return false;

    const blueprints = rewardBlueprintNames(c, ix).join(" ").toLowerCase();
    if (q.reward_blueprint && !blueprints.includes(q.reward_blueprint.toLowerCase())) return false;

    if (words.length) {
      const hay =
        `${c.title} ${c.contractorName} ${c.missionType} ${c.category} ${placeText} ${systems} ${blueprints}`.toLowerCase();
      if (!matchesAll(hay, words)) return false;
    }
    return true;
  });

  hits.sort((a, b) => num(b.rewardUEC) - num(a.rewardUEC));

  const rows = hits.slice(0, limit).map((c) => {
    const places: string[] = (c.locations ?? []).map(ix.placeName);
    const blueprints = (c.blueprintRewards ?? []).map((r: any) => {
      const names = ix.poolBlueprints.get(r.blueprintPool) ?? [];
      return {
        chance: r.chance,
        trigger: r.trigger,
        count: names.length,
        sample: names.slice(0, 5),
      };
    });
    return {
      id: c.id,
      title: c.title,
      mission_type: c.missionType || null,
      category: c.category,
      contractor: c.contractorName,
      illegal: Boolean(c.illegal),
      reward_uec: c.rewardUEC ?? null,
      time_to_complete: c.timeToComplete ?? null,
      min_standing: c.minStanding?.name ?? null,
      systems: c.systems ?? c.availableSystems ?? [],
      locations: { count: places.length, sample: places.slice(0, 5) },
      ...(blueprints.length ? { blueprint_rewards: blueprints } : {}),
      description: plain(c.description),
    };
  });

  return {
    total_matches: hits.length,
    shown: rows.length,
    sorted_by: "reward_uec, descending",
    missions: rows,
  };
}

// ---------------------------------------------------------------- crafting

export interface CraftingQuery {
  query?: string;
  type?: string;
  uses_resource?: string;
  include_sources?: boolean;
  limit?: number;
}

function recipeLines(bp: any) {
  const tier = bp.tiers?.[0];
  return (tier?.slots ?? []).map((slot: any) => ({
    slot: slot.name,
    needs: (slot.options ?? []).map((o: any) => {
      const what = o.resourceName ?? o.itemName ?? o.type;
      const quality = num(o.minQuality) > 0 ? ` (quality ≥ ${o.minQuality})` : "";
      return `${o.quantity ?? 1}× ${what}${quality}`;
    }),
  }));
}

/** Mission titles that can reward each blueprint, from the missions file. */
function sourcesByBlueprint(merged: any): Map<string, string[]> {
  const poolIndex = new Map<string, Set<string>>(); // pool guid -> blueprint record ids and names
  for (const [guid, pool] of Object.entries<any>(merged.blueprintPools ?? {})) {
    const keys = new Set<string>();
    for (const b of pool.blueprints ?? []) {
      if (b.blueprintRecord) keys.add(b.blueprintRecord);
      if (b.name) keys.add(lower(b.name));
    }
    poolIndex.set(guid, keys);
  }
  const bySource = new Map<string, string[]>();
  for (const c of merged.contracts as any[]) {
    for (const r of c.blueprintRewards ?? []) {
      for (const key of poolIndex.get(r.blueprintPool) ?? []) {
        const list = bySource.get(key) ?? [];
        if (list.length < 200 && !list.includes(c.title)) list.push(c.title);
        bySource.set(key, list);
      }
    }
  }
  return bySource;
}

export function searchCrafting(blueprintsFile: any, merged: any | null, q: CraftingQuery) {
  const words = tokens(q.query);
  const limit = clampLimit(q.limit);
  const res = q.uses_resource?.toLowerCase();

  const hits = (blueprintsFile.blueprints as any[]).filter((bp) => {
    if (
      q.type &&
      !lower(bp.type).includes(q.type.toLowerCase()) &&
      !lower(bp.gear).includes(q.type.toLowerCase())
    ) {
      return false;
    }
    if (res) {
      const used = (bp.tiers ?? [])
        .flatMap((t: any) => t.slots ?? [])
        .flatMap((s: any) => s.options ?? [])
        .some((o: any) => lower(o.resourceName ?? o.itemName).includes(res));
      if (!used) return false;
    }
    if (words.length) {
      const hay =
        `${bp.productName} ${bp.tag} ${bp.type} ${bp.subtype} ${bp.gear} ${bp.manufacturer}`.toLowerCase();
      if (!matchesAll(hay, words)) return false;
    }
    return true;
  });

  const sources = q.include_sources !== false && merged ? sourcesByBlueprint(merged) : null;
  const rows = hits.slice(0, limit).map((bp) => {
    const titles = sources
      ? (sources.get(bp.guid) ?? sources.get(lower(bp.productName)) ?? [])
      : null;
    return {
      name: bp.productName ?? bp.tag,
      type: bp.type || null,
      subtype: bp.subtype || null,
      gear: bp.gear || null,
      manufacturer: bp.manufacturer || null,
      craft_time_seconds: bp.tiers?.[0]?.craftTimeSeconds ?? null,
      quality_tiers: (bp.tiers ?? []).length,
      recipe: recipeLines(bp),
      ...(titles
        ? { rewarded_by_missions: { count: titles.length, sample: titles.slice(0, 5) } }
        : {}),
    };
  });

  return { total_matches: hits.length, shown: rows.length, blueprints: rows };
}

// ---------------------------------------------------------------- mining

export interface MiningQuery {
  query?: string;
  scope?: "ores" | "equipment" | "all";
  limit?: number;
}

/** Where an ore can spawn, ranked by how much of a location's deposit weight points to it. */
function oreLocations(mining: any, oreGuid: string, oreName: string) {
  const compositions: Record<string, any> = mining.compositions ?? {};
  const results: { location: string; system: string; type: string; relative_share: number }[] = [];
  for (const loc of mining.locations as any[]) {
    let share = 0;
    for (const group of loc.groups ?? []) {
      const total = (group.deposits ?? []).reduce(
        (s: number, d: any) => s + num(d.relativeProbability),
        0,
      );
      if (!total) continue;
      for (const d of group.deposits ?? []) {
        const part = (compositions[d.compositionGuid]?.parts ?? []).find(
          (p: any) => p.elementGuid === oreGuid || lower(p.elementName) === lower(oreName),
        );
        if (part)
          share +=
            num(group.groupProbability) *
            (num(d.relativeProbability) / total) *
            num(part.probability);
      }
    }
    if (share > 0) {
      results.push({
        location: loc.locationName,
        system: loc.system,
        type: loc.locationType,
        relative_share: Math.round(share * 1000) / 1000,
      });
    }
  }
  return results.sort((a, b) => b.relative_share - a.relative_share);
}

export function searchMining(mining: any, equipment: any, q: MiningQuery) {
  const words = tokens(q.query);
  const scope = q.scope ?? "all";
  const limit = clampLimit(q.limit, 8);
  const out: Record<string, unknown> = {};

  if (scope === "ores" || scope === "all") {
    const hits = Object.entries<any>(mining.mineableElements).filter(([, e]) =>
      matchesAll(`${e.name} ${e.materialName ?? ""} ${e.rarity ?? ""}`.toLowerCase(), words),
    );
    out.ores = {
      total_matches: hits.length,
      rows: hits.slice(0, limit).map(([guid, e]) => ({
        name: e.name,
        rarity: e.rarity ?? null,
        instability: e.instability,
        resistance: e.resistance,
        density: e.density,
        cluster_factor: e.clusterFactor,
        scan_signature: e.scanSignature ?? null,
        ground_scan_signature: e.groundScanSignature ?? null,
        optimal_window: {
          midpoint: e.optimalWindowMidpoint,
          randomness: e.optimalWindowRandomness,
          thinness: e.optimalWindowThinness,
        },
        explosion_multiplier: e.explosionMultiplier,
        // Only for a specific search: ranking every ore's locations is not an answer.
        ...(words.length && hits.length <= 3
          ? { found_at: oreLocations(mining, guid, e.materialName ?? e.name).slice(0, 8) }
          : {}),
      })),
    };
  }

  if ((scope === "equipment" || scope === "all") && equipment) {
    const pick = (list: any[]) =>
      list
        .filter((e) => matchesAll(`${e.name} ${e.manufacturer ?? ""}`.toLowerCase(), words))
        .slice(0, limit);
    out.lasers = pick(equipment.lasers ?? []);
    out.modules = pick(equipment.modules ?? []);
    out.gadgets = pick(equipment.gadgets ?? []);
  }

  out.note =
    "relative_share compares locations for the same ore (weights from the game data); it is not a spawn probability. Instability, resistance and the optimal window are the values to read on the scanner.";
  return out;
}

// ---------------------------------------------------------------- changes

const label = (x: unknown): string => {
  if (typeof x === "string") return x;
  const o = x as any;
  return String(o?.title ?? o?.name ?? o?.productName ?? o?.id ?? JSON.stringify(x).slice(0, 60));
};

const section = (s: any, limit: number) => {
  if (!s || typeof s !== "object") return undefined;
  const added: unknown[] = s.added ?? [];
  const removed: unknown[] = s.removed ?? [];
  const changed: unknown[] = s.changed ?? [];
  return {
    added: { count: added.length, sample: added.slice(0, limit).map(label) },
    removed: { count: removed.length, sample: removed.slice(0, limit).map(label) },
    changed: {
      count: changed.length,
      sample: changed.slice(0, limit).map((c: any) => ({
        name: label(c),
        what:
          c?.changes && typeof c.changes === "object"
            ? Object.keys(c.changes).slice(0, 6)
            : undefined,
      })),
    },
  };
};

export interface ChangesQuery {
  /** Pick the update ending at a build whose name contains this text. Default: the newest. */
  to?: string;
  limit?: number;
}

export function summarizeChanges(deltas: any, changelog: any[] | null, q: ChangesQuery) {
  const limit = clampLimit(q.limit, 8);
  const pairs = [...deltas.pairs].sort((a: any, b: any) =>
    String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
  );
  // Without 'to', show the newest update that changed any data: a build bump with no data
  // change would answer "nothing" to a question about what is new.
  const pair = q.to
    ? pairs.find((p: any) => String(p.to).toLowerCase().includes(q.to!.toLowerCase()))
    : (pairs.find((p: any) => num(p.total) > 0) ?? pairs[0]);
  const skipped = q.to ? [] : pairs.slice(0, Math.max(pairs.indexOf(pair), 0));
  if (!pair) {
    throw new Error(
      `No update ends at a build matching "${q.to}". Available: ${pairs
        .slice(0, 8)
        .map((p: any) => p.to)
        .join(", ")}.`,
    );
  }

  const sections: Record<string, unknown> = {};
  for (const name of [
    "missions",
    "blueprints",
    "blueprintPools",
    "items",
    "resources",
    "scopes",
    "eventScopes",
  ]) {
    const s = section(pair[name], limit);
    if (s && (s.added.count || s.removed.count || s.changed.count)) sections[name] = s;
  }

  const notes = (changelog ?? [])
    .filter((e: any) => (e.changes ?? []).some((c: any) => c.type === "data"))
    .slice(0, 3)
    .map((e: any) => ({
      version: e.version,
      date: e.date,
      data_notes: (e.changes ?? [])
        .filter((c: any) => c.type === "data")
        .map((c: any) => plain(c.text, 500)),
    }));

  return {
    from: pair.from,
    to: pair.to,
    timestamp: pair.timestamp,
    total_changes: pair.total,
    ...(skipped.length
      ? {
          note: `Newer builds with no data change were skipped: ${skipped.map((p: any) => p.to).join(", ")}.`,
        }
      : {}),
    sections,
    other_updates_available: pairs
      .filter((p: any) => p !== pair)
      .slice(0, 6)
      .map((p: any) => `${p.from} -> ${p.to}`),
    recent_site_notes: notes,
  };
}
