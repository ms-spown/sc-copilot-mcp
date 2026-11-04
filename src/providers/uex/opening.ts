import type { Distance } from "./distances.js";
import type { DistanceFn, Leg, LegSet, Plan, Rank } from "./planner.js";
import { pairKey } from "./planner.js";
import { cycleSeconds, type TravelModel } from "./travel.js";

/**
 * "Partir de ma position": an OPENING trade from where the player is to the place where a profitable route starts.
 * PURE: price legs and a distance function in, plans out. No network, no clock, no tool.
 *
 * The idea, and what it does and does not claim. A route has to be started somewhere (the terminal where it loads). From the
 * player's place that is a flight, and it is worth something to make it carry cargo: buy at a terminal around the player,
 * sell at the terminal where the route starts (an "opening leg", the same price legs `uex_plan_trade` builds). So for each
 * candidate route and each of its possible starts:
 *
 *   plain    : fly empty to the start, then the route.
 *   opening  : the same flight with an opening leg, then the same route.
 *
 * The two take the SAME time in this model (one stop at the place where the flight leaves, the flight, then the route's own
 * stops: loading and unloading time of a big hold is not modelled, and Marc's autoload means there is no hauling labour), so
 * the opening leg is extra profit on the flight, and what the ranking really decides is WHICH route to go for: a route
 * further away can win because the opening leg pays for the flight, a closer one because it starts sooner.
 * Everything is an ESTIMATE of UEX prices (crowdsourced, few player reports) and of a fixed-stop travel model. The figures
 * are for the FIRST cycle (repositioning plus one cycle of the route); the route's own steady figures stay on the route.
 */

export interface Position {
  /** Terminals around the player (UEX terminals of the same orbit): the opening leg may buy at any of them. */
  terminalIds: ReadonlySet<number>;
  /** The place as UEX names it. */
  label: string;
}

export interface OpeningPlan {
  /** The route as the planner built it (its legs, its steady-state figures). */
  main: Plan;
  /** Terminal where the route's first leg loads. For a round trip the other end is a start too (a separate OpeningPlan). */
  startId: number;
  /** The route's legs in the order driven from `startId` (a round trip started at its other end is rotated). */
  legs: Leg[];
  /** An opening trade from the position to `startId`, or null (the player is already there, or nothing pays). */
  step1: Leg | null;
  /** The route starts at a terminal of the player's own place: nothing to fly. */
  atPosition: boolean;
  /** Flight from the position to the start (Gm), null when the player is already there. */
  repositionGm: number | null;
  repositionSeconds: number | null;
  /** Repositioning plus one cycle of the route, with the opening leg. */
  firstCycle: Totals;
  /** The same, with the flight made empty (what "going there" costs without step 1). */
  withoutStep1: Totals;
  /** The plan as the ranking and the safety heuristic see it: one stop where the flight leaves, then the route. */
  asPlan: Plan;
}

export interface Totals {
  profit: number;
  seconds: number | null;
  profitPerHour: number | null;
}

export interface OpeningSearch {
  plans: OpeningPlan[];
  /** Pairs (position, start) skipped because UEX gives no distance for them. */
  skippedUnknownDistance: number;
  considered: number;
}

const perHour = (profit: number, seconds: number | null): number | null =>
  seconds === null || seconds <= 0 ? null : (profit / seconds) * 3600;

/** The starts a cycle allows: a one-way route loads at its first terminal only; a round trip can start at either end. */
function starts(main: Plan): { startId: number; legs: Leg[] }[] {
  const out = [{ startId: main.legs[0]!.fromId, legs: main.legs }];
  if (main.mode === "round_trip" && main.legs.length === 2) {
    out.push({ startId: main.legs[1]!.fromId, legs: [main.legs[1]!, main.legs[0]!] });
  }
  return out;
}

/**
 * Score every (route, start) from the position. `mains` are cycle plans (one-way routes and round trips; open chains are left
 * out: they do not come back, so a first-cycle figure would not compare). Returns them ranked by `rank` (which sees the
 * first cycle), at most `pool`.
 */
