import type { Distance, Place } from "./distances.js";
import { fitFor, type Fit, type ShipFacts } from "../scmdb/haulingRank.js";
import { legSeconds, type TravelModel } from "./travel.js";
import type { PlaceMatch } from "./haulingPlaces.js";

/**
 * `offers` mode of scmdb_rank_hauling: concrete offers the player reads in the mobiGlas, priced in time.
 * Pure: places are resolved and distances looked up by the caller (UEX orbit matrices), passed in as functions.
 *
 * What is given, what is estimated:
 *  - reward, SCU, container size and the place names are GIVEN BY THE PLAYER; the server does not verify them;
 *  - the time is an ESTIMATE from the travel model (a fixed time per stop, a fixed hop inside one orbit, the
 *    ship's quantum speed over UEX orbit distances). The stop and hop times are assumptions, not measurements;
 *  - nothing is measured: no log or telemetry is read here, so no figure carries that label.
 * Not modelled: the flight to the first pickup and any flight after the last drop-off, the loading time of a big
 * hold, quantum fuel, interdiction, a crossing from one star system to another (UEX has no transit time, so such a
 * route has no hourly figure), whether the game lets the offers be taken together.
 */

export interface OfferInput {
  title: string | null;
  reward: number;
  scu: number;
  pickup: string;
  dropoffs: string[];
  /** The largest container (SCU) the offer says it uses, null when the player did not give it. */
  maxContainerSize: number | null;
}

export interface OffersContext {
  resolve: (query: string) => PlaceMatch;
  distance: (a: Place, b: Place) => Distance;
  model: TravelModel;
  ship: ShipFacts | null;
}

interface Stop {
  key: string;
  label: string;
  place: Place;
  system: string | null;
}

export interface PlaceView {
  asked: string;
  status: PlaceMatch["status"];
  basis?: "exact" | "partial";
  label?: string;
  system?: string | null;
  suggestions?: string[];
}

export interface TimeView {
  /** Estimated minutes, null when it cannot be computed (see reason). */
  minutes: number | null;
  reward_per_hour: number | null;
  /** Why there is no figure. */
  reason?: string;
  /** The order of the stops, pickups first. */
  route?: string[];
  trips?: number;
  /** True when the drop-off order was not searched exhaustively (nearest neighbour above 6 stops). */
  heuristic_order?: boolean;
}

export interface OfferView {
  n: number;
  title: string | null;
  reward_auec: number;
  scu: number;
  container_size: number | null;
  pickup: PlaceView;
  dropoffs: PlaceView[];
  fit: Fit;
  alone: TimeView;
}

export interface BundleView {
  offers: number[];
  pickup: string;
  scu_total: number;
  reward_total: number;
  minutes: number | null;
  reward_per_hour: number | null;
  reason?: string;
  route?: string[];
  heuristic_order?: boolean;
  /** Reward per hour of the bundle divided by that of the best single offer; null when either is unknown. */
  vs_best_single: number | null;
}

export interface OffersAnalysis {
  offers: OfferView[];
  best_single: { offer: number; reward_per_hour: number } | null;
  bundles: BundleView[];
  bundles_note: string;
  bundles_evaluated: number;
}

const MAX_BUNDLE = 4;
const EXACT_STOPS = 6;
const MAX_BUNDLES_SHOWN = 5;

const view = (m: PlaceMatch): PlaceView => ({
  asked: m.query,
  status: m.status,
  ...(m.basis ? { basis: m.basis } : {}),
  ...(m.label ? { label: m.label } : {}),
  ...(m.status === "resolved" ? { system: m.systemName ?? null } : {}),
  ...(m.suggestions?.length ? { suggestions: m.suggestions } : {}),
});

const stopOf = (m: PlaceMatch): Stop | null =>
  m.status === "resolved" && m.label && m.system !== undefined
    ? {
        key: `${m.system}|${m.orbit ?? 0}|${m.label.toLowerCase()}`,
        label: m.label,
        place: { system: m.system, orbit: m.orbit ?? 0 },
        system: m.systemName ?? null,
      }
    : null;

type Leg = { ok: true; seconds: number } | { ok: false; reason: string };

