import axios from "axios";
import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { setDataDates } from "../../core/provenance.js";
import {
  fetchOrbitMatrix,
  fetchTerminalDistance,
  orbitDistance,
  type Distance,
  type OrbitMatrix,
} from "./distances.js";
import { ageDays, label, round, toNumber, unwrapData, type Row } from "./normalize.js";
import {
  buildLegs,
  byValue,
  oneWayPlan,
  pairKey,
  parsePriceRows,
  roundTrips,
  routeLeg,
  twoLegChains,
  ageOk,
  type Leg,
  type Plan,
  type PlanMode,
  type PriceRow,
  type Rank,
} from "./planner.js";
import {
  loadPlaces,
  safetyOf,
  type PlaceIndex,
  type SafetyHeuristic,
  type TerminalPlace,
} from "./places.js";
import { pickRow } from "./resolve.js";
import { fetchShipSheet, type ShipSheet } from "./shipSheet.js";
import {
  DEFAULT_SPOOL_SECONDS,
  DEFAULT_STOP_SECONDS,
  LOCAL_HOP_SECONDS,
  formatDuration,
  validQuantumSpeed,
  type TravelModel,
} from "./travel.js";

/**
 * The trade planner, as a function with no knowledge of MCP: `uex_plan_trade` is a thin wrapper
 * over `planTrips`, and anything else that needs ranked trade options (an app-only tool of the
 * dashboard) can call it directly with the same inputs.
 *
 * What it does, in one call chain: reads the whole UEX price graph (`commodities_prices_all`, cached),
 * the places (`terminals`, stations, cities, outposts), the orbit distance matrix of each system
 * involved, optionally the ship sheet (UEX cargo, wiki quantum speed), builds the best leg of every
 * terminal pair, assembles one-way routes (UEX `commodities_routes`), round trips and two-leg
 * chains, ranks them for the requested objective, then checks which prices were reported by players
 * for the options it will show. Everything returned is data about the options and the assumptions
 * behind them; nothing is written anywhere.
 */

export type Objective = "profit" | "profit_per_hour" | "speed" | "safety";

export interface TripRequest {
  /** What "best" means. profit: most aUEC per run. profit_per_hour: most aUEC per estimated hour. speed: shortest estimated run. safety: fewest risk factors of the heuristic, then profit per hour. */
  objective?: Objective;
  /** aUEC available for one purchase. */
  budget?: number;
  /** Cargo hold in SCU; defaults to the ship's. */
  cargoScu?: number;
  shipName?: string;
  /** Quantum speed in m/s; overrides the wiki sheet. */
  quantumSpeedMs?: number;
  /** Where to start (all optional). commodityName, terminalName or planetName also enable one-way routes from UEX. */
  origin?: {
    terminalName?: string;
    planetName?: string;
    systemName?: string;
    commodityName?: string;
  };
  avoidPyro?: boolean;
  /** Keep only plans whose every stop UEX flags as an armistice zone. */
  armisticeOnly?: boolean;
  /** 1: one-way routes only (needs an origin hint). 2 (default): also round trips, and two-leg chains in their own list. */
  maxLegs?: 1 | 2;
  /** Prices older than this are left out (default 7 days). */
  maxAgeDays?: number;
  includeStale?: boolean;
  /**
   * Keep only options with at least this many player reports at every buy and sell end (default 0 = keep
   * estimates, flagged). Options whose reports could not be checked are DROPPED when this is above 0.
   */
  minReports?: number;
  stopMinutes?: number;
  limit?: number;
}

export interface Dependencies {
  uexClient: HttpClient;
  scwClient: HttpClient;
  now?: () => number;
  /** Time allowed for the whole plan (default 25 s). Past it, the work stops and what is known is returned, with a note. */
  deadlineMs?: number;
}

export class TripPlanError extends Error {}

type ReportStatus = "reported" | "estimate" | "unverified";

export interface LegView {
  commodity: string;
  from: PlaceView;
  to: PlaceView;
  buy_price: number;
  sell_price: number;
  profit_per_scu: number;
  scu: number;
  limited_by: Leg["limitedBy"];
  cost: number;
  profit_for_leg: number;
  destination_demand_scu: number | null;
  price_updated: { buy: string | null; sell: string | null };
  price_age_days: { buy: number | null; sell: number | null };
  stale: boolean;
  report_status: ReportStatus;
  reports: { origin: number | null; destination: number | null };
  is_estimate: boolean | null;
  estimated_sides: ("origin" | "destination")[];
}

export interface PlaceView {
  terminal: string;
  system: string | null;
  planet: string | null;
  kind: string | null;
  armistice_zone: boolean | null;
  jurisdiction: string | null;
}

