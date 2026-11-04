import { buildPlaceIndex, resolvePlace, words, type PlaceMatch } from "./haulingPlaces.js";
import { isRow, label, toNumber, type Row } from "./normalize.js";
import type { PlaceIndex as TerminalIndex } from "./places.js";

/**
 * Where the player is, as UEX can place it: ONE orbit (UEX distances are indexed by orbit) and, in it, the terminals of the place he named.
 * Pure over the rows of UEX `/terminals` and the places index of the planner.
 *
 * Two ways in, neither a guess:
 *  - TEXT: a name the player typed or that a plan holds ("Lorville", "Area18 TDD"): the place resolver of the hauling tools
 *    (exact name first, then the query's words inside a longer name). One orbit, else it is ambiguous or unknown.
 *  - LOG TOKEN: the place token of the game log ("Stanton1_Lorville", "OOC_Stanton_1_Hurston", "NewBabbage"). Each segment is tried as
 *    a place name (also with its camel-case and digit boundaries opened: "NewBabbage" is "New Babbage", "Area18" is "Area 18"),
 *    EXACT matches only; a segment that names a star system, a number or nothing is ignored. It resolves only when the segments
 *    that match all point at one orbit; among them the most specific wins (a city beats the orbit it stands in). A token that
 *    matches nothing is NOT a position.
 * Never a coordinate: the game log and the telemetry hold none.
 */

export type PositionRequest = { text: string } | { token: string };

export type PositionResult =
  | {
      ok: true;
      /** The place as UEX names it: the city, station or outpost, or the orbit's own name for an orbit-level name. */
      label: string;
      system: number;
      orbit: number;
      /**
       * The terminals of the place he named (a city, a station, an outpost), NOT of its whole orbit: he is at those and can buy
       * there. The rest of the orbit is a short local flight away (distances are orbit-level). An orbit-level name (a moon, a
       * planet) is the whole orbit.
       */
      terminalIds: number[];
      basis: "exact" | "partial";
    }
  | { ok: false; reason: "unknown" | "ambiguous" | "no_orbit"; suggestions: string[] };

const PLACE_FIELDS = ["space_station_name", "outpost_name", "city_name", "poi_name"] as const;
const SHOP_FIELDS = ["name", "nickname", "displayname", "fullname"] as const;
const normOf = (v: unknown): string => words(v).join(" ");

/** "NewBabbage" -> "New Babbage", "Area18" -> "Area 18": the game's tokens write names without the spaces UEX has. */
function opened(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
}
const variantsOf = (s: string): string[] => [...new Set([s, opened(s)])];

interface Located {
  label: string;
  ids: number[];
  /** place: a city, station or outpost; orbit: the orbit's own name; wide: nothing narrower could be found. */
  level: "place" | "orbit" | "wide";
}

/**
 * The terminals the name stands for inside its orbit. An exact name of a city, station, outpost or shop first (the place those
 * terminals belong to), then the orbit's own name (a moon or planet: the whole orbit, labelled with that name), then the query's
 * words inside a longer name. Nothing found: the whole orbit.
 */
function locate(
  rows: readonly unknown[],
  inOrbit: readonly number[],
  system: number,
  orbit: number,
  q: string,
  fallbackLabel: string,
): Located {
  const orbitSet = new Set(inOrbit);
  const sameOrbit = rows.filter((r): r is Row => {
    if (!isRow(r)) return false;
    const id = toNumber(r.id);
    return (
      id !== undefined &&
      orbitSet.has(id) &&
      toNumber(r.id_star_system) === system &&
      (toNumber(r.id_orbit) ?? 0) === orbit
    );
  });
  const placeKey = (r: Row): string => {
    for (const f of PLACE_FIELDS) {
      const k = normOf(r[f]);
      if (k) return k;
    }
    return "";
  };
  const placeName = (r: Row): string => {
    for (const f of PLACE_FIELDS) {
      const l = label(r[f], 60);
      if (l) return l;
    }
    return label(r.name, 60) ?? fallbackLabel;
  };
  const keysOf = (r: Row): string[] =>
    [...PLACE_FIELDS, ...SHOP_FIELDS].map((f) => normOf(r[f])).filter((k) => k !== "");
  const own = (matched: Row[]): number[] => {
    const keys = new Set(matched.map(placeKey).filter((k) => k !== ""));
    const ids = new Set<number>();
    for (const r of matched) if (placeKey(r) === "") ids.add(toNumber(r.id) as number);
    for (const r of sameOrbit) if (keys.has(placeKey(r))) ids.add(toNumber(r.id) as number);
    return inOrbit.filter((id) => ids.has(id));
  };
  const exact = sameOrbit.filter((r) => keysOf(r).includes(q));
  if (exact.length > 0) {
    const ids = own(exact);
    return {
      label: placeName(exact[0]!),
      ids: ids.length > 0 ? ids : [...inOrbit],
      level: "place",
    };
  }
  // The orbit's own name (a moon, a planet): every terminal of the orbit, named by that name, never by the first city in it.
  const orbitNamed = sameOrbit.filter((r) => normOf(r.orbit_name) === q);
  if (orbitNamed.length > 0) {
    return {
      label: label(orbitNamed[0]!.orbit_name, 60) ?? fallbackLabel,
      ids: [...inOrbit],
      level: "orbit",
    };
  }
  const qWords = q.split(" ").filter(Boolean);
  const partial =
    qWords.length === 0
      ? []
      : sameOrbit.filter((r) =>
          keysOf(r).some((k) => qWords.every((w) => k.split(" ").includes(w))),
        );
  if (partial.length > 0) {
    const ids = own(partial);
    return {
      label: placeName(partial[0]!),
      ids: ids.length > 0 ? ids : [...inOrbit],
      level: "place",
    };
  }
  return { label: fallbackLabel, ids: [...inOrbit], level: "wide" };
}