function leg(a: Stop, b: Stop, ctx: OffersContext): Leg {
  if (a.key === b.key) return { ok: true, seconds: 0 };
  const d = ctx.distance(a.place, b.place);
  if (d.kind === "unknown") return { ok: false, reason: d.why };
  const s = legSeconds(d.gm, ctx.model);
  return s === null
    ? { ok: false, reason: "no quantum speed is known (give ship_name or quantum_speed_ms)" }
    : { ok: true, seconds: s };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

interface Timed {
  seconds: number;
  route: Stop[];
  heuristic: boolean;
}

/** Time of one trip: a stop at each place, plus the flights between them; the best drop-off order. */
function tripTime(pickups: Stop[], drops: Stop[], ctx: OffersContext): Timed | { reason: string } {
  const head = [...pickups].sort((a, b) => a.label.localeCompare(b.label));
  const rest = drops.filter((d) => !head.some((p) => p.key === d.key));
  const cost = (path: Stop[]): number | { reason: string } => {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const l = leg(path[i - 1], path[i], ctx);
      if (!l.ok) return { reason: l.reason };
      total += l.seconds;
    }
    return total;
  };
  // Pickups sit in one orbit (the caller groups them), so their order does not change the time.
  const start = head;
  let best: { seconds: number; order: Stop[] } | null = null;
  let heuristic = false;
  if (rest.length <= EXACT_STOPS) {
    const candidates = rest.length ? permutations(rest) : [[]];
    // Sorted input and a strict "<" keep the choice stable between equal orders.
    for (const order of candidates) {
      const c = cost([...start, ...order]);
      if (typeof c !== "number") return c;
      if (best === null || c < best.seconds) best = { seconds: c, order };
    }
  } else {
    heuristic = true;
    const left = [...rest].sort((a, b) => a.label.localeCompare(b.label));
    const order: Stop[] = [];
    let here = start[start.length - 1];
    while (left.length) {
      let bi = 0;
      let bs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < left.length; i++) {
        const l = leg(here, left[i], ctx);
        if (!l.ok) return { reason: l.reason };
        if (l.seconds < bs) {
          bs = l.seconds;
          bi = i;
        }
      }
      here = left.splice(bi, 1)[0];
      order.push(here);
    }
    const c = cost([...start, ...order]);
    if (typeof c !== "number") return c;
    best = { seconds: c, order };
  }
  const route = [...start, ...(best?.order ?? [])];
  return { seconds: best!.seconds + route.length * ctx.model.stopSeconds, route, heuristic };
}

const perHour = (reward: number, seconds: number): number => Math.round(reward / (seconds / 3600));
const minutesOf = (seconds: number): number => Math.round((seconds / 60) * 10) / 10;