export interface TripOption {
  rank: number;
  mode: PlanMode;
  /** The worst report status among the legs: estimate, then unverified, then reported. */
  report_status: ReportStatus;
  /** True when at least one price is a UEX estimate (no player report): do not count on it. */
  estimate: boolean;
  summary: string;
  legs: LegView[];
  trip: {
    profit_per_cycle: number;
    profit_per_scu: number;
    scu_moved: number;
    peak_investment: number;
    cycle_seconds: number | null;
    cycle_time_estimate: string | null;
    profit_per_hour: number | null;
    flights_gm: number[];
    distance_basis: string[];
    stops: number;
    returns_to_start: boolean;
  };
  data_age: { oldest_price_age_days: number | null; stale: boolean; undated_prices: boolean };
  safety: SafetyHeuristic;
}

export interface TripPlanResult {
  objective: Objective;
  ship: {
    name: string | null;
    cargo_scu_used: number;
    quantum_speed_ms: number | null;
    spool_seconds: number;
    missing: string[];
  } | null;
  cargo_scu_used: number;
  budget: number | null;
  time_model: {
    quantum_speed_ms: number | null;
    spool_seconds: number;
    stop_minutes: number;
    local_hop_minutes: number;
    estimate: true;
  };
  /** Options that come back to where they start (one-way routes repeated, round trips), ranked by the objective. */
  options: TripOption[];
  /** Two-leg chains A>B>C: no return leg is priced, so they are ranked on their own and not comparable with `options`. */
  chains: TripOption[];
  lists_note: string;
  /** How many of the options and chains shown rest on player reports, on UEX estimates, or were not checked. */
  report_counts: { reported: number; estimate: number; unverified: number };
  min_reports_note: string;
  candidates_scored: number;
  excluded: Record<string, number>;
  assumptions: string[];
  notes: string[];
  fuel: {
    included: false;
    reason: string;
    fuel_prices_rows: number | null;
    rows_updated_within_7_days: number | null;
    median_age_days: number | null;
  };
}

const DAY_MS = 86_400_000;
/** Candidates kept for the report check. Most UEX prices have no player report, so the pool is wide to reach reported ones. */
const MAX_POOL = 40;
const MAX_POOL_MIN_REPORTS = 80;
const MAX_VERIFY_COMMODITIES = 12;
const MAX_VERIFY_COMMODITIES_MIN_REPORTS = 25;
const MAX_TERMINAL_DISTANCE_CALLS = 5;
const MAX_MATRICES = 3;
const DEFAULT_DEADLINE_MS = 25_000;
/** Verification failures listed one by one in the notes. */
const MAX_LISTED_FAILURES = 5;

class DeadlineError extends Error {}