export function resolvePosition(
  terminalRows: readonly unknown[],
  places: TerminalIndex,
  request: PositionRequest,
): PositionResult {
  const index = buildPlaceIndex(terminalRows);
  let match: PlaceMatch | null = null;
  let q = "";
  if ("text" in request) {
    for (const v of variantsOf(request.text.trim())) {
      const m = resolvePlace(index, v);
      if (m.status !== "not_found") {
        match = m;
        q = normOf(v);
        break;
      }
    }
  } else {
    const found: { m: PlaceMatch; q: string; level: Located["level"] }[] = [];
    const unsure: string[] = [];
    for (const segment of request.token.split("_")) {
      // A bare number or a short code ("3a", "1") is never a place name.
      if (segment.length < 3 || /^\d/.test(segment)) continue;
      for (const v of variantsOf(segment)) {
        const m = resolvePlace(index, v);
        if (m.status === "resolved" && m.basis === "exact") {
          const sys = m.system as number;
          const orb = m.orbit as number;
          const inOrbit = [...places.byTerminal.values()]
            .filter((t) => t.system === sys && t.orbit === orb)
            .map((t) => t.terminalId);
          found.push({
            m,
            q: normOf(v),
            level: locate(terminalRows, inOrbit, sys, orb, normOf(v), m.label ?? "?").level,
          });
          break;
        }
        if (m.status === "ambiguous") unsure.push(...(m.suggestions ?? []));
      }
    }
    const orbits = new Set(found.map((f) => `${f.m.system}|${f.m.orbit}`));
    if (orbits.size === 0) {
      // Segments that fit several places and no segment that fits one: not a position, and said so.
      return unsure.length > 0
        ? { ok: false, reason: "ambiguous", suggestions: [...new Set(unsure)].slice(0, 3) }
        : { ok: false, reason: "unknown", suggestions: [] };
    }
    if (orbits.size > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        suggestions: [...new Set(found.map((f) => f.m.label ?? ""))].filter(Boolean).slice(0, 3),
      };
    }
    // The most specific segment: a city, station or outpost beats the orbit it stands in ("Lorville_Hurston" is Lorville).
    const specific = found.filter((f) => f.level === "place");
    const pick = (specific.length > 0 ? specific : found)[
      (specific.length > 0 ? specific : found).length - 1
    ]!;
    match = pick.m;
    q = pick.q;
  }
  if (!match || match.status === "not_found")
    return { ok: false, reason: "unknown", suggestions: [] };
  if (match.status === "ambiguous") {
    return { ok: false, reason: "ambiguous", suggestions: match.suggestions ?? [] };
  }
  const system = match.system as number;
  const orbit = match.orbit as number;
  // UEX gives some places no orbit: no distance can be worked out from them.
  if (!(orbit > 0)) return { ok: false, reason: "no_orbit", suggestions: [] };
  const inOrbit = [...places.byTerminal.values()]
    .filter((t) => t.system === system && t.orbit === orbit)
    .map((t) => t.terminalId);
  if (inOrbit.length === 0) return { ok: false, reason: "unknown", suggestions: [] };
  // The player is AT the place he named, not at every place of its orbit: Lorville and Everus Harbor share Hurston's orbit and
  // are not the same spot. Distances stay orbit-level (a same-orbit hop is a short local flight), but "where he stands" is the
  // terminals of the named city, station or outpost; when the name is the orbit's own (a moon, a planet) it is all of them.
  const loc = locate(terminalRows, inOrbit, system, orbit, q, match.label ?? "?");
  if (loc.ids.length === 0) return { ok: false, reason: "unknown", suggestions: [] };
  return {
    ok: true,
    label: loc.label,
    system,
    orbit,
    terminalIds: loc.ids,
    basis: match.basis ?? "exact",
  };
}