export function analyzeOffers(inputs: OfferInput[], ctx: OffersContext): OffersAnalysis {
  const hold = ctx.ship?.hold_scu ?? null;
  type Resolved = { pickup: Stop | null; drops: (Stop | null)[]; ok: boolean };
  const resolved: Resolved[] = [];
  const offers: OfferView[] = inputs.map((o, i) => {
    const pm = ctx.resolve(o.pickup);
    const dms = o.dropoffs.map((d) => ctx.resolve(d));
    const pickup = stopOf(pm);
    const drops = dms.map(stopOf);
    const ok = pickup !== null && drops.every((d) => d !== null);
    resolved.push({ pickup, drops, ok });
    const fit = fitFor(ctx.ship, { min: o.scu, max: o.scu }, o.maxContainerSize);
    let alone: TimeView;
    if (!ok) {
      alone = {
        minutes: null,
        reward_per_hour: null,
        reason: "a place could not be resolved to a UEX orbit (see pickup and dropoffs)",
      };
    } else if (fit.container === "too_big") {
      alone = {
        minutes: null,
        reward_per_hour: null,
        reason: "its containers are too big for the ship's cargo grid",
      };
    } else {
      const distinctDrops = uniqueStops(drops as Stop[]);
      const t = tripTime([pickup as Stop], distinctDrops, ctx);
      if ("reason" in t) {
        alone = { minutes: null, reward_per_hour: null, reason: t.reason };
      } else {
        const trips = hold && o.scu > hold ? Math.ceil(o.scu / hold) : 1;
        let seconds = t.seconds * trips;
        let reason: string | undefined;
        if (trips > 1) {
          const back = leg(t.route[t.route.length - 1], t.route[0], ctx);
          if (back.ok) seconds += back.seconds * (trips - 1);
          else reason = back.reason;
        }
        alone =
          reason === undefined
            ? {
                minutes: minutesOf(seconds),
                reward_per_hour: perHour(o.reward, seconds),
                route: t.route.map((s) => s.label),
                trips,
                ...(t.heuristic ? { heuristic_order: true } : {}),
              }
            : { minutes: null, reward_per_hour: null, reason, trips };
      }
    }
    return {
      n: i + 1,
      title: o.title,
      reward_auec: o.reward,
      scu: o.scu,
      container_size: o.maxContainerSize,
      pickup: view(pm),
      dropoffs: dms.map(view),
      fit,
      alone,
    };
  });

  let best: OffersAnalysis["best_single"] = null;
  for (const o of offers) {
    const r = o.alone.reward_per_hour;
    if (r !== null && (best === null || r > best.reward_per_hour)) {
      best = { offer: o.n, reward_per_hour: r };
    }
  }

  // Bundles: offers that share a pickup ORBIT, 2 to 4 of them, the sum of their SCU within the hold.
  const bundles: BundleView[] = [];
  let evaluated = 0;
  let bundlesNote: string;
  if (hold === null) {
    bundlesNote =
      "Offers were not combined: the ship's hold is unknown (give ship_name or cargo_scu) and the SCU of a bundle must fit in it.";
  } else {
    const groups = new Map<string, number[]>();
    inputs.forEach((o, i) => {
      const r = resolved[i];
      if (!r.ok || offers[i].fit.container === "too_big" || o.scu > hold) return;
      const k = `${r.pickup!.place.system}|${r.pickup!.place.orbit}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    });
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const subset of subsets(members, 2, MAX_BUNDLE)) {
        const scu = subset.reduce((s, i) => s + inputs[i].scu, 0);
        if (scu > hold) continue;
        evaluated++;
        const pickups = uniqueStops(subset.map((i) => resolved[i].pickup as Stop));
        const drops = uniqueStops(subset.flatMap((i) => resolved[i].drops as Stop[]));
        const reward = subset.reduce((s, i) => s + inputs[i].reward, 0);
        const t = tripTime(pickups, drops, ctx);
        const base = {
          offers: subset.map((i) => i + 1),
          pickup: pickups.map((p) => p.label).join(" + "),
          scu_total: scu,
          reward_total: reward,
        };
        if ("reason" in t) {
          bundles.push({
            ...base,
            minutes: null,
            reward_per_hour: null,
            reason: t.reason,
            vs_best_single: null,
          });
        } else {
          const rph = perHour(reward, t.seconds);
          bundles.push({
            ...base,
            minutes: minutesOf(t.seconds),
            reward_per_hour: rph,
            route: t.route.map((s) => s.label),
            ...(t.heuristic ? { heuristic_order: true } : {}),
            vs_best_single: best ? Math.round((rph / best.reward_per_hour) * 100) / 100 : null,
          });
        }
      }
    }
    bundles.sort(
      (a, b) =>
        (b.reward_per_hour ?? Number.NEGATIVE_INFINITY) -
          (a.reward_per_hour ?? Number.NEGATIVE_INFINITY) ||
        b.reward_total - a.reward_total ||
        a.offers.join(",").localeCompare(b.offers.join(","), undefined, { numeric: true }),
    );
    bundlesNote = [...groups.values()].some((g) => g.length >= 2)
      ? "Bundles: 2 to 4 offers with the same pickup orbit whose SCU fit in the hold in one trip. Whether the game lets you hold them together is not checked."
      : "No bundle: no two offers share a pickup orbit with every place resolved.";
  }
  return {
    offers,
    best_single: best,
    bundles: bundles.slice(0, MAX_BUNDLES_SHOWN),
    bundles_note: bundlesNote,
    bundles_evaluated: evaluated,
  };
}

function uniqueStops(stops: Stop[]): Stop[] {
  const seen = new Set<string>();
  return stops.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

/** Subsets of `items` with a size from `min` to `max`, in a stable order. */
function subsets(items: number[], min: number, max: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, current: number[]) => {
    if (current.length >= min) out.push([...current]);
    if (current.length === max) return;
    for (let i = start; i < items.length; i++) {
      current.push(items[i]);
      walk(i + 1, current);
      current.pop();
    }
  };
  walk(0, []);
  return out;
}