/** Reject once `ms` have passed (the request itself cannot be cancelled; its answer is ignored). */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) {
    promise.catch(() => undefined);
    return Promise.reject(new DeadlineError(`${what}: the time allowed for the plan is used up`));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DeadlineError(`${what}: no answer within the time allowed for the plan`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A failure that says the upstream is slow or throttling: asking again for the next item would only add to it. */
function isBreaker(error: unknown): boolean {
  if (error instanceof DeadlineError) return true;
  return (
    axios.isAxiosError(error) &&
    (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error.response?.status === 429)
  );
}

function describeFailure(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response ? `HTTP ${error.response.status}` : (error.code ?? "no answer");
  }
  return error instanceof Error ? (label(error.message, 100) ?? "error") : "error";
}

const clampInt = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
  v === undefined || !Number.isFinite(v) ? dflt : Math.min(hi, Math.max(lo, Math.floor(v)));

/** The text every consumer of the planner should show next to its figures. */
export function tripAssumptions(model: TravelModel, maxAgeDays: number): string[] {
  return [
    "TRAVEL TIME IS AN ESTIMATE. Flight time = ship quantum spool-up + distance / quantum speed (UEX distance in Gm, quantum speed from the Star Citizen Wiki sheet or the caller). The wiki's own calibration agrees with it: Port Olisar to ArcCorp, 42 Gm, 176 s.",
    `Each stop (request landing, land, terminal, load or unload, take off, align) is a fixed ${round(model.stopSeconds / 60, 1)} min, and a hop inside one orbit a fixed ${round(model.localHopSeconds / 60, 1)} min. These two values are assumptions, not measurements: change them with stop_minutes.`,
    "A one-way route is repeated: stock up at A, sell at B, fly back empty. A round trip carries a different cargo each way. A two-leg chain A to B to C does not return to A: no return flight is priced (and a distance back to A is not looked up), so chains are listed apart and never ranked against round trips.",
    "Straight-line quantum flights between orbit centres. Not modelled: quantum fuel and its price, jump interruptions, pirates, queues at landing pads, loading time of a big hold, price drops while selling.",
    `Prices older than ${maxAgeDays} days are left out unless include_stale is set. UEX prices are crowdsourced and move within hours: confirm at the terminal.`,
    "Quantity of each leg is the smallest of the hold, the budget, and the stock UEX shows at the buy terminal. The demand at the sell terminal is shown, not applied. Container sizes are not applied.",
    "Systems are planned separately: a route that crosses Stanton and Pyro (jump point) is not estimated, because the gate transit time is not in UEX.",
  ];
}

interface Context {
  now: number;
  model: TravelModel;
  places: PlaceIndex;
  matrices: Map<number, OrbitMatrix>;
  terminalDistanceCalls: number;
  distanceMemo: Map<string, Distance>;
  /** True once the time allowed for the plan is used up: no more optional requests. */
  expired: () => boolean;
  priceByKey: Map<string, PriceRow>;
}

function placeView(p: TerminalPlace | undefined, terminal: string): PlaceView {
  return {
    terminal,
    system: p?.systemName ?? null,
    planet: p?.planetName ?? null,
    kind: p?.kind ?? null,
    armistice_zone: p?.armistice ?? null,
    jurisdiction: p?.jurisdiction ?? null,
  };
}

const ageOf = (ts: number | null, now: number) => ageDays(ts, now);

/**
 * Plan trips. Throws TripPlanError for a request that cannot be answered (no cargo size, an
 * unknown or ambiguous name); network failures propagate as the client reports them.
 */
export async function planTrips(deps: Dependencies, req: TripRequest): Promise<TripPlanResult> {
  const now = (deps.now ?? Date.now)();
  const deadlineAt = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const left = () => deadlineAt - Date.now();
  const objective: Objective = req.objective ?? "profit_per_hour";
  const maxAgeDays = clampInt(req.maxAgeDays, 1, 3650, 7);
  const limit = clampInt(req.limit, 1, 20, 8);
  const includeStale = req.includeStale === true;
  const minReports = clampInt(req.minReports, 0, 100, 0);
  const pool = minReports > 0 ? MAX_POOL_MIN_REPORTS : Math.min(MAX_POOL, limit * 4);
  const maxVerify = minReports > 0 ? MAX_VERIFY_COMMODITIES_MIN_REPORTS : MAX_VERIFY_COMMODITIES;
  const maxLegs = req.maxLegs === 1 ? 1 : 2;
  if (req.budget !== undefined && !(req.budget > 0))
    throw new TripPlanError("budget must be a positive number of aUEC.");
  if (req.cargoScu !== undefined && !(req.cargoScu >= 1))
    throw new TripPlanError("cargo_scu must be at least 1 SCU.");
  if (req.quantumSpeedMs !== undefined && validQuantumSpeed(req.quantumSpeedMs) === null) {
    throw new TripPlanError(
      "quantum_speed_ms must be between 1,000,000 and 299,792,458 m/s (a quantum drive, in metres per second).",
    );
  }

  // --- the ship -------------------------------------------------------------------------------
  let sheet: ShipSheet | null = null;
  if (req.shipName) {
    try {
      sheet = await fetchShipSheet(deps.uexClient, deps.scwClient, req.shipName);
    } catch (error) {
      throw new TripPlanError(
        error instanceof Error ? error.message : "The ship could not be looked up.",
      );
    }
  }
  // Whole SCU: a hold is counted in containers, and a fraction would make profit and quantity disagree.
  const rawCargo = req.cargoScu ?? sheet?.cargo_scu ?? undefined;
  const cargo = rawCargo === undefined ? undefined : Math.floor(rawCargo);
  if (cargo === undefined || cargo < 1) {
    throw new TripPlanError(
      "Give ship_name (its cargo comes from UEX) or cargo_scu: a plan needs a hold size.",
    );
  }
  const model: TravelModel = {
    quantumSpeedMs: req.quantumSpeedMs ?? sheet?.quantum_speed_ms ?? null,
    spoolSeconds: sheet?.spool_seconds ?? DEFAULT_SPOOL_SECONDS,
    stopSeconds:
      Math.round(Math.min(120, Math.max(0, req.stopMinutes ?? DEFAULT_STOP_SECONDS / 60))) * 60,
    localHopSeconds: LOCAL_HOP_SECONDS,
  };

  // --- the data -------------------------------------------------------------------------------
  let pricesRes: Awaited<ReturnType<typeof fetchWithCache>>;
  let places: PlaceIndex;
  try {
    [pricesRes, places] = await withDeadline(
      Promise.all([
        fetchWithCache(deps.uexClient, "/commodities_prices_all"),
        loadPlaces(deps.uexClient),
      ]),
      left(),
      "reading UEX prices and places",
    );
  } catch (error) {
    if (error instanceof DeadlineError) throw new TripPlanError(error.message);
    throw error;
  }
  const priceData = unwrapData(pricesRes.data);
  if (priceData.kind !== "rows")
    throw new TripPlanError("UEX returned no prices (commodities_prices_all is empty).");
  const allPrices = parsePriceRows(priceData.rows);
  if (req.armisticeOnly && places.armisticeUnavailable) {
    throw new TripPlanError(`armistice_only cannot be applied: ${places.armisticeUnavailable}.`);
  }

  // --- origin hints and filters ---------------------------------------------------------------
  const notes: string[] = [];
  const hint = req.origin ?? {};
  const terminalRows = [...places.byTerminal.values()];
  let startTerminal: number | undefined;
  let startPlanet: string | undefined;
  let commodityId: number | undefined;
  let terminalNameRows: unknown[] | undefined;
  const terminalList = async () => {
    terminalNameRows ??= unwrapRowsOf(
      (await fetchWithCache(deps.uexClient, "/terminals", undefined, { record: false })).data,
    );
    return terminalNameRows;
  };
  try {
    if (hint.terminalName) {
      startTerminal = toNumber(
        pickRow(await terminalList(), hint.terminalName, "terminal", (r) => [
          r.name,
          r.nickname,
          r.fullname,
          r.displayname,
        ]).id,
      );
    }
    if (hint.commodityName) {
      const rows = unwrapRowsOf((await fetchWithCache(deps.uexClient, "/commodities")).data);
      commodityId = toNumber(
        pickRow(rows, hint.commodityName, "commodity", (r) => [r.name, r.slug, r.code]).id,
      );
    }
  } catch (error) {
    throw new TripPlanError(
      error instanceof Error ? error.message : "A name could not be resolved.",
    );
  }
  if (hint.planetName) {
    const wanted = hint.planetName.trim().toLowerCase();
    const known = terminalRows.find((t) => t.planetName?.toLowerCase() === wanted);
    if (!known)
      throw new TripPlanError(
        `No UEX terminal is on a planet called "${label(hint.planetName, 60)}".`,
      );
    startPlanet = known.planetName ?? undefined;
  }
  const systemWanted = hint.systemName?.trim().toLowerCase();
  if (systemWanted && !terminalRows.some((t) => t.systemName?.toLowerCase() === systemWanted)) {
    throw new TripPlanError(
      `No UEX terminal is in a system called "${label(hint.systemName, 60)}".`,
    );
  }

  const excluded: Record<string, number> = {};
  const bump = (k: string, n = 1) => {
    excluded[k] = (excluded[k] ?? 0) + n;
  };
  const allowedTerminal = (id: number): boolean => {
    const p = places.byTerminal.get(id);
    if (req.avoidPyro && p?.systemName?.toLowerCase() === "pyro") return false;
    if (systemWanted && p?.systemName?.toLowerCase() !== systemWanted) return false;
    if (req.armisticeOnly && p?.armistice !== true) return false;
    return true;
  };
  const startsAt = (id: number): boolean => {
    if (startTerminal !== undefined) return id === startTerminal;
    if (startPlanet)
      return places.byTerminal.get(id)?.planetName?.toLowerCase() === startPlanet.toLowerCase();
    return true;
  };
  const prices = allPrices.filter((r) => {
    if (allowedTerminal(r.terminalId)) return true;
    bump("price_rows_outside_filters");
    return false;
  });

  const ctx: Context = {
    now,
    model,
    places,
    matrices: new Map(),
    terminalDistanceCalls: 0,
    distanceMemo: new Map(),
    expired: () => left() <= 0,
    priceByKey: new Map(allPrices.map((r) => [`${r.commodityId}|${r.terminalId}`, r])),
  };

  // Orbit matrices for the systems that still have a possible trade.
  const systemsInUse = new Map<number, number>();
  for (const r of prices) {
    const p = places.byTerminal.get(r.terminalId);
    if (p) systemsInUse.set(p.system, (systemsInUse.get(p.system) ?? 0) + 1);
  }
  for (const [system] of [...systemsInUse].sort((a, b) => b[1] - a[1]).slice(0, MAX_MATRICES)) {
    try {
      ctx.matrices.set(
        system,
        await withDeadline(
          fetchOrbitMatrix(deps.uexClient, system, system),
          left(),
          "reading an orbit distance matrix",
        ),
      );
    } catch (error) {
      notes.push(
        `An orbit distance matrix could not be read (${describeFailure(error)}); pairs in that system have no distance and are left out.`,
      );
      if (isBreaker(error)) break;
    }
  }
  const distance = (a: number, b: number): Distance => {
    const key = pairKey(a, b);
    const held = ctx.distanceMemo.get(key);
    if (held) return held;
    const d = orbitDistance(places.byTerminal.get(a), places.byTerminal.get(b), ctx.matrices);
    ctx.distanceMemo.set(key, d);
    return d;
  };

  // --- safety, and the ranking it feeds -------------------------------------------------------
  const safetyMemo = new Map<string, SafetyHeuristic>();
  const safetyFor = (plan: Plan): SafetyHeuristic => {
    const flights = plan.flightsGm.filter((g) => g > 0).length;
    const key = `${plan.stopIds.join(",")}|${flights}`;
    let s = safetyMemo.get(key);
    if (!s) {
      s = safetyOf(
        plan.stopIds.map((id) => places.byTerminal.get(id)),
        flights,
      );
      safetyMemo.set(key, s);
    }
    return s;
  };
  const rank: Rank =
    objective === "profit"
      ? (a, b) => b.profit - a.profit
      : objective === "speed"
        ? (a, b) =>
            (a.cycleSeconds ?? Number.POSITIVE_INFINITY) -
              (b.cycleSeconds ?? Number.POSITIVE_INFINITY) || b.profit - a.profit
        : objective === "safety"
          ? (a, b) => safetyFor(a).points - safetyFor(b).points || byValue(a, b)
          : byValue;
  if (
    (objective === "profit_per_hour" || objective === "speed" || objective === "safety") &&
    model.quantumSpeedMs === null
  ) {
    notes.push(
      "No quantum speed is known (give ship_name with a wiki sheet, or quantum_speed_ms): flights longer than a local hop have no time, so options are ordered by profit per run and profit_per_hour is null.",
    );
  }

  // --- candidates -----------------------------------------------------------------------------
  const plans: Plan[] = [];
  let scored = 0;
  const legOptions = {
    cargoScu: cargo,
    budget: req.budget,
    now,
    maxAgeDays,
    includeStale,
    commodityId,
  };
  const legs = buildLegs(prices, legOptions);
  if (legs.excluded_stale_rows) bump("price_rows_older_than_max_age", legs.excluded_stale_rows);
  if (legs.undated_rows) bump("price_rows_without_date", legs.undated_rows);
  const hasStart = startTerminal !== undefined || startPlanet !== undefined;
  if (maxLegs === 2) {
    const rt = roundTrips(legs, distance, model, pool, hasStart ? startsAt : undefined, rank);
    const tl = twoLegChains(legs, distance, model, pool, hasStart ? startsAt : undefined, rank);
    plans.push(...rt.plans, ...tl.plans);
    scored += rt.scored + tl.scored;
    bump("plans_without_known_distance", rt.skipped.unknownDistance + tl.skipped.unknownDistance);
  }

  // One-way routes from UEX, for an origin the API accepts.
  const routeEvidence = new Map<Plan, { origin: number | null; destination: number | null }>();
  const routesWanted = hint.terminalName || hint.planetName || hint.commodityName;
  if (maxLegs === 1 && !routesWanted) {
    throw new TripPlanError(
      "max_legs 1 (one-way routes) needs an origin: origin.commodity_name, origin.terminal_name or origin.planet_name.",
    );
  }
  if (routesWanted) {
    // No scu or investment sent: the quantity is sized here from the hold and the budget, and a request
    // that does not carry the caller's numbers is cached and shared between callers.
    const params: Record<string, unknown> = {};
    if (commodityId !== undefined) params.id_commodity = commodityId;
    if (startTerminal !== undefined) params.id_terminal_origin = startTerminal;
    if (startPlanet) {
      const id = terminalRows.find((t) => t.planetName === startPlanet)?.planetId;
      if (id) params.id_planet_origin = id;
    }
    let data: ReturnType<typeof unwrapData> = { kind: "no_data", why: "not read" };
    try {
      const res = await withDeadline(
        fetchWithCache(deps.uexClient, "/commodities_routes", { params }),
        left(),
        "reading UEX routes",
      );
      data = unwrapData(res.data);
    } catch (error) {
      if (maxLegs === 1) {
        throw new TripPlanError(
          `UEX routes could not be read (${describeFailure(error)}) and max_legs 1 has nothing else to show.`,
        );
      }
      notes.push(
        `UEX routes could not be read (${describeFailure(error)}): the one-way routes are left out, and the round trips and chains below were computed offline from the price file.`,
      );
    }
    const oneWay: Plan[] = [];
    if (data.kind === "rows") {
      for (const row of data.rows) {
        const leg = routeLeg({ row, cargoScu: cargo, budget: req.budget });
        if (!leg) continue;
        if (!allowedTerminal(leg.fromId) || !allowedTerminal(leg.toId)) {
          bump("routes_outside_filters");
          continue;
        }
        const buyRow = ctx.priceByKey.get(`${leg.commodityId}|${leg.fromId}`);
        const sellRow = ctx.priceByKey.get(`${leg.commodityId}|${leg.toId}`);
        leg.buyUpdatedAt = buyRow?.updatedAt ?? null;
        leg.sellUpdatedAt = sellRow?.updatedAt ?? null;
        if (
          !includeStale &&
          !(
            buyRow &&
            sellRow &&
            ageOk(buyRow, { now, maxAgeDays, includeStale }) &&
            ageOk(sellRow, { now, maxAgeDays, includeStale })
          )
        ) {
          bump("routes_with_old_or_undated_prices");
          continue;
        }
        const d = await routeDistance(deps.uexClient, row, leg, ctx, distance);
        if (d.kind === "unknown") {
          bump("plans_without_known_distance");
          continue;
        }
        const plan = oneWayPlan(leg, d, model);
        routeEvidence.set(plan, {
          origin: toNumber(row.price_origin_users_rows) ?? null,
          destination: toNumber(row.price_destination_users_rows) ?? null,
        });
        oneWay.push(plan);
      }
    }
    scored += oneWay.length;
    plans.push(...oneWay);
  }

  // --- who reported these prices --------------------------------------------------------------
  // Two lists, never mixed: what comes back to where it starts (one-way routes repeated, round trips),
  // and open chains A>B>C, which have no return leg priced and so cannot share a profit-per-hour ranking.
  plans.sort(rank);
  const cyclePlans = plans.filter((p) => p.returnsToStart).slice(0, pool);
  const chainPlans = plans.filter((p) => !p.returnsToStart).slice(0, pool);
  const candidates = [...cyclePlans, ...chainPlans];
  const needed = new Map<number, string>();
  for (const p of candidates) {
    if (routeEvidence.has(p)) continue;
    for (const l of p.legs) if (!needed.has(l.commodityId)) needed.set(l.commodityId, l.commodity);
  }
  const reports = new Map<string, { buy: number | null; sell: number | null }>();
  const failures: string[] = [];
  let stoppedEarly: string | null = null;
  for (const [id, name] of [...needed].slice(0, maxVerify)) {
    if (left() <= 0) {
      stoppedEarly = "the time allowed for the plan ran out";
      break;
    }
    try {
      const res = await withDeadline(
        fetchWithCache(
          deps.uexClient,
          "/commodities_prices",
          { params: { id_commodity: id } },
          { record: false },
        ),
        left(),
        "checking player reports",
      );
      const d = unwrapData(res.data);
      if (d.kind !== "rows") {
        failures.push(`${name}: UEX returned no price rows`);
        continue;
      }
      for (const r of d.rows) {
        const t = toNumber(r.id_terminal);
        if (t === undefined) continue;
        reports.set(`${id}|${t}`, {
          buy: toNumber(r.price_buy_users_rows) ?? null,
          sell: toNumber(r.price_sell_users_rows) ?? null,
        });
      }
    } catch (error) {
      failures.push(`${name}: ${describeFailure(error)}`);
      if (isBreaker(error)) {
        stoppedEarly = `UEX was slow or throttling (${describeFailure(error)}), so the remaining checks were not attempted`;
        break;
      }
    }
  }
  if (failures.length > 0) {
    notes.push(
      `The player-report check failed for ${failures.length} commodit${failures.length === 1 ? "y" : "ies"} (${failures.slice(0, MAX_LISTED_FAILURES).join("; ")}${failures.length > MAX_LISTED_FAILURES ? "; ..." : ""}): their legs are report_status "unverified".`,
    );
  }
  if (stoppedEarly) notes.push(`The player-report check stopped early: ${stoppedEarly}.`);
  const capped = Math.max(0, needed.size - maxVerify);
  if (capped > 0) {
    notes.push(
      `${capped} commodit${capped === 1 ? "y was" : "ies were"} not checked for player reports (limit of ${maxVerify} extra calls): their legs are report_status "unverified".`,
    );
  }

  const viewLeg = (plan: Plan, l: Leg): LegView => {
    const evidence = routeEvidence.get(plan);
    let origin: number | null;
    let destination: number | null;
    if (evidence) {
      ({ origin, destination } = evidence);
    } else {
      origin = reports.get(`${l.commodityId}|${l.fromId}`)?.buy ?? null;
      destination = reports.get(`${l.commodityId}|${l.toId}`)?.sell ?? null;
    }
    const estimated: ("origin" | "destination")[] = [];
    if (origin === 0) estimated.push("origin");
    if (destination === 0) estimated.push("destination");
    const known = origin !== null && destination !== null;
    const status: ReportStatus = estimated.length ? "estimate" : known ? "reported" : "unverified";
    const buyAge = ageOf(l.buyUpdatedAt, now);
    const sellAge = ageOf(l.sellUpdatedAt, now);
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return {
      commodity: l.commodity,
      from: placeView(places.byTerminal.get(l.fromId), l.from),
      to: placeView(places.byTerminal.get(l.toId), l.to),
      buy_price: l.buyPrice,
      sell_price: l.sellPrice,
      profit_per_scu: l.profitPerScu,
      scu: l.scu,
      limited_by: l.limitedBy,
      cost: l.cost,
      profit_for_leg: l.profit,
      destination_demand_scu: l.demandScu > 0 ? l.demandScu : null,
      price_updated: { buy: iso(l.buyUpdatedAt), sell: iso(l.sellUpdatedAt) },
      price_age_days: { buy: buyAge, sell: sellAge },
      stale:
        [buyAge, sellAge].some((a) => a !== null && a > maxAgeDays) ||
        l.buyUpdatedAt === null ||
        l.sellUpdatedAt === null,
      report_status: status,
      reports: { origin, destination },
      is_estimate: status === "unverified" ? null : status === "estimate",
      estimated_sides: estimated,
    };
  };

  const worst = (views: LegView[]): ReportStatus =>
    views.some((v) => v.report_status === "estimate")
      ? "estimate"
      : views.some((v) => v.report_status === "unverified")
        ? "unverified"
        : "reported";

  // The objective decides the order. The report status is shown on every option, not used to reorder.
  const build = (list: Plan[]) => {
    const kept: { plan: Plan; views: LegView[]; status: ReportStatus }[] = [];
    for (const plan of list) {
      const views = plan.legs.map((l) => viewLeg(plan, l));
      const status = worst(views);
      if (minReports > 0) {
        if (status === "unverified") {
          bump("options_unverified_dropped_by_min_reports");
          continue;
        }
        const enough = views.every(
          (v) =>
            (v.reports.origin ?? 0) >= minReports && (v.reports.destination ?? 0) >= minReports,
        );
        if (!enough) {
          bump("options_with_fewer_reports_than_min_reports");
          continue;
        }
      }
      kept.push({ plan, views, status });
    }
    return kept.sort((x, y) => rank(x.plan, y.plan)).slice(0, limit);
  };
  const shownCycle = build(cyclePlans);
  const shownChains = build(chainPlans);
  const shown = [...shownCycle, ...shownChains];

  const toOption = (
    { plan, views, status }: { plan: Plan; views: LegView[]; status: ReportStatus },
    i: number,
  ): TripOption => {
    const ages = views
      .flatMap((v) => [v.price_age_days.buy, v.price_age_days.sell])
      .filter((a): a is number => a !== null);
    const scuMoved = plan.legs.reduce((s, l) => s + l.scu, 0);
    const route = [plan.legs[0].from, ...plan.legs.map((l) => l.to)].join(" > ");
    const tag =
      status === "estimate" ? "[ESTIMATE] " : status === "unverified" ? "[UNVERIFIED] " : "";
    return {
      rank: i + 1,
      mode: plan.mode,
      report_status: status,
      estimate: status === "estimate",
      summary: `${tag}${plan.legs.map((l) => `${l.scu} SCU ${l.commodity}`).join(" + ")} on ${route}${plan.returnsToStart && plan.mode !== "round_trip" ? " and back empty" : ""}`,
      legs: views,
      trip: {
        profit_per_cycle: plan.profit,
        profit_per_scu: scuMoved > 0 ? round(plan.profit / scuMoved, 1) : 0,
        scu_moved: scuMoved,
        peak_investment: plan.cost,
        cycle_seconds: plan.cycleSeconds === null ? null : Math.round(plan.cycleSeconds),
        cycle_time_estimate: plan.cycleSeconds === null ? null : formatDuration(plan.cycleSeconds),
        profit_per_hour: plan.profitPerHour === null ? null : Math.round(plan.profitPerHour),
        flights_gm: plan.flightsGm,
        distance_basis: plan.distanceBasis,
        stops: plan.stops,
        returns_to_start: plan.returnsToStart,
      },
      data_age: {
        oldest_price_age_days: ages.length ? Math.max(...ages) : null,
        stale: views.some((v) => v.stale),
        undated_prices: views.some(
          (v) => v.price_updated.buy === null || v.price_updated.sell === null,
        ),
      },
      safety: safetyFor(plan),
    };
  };
  const options = shownCycle.map(toOption);
  const chains = shownChains.map(toOption);
  const counts = { reported: 0, estimate: 0, unverified: 0 };
  for (const o of [...options, ...chains]) counts[o.report_status]++;

  // Provenance: the real age of the prices behind what is shown.
  const stamps = shown
    .flatMap(({ plan }) => plan.legs.flatMap((l) => [l.buyUpdatedAt, l.sellUpdatedAt]))
    .filter((t): t is number => t !== null);
  if (stamps.length > 0) {
    setDataDates(
      Math.min(...stamps),
      Math.max(...stamps),
      `UEX date_modified of the ${stamps.length} prices behind the options shown`,
    );
  }

  let fuel: TripPlanResult["fuel"];
  try {
    fuel = await withDeadline(
      fuelBlock(deps.uexClient, now),
      Math.max(left(), 2000),
      "reading fuel prices",
    );
  } catch {
    fuel = fuelUnavailable();
  }
  const assumptions = tripAssumptions(model, maxAgeDays);
  if ([...options, ...chains].some((o) => o.report_status !== "reported")) {
    notes.push(
      "report_status: reported = a player reported both prices; estimate = UEX counts 0 player reports for that price (the is_estimate convention of uex_get_trade_routes, whatever the date of the price: most UEX prices are in that state today, so reported options are rare), do not count on it; unverified = the check could not be made. The order follows the objective, not the report status: see report_counts and the [ESTIMATE] tag on each summary.",
    );
  }
  if (options.length === 0 && chains.length === 0) {
    notes.push(
      "No option matched. Loosen the filters (max_age_days, include_stale, armistice_only, min_reports, budget) or choose another origin.",
    );
  }
  if (left() <= 0) {
    notes.push(
      "The time allowed for the plan (25 s) ran out: the result uses what was read by then.",
    );
  }
  if (places.armisticeUnavailable)
    notes.push(`Safety heuristic degraded: ${places.armisticeUnavailable}.`);

  return {
    objective,
    ship: sheet
      ? {
          name: sheet.name,
          cargo_scu_used: cargo,
          quantum_speed_ms: sheet.quantum_speed_ms,
          spool_seconds: model.spoolSeconds,
          missing: sheet.missing,
        }
      : null,
    cargo_scu_used: cargo,
    budget: req.budget ?? null,
    time_model: {
      quantum_speed_ms: model.quantumSpeedMs,
      spool_seconds: model.spoolSeconds,
      stop_minutes: round(model.stopSeconds / 60, 1),
      local_hop_minutes: round(model.localHopSeconds / 60, 1),
      estimate: true,
    },
    options,
    chains,
    lists_note:
      "`options` come back to where they start (a one-way route repeated with an empty return, or a round trip) and are ranked by the objective among themselves. `chains` are open A>B>C trips: no return leg to the start is priced, so their profit per hour is not comparable with `options` and they are ranked on their own.",
    report_counts: counts,
    min_reports_note:
      "Options are ordered by the objective, estimates included, each marked estimate or not. To require player reports, set min_reports (1 or more): options with fewer reports at an end, or whose reports could not be checked, are then dropped and counted in `excluded`.",
    candidates_scored: scored,
    excluded,
    assumptions,
    notes,
    fuel,
  };
}

function unwrapRowsOf(body: unknown): Row[] {
  const d = unwrapData(body);
  return d.kind === "rows" ? d.rows : [];
}

/** The distance of a UEX route: its own `distance` when non-zero, else orbits, else one terminals_distances call (a few at most). */
async function routeDistance(
  client: HttpClient,
  row: Row,
  leg: Leg,
  ctx: Context,
  byOrbit: (a: number, b: number) => Distance,
): Promise<Distance> {
  const own = toNumber(row.distance);
  if (own !== undefined && own > 0) return { kind: "known", gm: own, basis: "route" };
  const viaOrbit = byOrbit(leg.fromId, leg.toId);
  if (viaOrbit.kind === "known") return viaOrbit;
  if (ctx.terminalDistanceCalls >= MAX_TERMINAL_DISTANCE_CALLS || ctx.expired()) return viaOrbit;
  ctx.terminalDistanceCalls++;
  try {
    const t = await fetchTerminalDistance(client, leg.fromId, leg.toId);
    if (t.kind === "found") return { kind: "known", gm: t.gm, basis: "terminals_distances" };
    return { kind: "unknown", why: t.why };
  } catch {
    return viaOrbit;
  }
}

function fuelUnavailable(): TripPlanResult["fuel"] {
  return {
    included: false,
    reason:
      "Fuel is NOT subtracted from the profit. UEX gives a price per unit of fuel without saying which unit, and no ship's quantum fuel burn per Gm is available in a verified unit, so a fuel cost would be invented. The fuel price table could not be read in time.",
    fuel_prices_rows: null,
    rows_updated_within_7_days: null,
    median_age_days: null,
  };
}

/** Fuel is left out of the profit, and the answer says why with the measured freshness of UEX's fuel prices. */
async function fuelBlock(client: HttpClient, now: number): Promise<TripPlanResult["fuel"]> {
  let rows = 0;
  let fresh = 0;
  let median: number | null = null;
  try {
    const res = await fetchWithCache(client, "/fuel_prices_all", undefined, { record: false });
    const d = unwrapData(res.data);
    if (d.kind === "rows") {
      const ages = d.rows
        .map((r) => toNumber(r.date_modified))
        .filter((t): t is number => t !== undefined && t > 0)
        .map((t) => (now - (t < 1e11 ? t * 1000 : t)) / DAY_MS)
        .sort((a, b) => a - b);
      rows = d.rows.length;
      fresh = ages.filter((a) => a <= 7).length;
      median = ages.length ? round(ages[Math.floor(ages.length / 2)], 1) : null;
    }
  } catch {
    // The block still explains the omission without the figures.
  }
  const stats = rows
    ? ` Of ${rows} fuel price rows, ${fresh} were reported within 7 days (median age ${median ?? "unknown"} days).`
    : " The fuel price table could not be read.";
  return {
    included: false,
    reason:
      "Fuel is NOT subtracted from the profit. UEX gives a price per unit of fuel without saying which unit, and no ship's quantum fuel burn per Gm is available in a verified unit, so a fuel cost would be invented." +
      stats +
      "",
    fuel_prices_rows: rows || null,
    rows_updated_within_7_days: rows ? fresh : null,
    median_age_days: median,
  };
}