export function openingPlans(o: {
  legs: LegSet;
  distance: DistanceFn;
  model: TravelModel;
  position: Position;
  mains: readonly Plan[];
  rank: Rank;
  pool: number;
  /** Keep both starts of the same route (the default lists the better one only). For tests and diagnostics. */
  keepAllStarts?: boolean;
}): OpeningSearch {
  const { legs, distance, model, position } = o;
  const seen = new Set<string>();
  const plans: OpeningPlan[] = [];
  let skipped = 0;
  let considered = 0;
  const anchor = [...position.terminalIds][0];
  if (anchor === undefined) return { plans, skippedUnknownDistance: 0, considered: 0 };

  for (const main of o.mains) {
    if (main.legs.length === 0 || !main.returnsToStart) continue;
    for (const s of starts(main)) {
      const key = `${s.startId}|${s.legs.map((l) => `${l.commodityId}:${l.fromId}>${l.toId}`).join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const atPosition = position.terminalIds.has(s.startId);
      let d: Distance | null = null;
      let step1: Leg | null = null;
      if (!atPosition) {
        // The flight is orbit to orbit: every terminal around the player is the same distance from the start.
        d = distance(anchor, s.startId);
        if (d.kind === "unknown") {
          skipped++;
          continue;
        }
        for (const p of position.terminalIds) {
          const l = legs.best.get(pairKey(p, s.startId));
          if (l && (step1 === null || l.profit > step1.profit)) step1 = l;
        }
      }
      considered++;
      const gm = d === null || d.kind !== "known" ? null : d.gm;
      // One stop where the flight leaves (loading for step 1, or just taking off), the flight, then the route's own stops.
      const stops = (atPosition ? 0 : 1) + main.stops;
      const flights = [...(gm === null ? [] : [gm]), ...main.flightsGm];
      const seconds = cycleSeconds(stops, flights, model);
      const flightSeconds = gm === null ? null : cycleSeconds(0, [gm], model);
      const mainProfit = main.profit;
      const plain: Totals = {
        profit: mainProfit,
        seconds,
        profitPerHour: perHour(mainProfit, seconds),
      };
      const withStep1: Totals = step1
        ? {
            profit: mainProfit + step1.profit,
            seconds,
            profitPerHour: perHour(mainProfit + step1.profit, seconds),
          }
        : plain;
      // The safety heuristic looks at the places visited: the one where the flight leaves, then the route's own.
      const stopIds = [...(atPosition ? [] : [step1?.fromId ?? anchor]), ...main.stopIds];
      const asPlan: Plan = {
        ...main,
        legs: [...(step1 ? [step1] : []), ...s.legs],
        flightsGm: flights,
        stops,
        stopIds,
        profit: withStep1.profit,
        cost: Math.max(main.cost, step1?.cost ?? 0),
        cycleSeconds: withStep1.seconds,
        profitPerHour: withStep1.profitPerHour,
      };
      plans.push({
        main,
        startId: s.startId,
        legs: s.legs,
        step1,
        atPosition,
        repositionGm: gm,
        repositionSeconds: flightSeconds,
        firstCycle: withStep1,
        withoutStep1: plain,
        asPlan,
      });
    }
  }
  plans.sort((a, b) => o.rank(a.asPlan, b.asPlan));
  // The same route started from its other end is the same route: only the better start is listed (a one-way trade and a round
  // trip over the same pair are different routes and both stay).
  const routes = new Set<string>();
  const distinct = plans.filter((p) => {
    if (o.keepAllStarts) return true;
    const key = `${p.main.mode}|${p.main.legs
      .map((l) => `${l.commodityId}:${l.fromId}>${l.toId}`)
      .sort()
      .join(",")}`;
    if (routes.has(key)) return false;
    routes.add(key);
    return true;
  });
  return { plans: distinct.slice(0, o.pool), skippedUnknownDistance: skipped, considered };
}
