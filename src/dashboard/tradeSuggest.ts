import axios from "axios";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { cleanLabel } from "../core/untrusted.js";
import type { PlaceIndex } from "../providers/uex/places.js";
import type {
  Objective,
  TripOption,
  TripPlanResult,
  TripRequest,
} from "../providers/uex/tripPlanner.js";
import { TripPlanError } from "../providers/uex/tripPlanner.js";
import {
  planIdentity,
  unknownPreflight,
  type PreflightIds,
  type PreflightPlan,
  type PreflightPlanEcho,
  type PreflightResult,
} from "../providers/uex/preflight.js";
import type { KnownHold } from "./holds.js";
import { parsePlan, type Plan } from "./plan.js";
import { describePreflight } from "./preflightText.js";
import {
  safeAssessReliability,
  markBetterChecked,
  type Reliability,
  type ReliabilityContext,
} from "./routeReliability.js";

/**
 * The server side of the commerce action bar: `sc_trade_suggest`, an app-only tool the View calls without the model.
 *
 * It is a thin, defensive layer over the trade planner (providers/uex/tripPlanner.ts, the code of `uex_plan_trade`):
 *
 *  - INPUT is validated (zod, strict): an objective, three or four switches, a budget, a hold size, one origin text.
 *    The ship is NEVER an input: its cargo and quantum speed come from this server's own state (the flown ship's wiki
 *    sheet), so the View cannot name a ship or inject a sheet.
 *  - OUTPUT is compact and bounded: at most 5 options and 3 chains (kept apart, as the planner does), every string
 *    cleaned and capped, no raw planner field. It never contains the budget, and when the View says the budget is the
 *    player's balance (`budget_private`) it also leaves out the cost of the trip.
 *  - RATE: UEX is a shared community service. In order: an identical request is answered from a short cache; an
 *    identical request still running is joined (one planner run, N Views); otherwise at most one NEW planner run every
 *    SUGGEST_MIN_INTERVAL_MS, whatever the View, with a plain "retry in N s" answer (a state, not an error). A failed
 *    run counts toward the interval and is never cached. The planner has its own deadline (shorter than the View's
 *    request timeout, so the server always finishes first).
 *  - APPLY: "apply as plan" is an action on the same tool, by the id of an option this server produced. The plan is
 *    built here from the option, cleaned by `parsePlan`, and stored with `setPlan` so the commerce card's planned
 *    figures follow. The View can never send plan text.
 *
 *  - PRE-FLIGHT: "preflight" re-reads the CURRENT UEX prices of the plan the server holds (the one the card follows) and
 *    answers whether it still holds (providers/uex/preflight.ts). It takes no plan text and no quantity from the View, uses
 *    and returns nothing derived from the balance (unit prices and per-SCU margins only), and shares the planner's throttle:
 *    a check and a search never run at once, and a new UEX read starts at most once per interval for everybody.
 *
 *  - HOLDS: "holds" lists the hold sizes known for the player (recent trade trips of the saved sessions, ships of his fleet
 *    file) for the form's "Soute" list. Local reads plus, when there is something to name, UEX's public ship list (which may
 *    be fetched once, cached 5 minutes, when the full screen opens). No argument, no planner run, no throttle slot, no balance; a size is
 *    a quantity moved or a fleet ship's hold, never a claim about the ship flown (dashboard/holds.ts says how it is worded).
 *
 * No network, no clock and no planner are imported here: all are injected (tests use fakes; nothing here opens a socket).
 */

export const SUGGEST_MIN_INTERVAL_MS = 8_000;
export const SUGGEST_CACHE_TTL_MS = 120_000;
/** The planner stops at this point and returns what it has; the View waits longer (see SUGGEST_VIEW_TIMEOUT_MS). */
export const SUGGEST_DEADLINE_MS = 20_000;
/** What the View waits for one call. Unverified against the real host's own limit. */
export const SUGGEST_VIEW_TIMEOUT_MS = 32_000;
export const SUGGEST_MAX_OPTIONS = 5;
export const SUGGEST_MAX_CHAINS = 3;
const MAX_CACHE_ENTRIES = 12;
// 12 cached answers of at most 8 options each, and no more: a plan lives as long as its answer (the cache TTL).
const MAX_PLANS = 160;
const MAX_NEXT_RUNS = 64;
const NAME_MAX = 60;
const NOTE_MAX = 200;

export const OBJECTIVES = ["profit", "profit_per_hour", "speed", "safety"] as const;

const searchSchema = z
  .object({
    action: z.literal("search"),
    objective: z.enum(OBJECTIVES).default("profit_per_hour"),
    avoid_pyro: z.boolean().optional(),
    armistice_only: z.boolean().optional(),
    /** 0 = estimates are kept (and marked); 1 or more = player reports required at every end. */
    min_reports: z.number().int().min(0).max(20).optional(),
    /** Hide the open A>B>C chains (they are never ranked against what comes back to the start). */
    round_trip_only: z.boolean().optional(),
    budget: z.number().positive().max(1e12).optional(),
    /** The budget is derived from the player's balance: the answer then carries no cost and nothing derived is shared. */
    budget_private: z.boolean().optional(),
    cargo_scu: z.number().int().min(1).max(100_000).optional(),
    /**
     * "Et ensuite ?": the id of the run this suggestion is for. The server remembers it, so a View that is mounted
     * again (the host remounts iframes) does not search a second time for the same run.
     */
    next_run: z
      .string()
      .regex(/^[0-9A-Za-z:.+-]{1,40}$/)
      .optional(),
    origin: z.string().max(80).optional(),
    /** Use the flown ship's quantum speed (and hold, when no cargo_scu is given). Default true. */
    use_ship: z.boolean().optional(),
  })
  .strict();

const applySchema = z
  .object({
    action: z.literal("apply"),
    /** 128 random bits (see TradeSuggestService.option): not guessable, not sequential. */
    id: z.string().regex(/^[a-f0-9]{32}$/),
    /** The balance is shown in the View: a plan built from the balance may then reach the saved session. */
    with_balance: z.boolean().optional(),
  })
  .strict();

/** No argument: the plan checked is the one this server holds, never one the View describes. */
const preflightSchema = z.object({ action: z.literal("preflight") }).strict();

/** No argument: the hold sizes this server knows for the player (saved trade trips, fleet file). Never a planner run. */
const holdsSchema = z.object({ action: z.literal("holds") }).strict();

export const suggestInputSchema = z.discriminatedUnion("action", [
  searchSchema,
  applySchema,
  preflightSchema,
  holdsSchema,
]);
export type SuggestInput = z.infer<typeof suggestInputSchema>;
type SearchInput = z.infer<typeof searchSchema>;

// -------------------------------------------------------------------------------------------------
// Answer
// -------------------------------------------------------------------------------------------------

export interface SuggestLeg {
  commodity: string;
  from: string;
  to: string;
  system: string | null;
  buy_price: number;
  sell_price: number;
  profit_per_scu: number;
  scu: number;
  /** "hidden" when the budget is the player's balance: that a leg is limited by it would reveal it. */
  limited_by: "cargo" | "budget" | "stock" | "hidden";
  /** Oldest of the two prices, in days (null: UEX gives no date). */
  age_days: number | null;
  report_status: "reported" | "estimate" | "unverified";
  /** UEX `is_armistice` of each end: true, false, or null when UEX does not say. */
  armistice: { from: boolean | null; to: boolean | null };
}

export interface SuggestOption {
  /** Random (128 bits), valid for "apply" for as long as the answer is in this server's memory (the cache TTL). */
  id: string;
  mode: "one_way" | "round_trip" | "two_leg";
  /** "A → B → A" (cycle) or "A → B → C" (chain). */
  route: string;
  legs: SuggestLeg[];
  profit_per_trip: number;
  profit_per_scu: number;
  scu_moved: number;
  /** Null when no quantum speed is known for a flight longer than a hop. */
  profit_per_hour: number | null;
  cycle_minutes: number | null;
  report_status: "reported" | "estimate" | "unverified";
  /** True when at least one price has no player report at UEX: do not count on it. */
  estimate: boolean;
  stale: boolean;
  oldest_age_days: number | null;
  /** The planner's heuristic: always a rule of thumb over UEX place data, never a promise. */
  safety: {
    heuristic: true;
    exposure: "lower" | "medium" | "higher";
    points: number;
    factors: string[];
  };
  /** Absent when the budget is the player's balance. */
  cost?: number;
  /** How far the figures can be trusted: level, reasons with their source, a prudent first run (dashboard/routeReliability.ts). */
  reliability: Reliability;
}

export interface SuggestOk {
  v: 1;
  state: "ok";
  objective: Objective;
  options: SuggestOption[];
  chains: SuggestOption[];
  counts: { reported: number; estimate: number; unverified: number };
  cargo_scu: number;
  /** "fiche": the hold of the flown ship (sent or not by the page); "saisie": a hold the player typed. */
  cargo_source: "saisie" | "fiche";
  /** The budget is the player's balance: quantities and totals below are for his screen only. */
  private: boolean;
  ship: string | null;
  /** Whether a quantum speed was known: without one, hourly figures and the order by time are not available. */
  speed_known: boolean;
  stop_minutes: number;
  /** The planner ran out of time and returned what it had. */
  partial: boolean;
  /** Some player-report checks failed or were skipped: more options are "unverified" than usual. */
  reports_incomplete: boolean;
  armistice_degraded: boolean;
  /** Short planner remarks, cleaned (English). */
  notes: string[];
  /**
   * The starting place as the server resolved it (a planet, a system or a terminal), cleaned: the message to the agent needs the
   * right key of `uex_plan_trade` (origin_planet_name, origin_system_name or origin_terminal_name). null: no origin.
   */
  origin: { kind: "planet" | "system" | "terminal"; name: string } | null;
  /** True when this answer was served from the short cache. */
  cached: boolean;
  age_s: number;
}

export interface SuggestThrottled {
  v: 1;
  state: "throttled";
  retry_after_s: number;
}

export type SuggestErrorCode =
  | "no_cargo"
  | "bad_origin"
  | "armistice_unavailable"
  | "upstream"
  | "expired"
  | "off"
  | "done"
  | "other";

export interface SuggestError {
  v: 1;
  state: "error";
  code: SuggestErrorCode;
  detail?: string;
}

export interface SuggestApplied {
  v: 1;
  state: "applied";
  plan: Plan;
  /** Built from a budget that is the player's balance: the View hides it, and drops it, when the balance is hidden. */
  private: boolean;
}

/**
 * The hold sizes known for the player (dashboard/holds.ts), newest first. A size is a quantity moved by recent runs or a
 * fleet ship's hold: never a claim about the ship flown now. No amount of any kind.
 */
export interface SuggestHolds {
  v: 1;
  state: "holds";
  holds: KnownHold[];
}

export type SuggestAnswer =
  SuggestOk | SuggestThrottled | SuggestError | SuggestApplied | SuggestHolds | PreflightResult;

// -------------------------------------------------------------------------------------------------
// Injected parts
// -------------------------------------------------------------------------------------------------

export interface FlownShip {
  /** The wiki's name for the ship (cleaned). */
  name: string | null;
  cargoScu: number | null;
  quantumSpeedMs: number | null;
  /** The sheet's spool-up: the planner then times a flight as `ship_name` does (it would use its 10 s default otherwise). */
  spoolSeconds?: number | null;
}

export interface SuggestDeps {
  /** The planner (providers/uex/tripPlanner.ts planTrips with the clients bound). */
  plan: (req: TripRequest) => Promise<TripPlanResult>;
  /** The flown ship, from the server's own state. null: no ship known. Must not throw (a failure is null). */
  ship: () => Promise<FlownShip | null>;
  /** From the text of the player to the planner's origin hint. */
  resolveOrigin: (text: string) => Promise<NonNullable<TripRequest["origin"]>>;
  /**
   * Stores the plan (memory only): in the dashboard service always, and in the saved session unless the plan is
   * private and the balance is not shown.
   */
  applyPlan: (
    plan: Plan,
    info: { private: boolean; withBalance: boolean; ids: PreflightIds },
  ) => void;
  /**
   * The plan the dashboard holds (the commerce card's). The pre-flight check reads it here: the View never names it.
   * Only names and unit prices are used.
   */
  currentPlan?: () => PreflightPlan | undefined;
  /** The UEX ids of that plan's terminals, when the planner built it (else undefined: the names are matched). */
  currentPlanIds?: () => PreflightIds | undefined;
  /** Reads UEX and judges the plan (providers/uex/preflight.ts runPreflight with the client bound). Must not throw. */
  preflight?: (plan: PreflightPlanEcho, ids?: PreflightIds) => Promise<PreflightResult>;
  /**
   * The hold sizes of the player's recent trade trips and fleet (dashboard/holds.ts). Must not throw (a failure is an
   * empty list). Absent: nothing is known.
   */
  holds?: () => Promise<KnownHold[]>;
  now?: () => number;
  minIntervalMs?: number;
  cacheTtlMs?: number;
}

/** "Lorville", a planet or a system as a name the planner understands; anything else is a terminal name. */
export function resolveOriginHint(
  places: Pick<PlaceIndex, "byTerminal">,
  text: string,
): NonNullable<TripRequest["origin"]> {
  const wanted = text.trim().toLowerCase();
  let planet: string | undefined;
  let system: string | undefined;
  for (const p of places.byTerminal.values()) {
    if (p.planetName && p.planetName.toLowerCase() === wanted) planet = p.planetName;
    if (p.systemName && p.systemName.toLowerCase() === wanted) system = p.systemName;
  }
  if (planet) return { planetName: planet };
  if (system) return { systemName: system };
  return { terminalName: text.trim() };
}

// -------------------------------------------------------------------------------------------------
// The service
// -------------------------------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  ok: SuggestOk;
}

interface PreflightEntry {
  at: number;
  result: PreflightResult;
}

interface StoredPlan {
  plan: Plan;
  priv: boolean;
  at: number;
  /** UEX ids of the outbound leg's two terminals (server-side only: never in an answer, never from the page). */
  ids: PreflightIds;
}

export class TradeSuggestService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SuggestAnswer>>();
  private readonly plans = new Map<string, StoredPlan>();
  /** Pre-flight answers by plan identity (bounded, memory only, same lifetime as the search cache). */
  private readonly preflights = new Map<string, PreflightEntry>();
  /** Runs an "Et ensuite ?" suggestion was already computed for (bounded, memory only). */
  private readonly nextRuns = new Set<string>();
  private lastStartAt = Number.NEGATIVE_INFINITY;
  /** The last private-budget lookup (cache, join or run): see the cache-oracle note in `search`. */
  private lastPrivateLookupAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly minInterval: number;
  private readonly ttl: number;

  constructor(private readonly deps: SuggestDeps) {
    this.now = deps.now ?? Date.now;
    this.minInterval = deps.minIntervalMs ?? SUGGEST_MIN_INTERVAL_MS;
    this.ttl = deps.cacheTtlMs ?? SUGGEST_CACHE_TTL_MS;
  }

  /** Runs one validated input. Never throws: every failure is a state of the answer. */
  async handle(input: SuggestInput): Promise<SuggestAnswer> {
    this.prune();
    if (input.action === "apply") return this.apply(input.id, input.with_balance === true);
    if (input.action === "preflight") return this.preflight();
    if (input.action === "holds") return this.holds();
    return this.search(input);
  }

  /**
   * The known hold sizes: saved sessions, the fleet file and UEX's public ship list (a live GET when its 5-minute memory is
   * cold: this is asked when the full screen opens, before any click). It takes no slot of the planner's throttle and never
   * waits for a search. Never throws.
   */
  private async holds(): Promise<SuggestAnswer> {
    const list = await (this.deps.holds?.() ?? Promise.resolve([])).catch(() => []);
    return { v: 1, state: "holds", holds: list };
  }

  /** Plans live as long as the cached answers they come from. */
  private prune(): void {
    const t = this.now();
    for (const [id, p] of this.plans) {
      if (t - p.at < 0 || t - p.at >= this.ttl) this.plans.delete(id);
    }
  }

  private apply(id: string, withBalance: boolean): SuggestAnswer {
    const held = this.plans.get(id);
    if (!held) return { v: 1, state: "error", code: "expired" };
    this.deps.applyPlan(held.plan, { private: held.priv, withBalance, ids: held.ids });
    return { v: 1, state: "applied", plan: held.plan, private: held.priv };
  }

  /**
   * The pre-flight check of the plan in force. A plan the check cannot use (none, no terminals, no unit prices) is answered
   * at once and costs nothing. Otherwise, in order: the short memory; a check already running is joined; at most one new
   * UEX read per interval, none while a search runs (a state, not an error). A failed read counts toward the interval and
   * is never kept.
   */
  private preflight(): Promise<SuggestAnswer> | SuggestAnswer {
    const held = this.deps.currentPlan?.();
    if (!held) return describePreflight(unknownPreflight("no_plan", null));
    const echo = planIdentity(held);
    if (!echo || !this.deps.preflight)
      return describePreflight(unknownPreflight("plan_incomplete", null));
    const ids = this.deps.currentPlanIds?.();
    const key =
      "preflight|" +
      JSON.stringify([...Object.values(echo).map((v) => String(v).toLowerCase()), ids ?? null]);
    const t = this.now();
    const kept = this.preflights.get(key);
    if (kept && t - kept.at >= 0 && t - kept.at < this.ttl) {
      return { ...kept.result, cached: true, age_s: Math.round((t - kept.at) / 1000) };
    }
    if (kept) this.preflights.delete(key);
    const running = this.inFlight.get(key);
    if (running) return running;
    const sinceStart = t - this.lastStartAt;
    const busy = this.inFlight.size > 0;
    if (busy || (sinceStart >= 0 && sinceStart < this.minInterval)) {
      const wait = Math.ceil((this.minInterval - Math.max(0, sinceStart)) / 1000);
      return { v: 1, state: "throttled", retry_after_s: Math.max(busy ? 3 : 1, wait) };
    }
    this.lastStartAt = t;
    const check = this.deps.preflight;
    const job: Promise<SuggestAnswer> = Promise.resolve()
      .then(() => check(echo, ids))
      .then((raw) => {
        const result = describePreflight(raw);
        // Only a real verdict is kept: "impossible de vérifier" (UEX down, a stale copy) is asked again.
        if (result.verdict !== "unknown") this.rememberPreflight(key, result, this.now());
        return result;
      })
      .catch((error: unknown) => failure(error))
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, job);
    return job;
  }

  private rememberPreflight(key: string, result: PreflightResult, at: number): void {
    this.preflights.set(key, { at, result });
    while (this.preflights.size > MAX_CACHE_ENTRIES) {
      const oldest = this.preflights.keys().next().value;
      if (oldest === undefined) break;
      this.preflights.delete(oldest);
    }
  }

  private markNext(runId: string | undefined): void {
    if (!runId) return;
    this.nextRuns.add(runId);
    while (this.nextRuns.size > MAX_NEXT_RUNS) {
      const oldest = this.nextRuns.values().next().value;
      if (oldest === undefined) break;
      this.nextRuns.delete(oldest);
    }
  }

  private async search(input: SearchInput): Promise<SuggestAnswer> {
    // A suggestion for a completed run is computed once, whichever View asks (and however often it is mounted).
    if (input.next_run && this.nextRuns.has(input.next_run)) {
      return { v: 1, state: "error", code: "done" };
    }
    const ship = input.use_ship === false ? null : await this.deps.ship().catch(() => null);
    // No hold size: nothing to ask UEX, and nothing that should count toward the interval.
    const cargo = input.cargo_scu ?? ship?.cargoScu ?? undefined;
    if (cargo === undefined || cargo < 1) return { v: 1, state: "error", code: "no_cargo" };
    const key = this.keyOf(input, ship);
    const t = this.now();
    const priv = input.budget_private === true;

    // A private budget is the player's balance. A cache or an in-flight join that answers "yes, a run with exactly this
    // budget was made" (cached: true, no wait) would let a caller who can reach this tool find the balance by trying
    // values. So a private lookup is rate limited like a run, hit or miss: one guess per interval, whatever the cache
    // holds. The slot is taken before the general throttle below: a refused attempt costs as much as an accepted one, or
    // misses would be free while hits stayed visible. A typed budget is the player's own number and keeps its free cache.
    if (priv) {
      const sincePrivate = t - this.lastPrivateLookupAt;
      if (sincePrivate >= 0 && sincePrivate < this.minInterval) {
        const wait = Math.ceil((this.minInterval - sincePrivate) / 1000);
        return { v: 1, state: "throttled", retry_after_s: Math.max(1, wait) };
      }
      this.lastPrivateLookupAt = t;
    }

    // 1. the short cache. An entry is only served to a caller in the same private context as the one it was made for
    // (the key carries the flag; this check is the belt to that brace).
    const held = this.cache.get(key);
    if (held && held.ok.private === priv && t - held.at >= 0 && t - held.at < this.ttl) {
      this.markNext(input.next_run);
      return { ...held.ok, cached: true, age_s: Math.round((t - held.at) / 1000) };
    }
    if (held) this.cache.delete(key);

    // 2. an identical run in progress is joined
    const running = this.inFlight.get(key);
    if (running) {
      this.markNext(input.next_run);
      return running;
    }

    // 3. at most one new planner run per interval, for everybody, and none while another is still running (a slow
    // planner must not let several runs for different questions pile up)
    const sinceStart = t - this.lastStartAt;
    const busy = this.inFlight.size > 0;
    if (busy || (sinceStart >= 0 && sinceStart < this.minInterval)) {
      const wait = Math.ceil((this.minInterval - Math.max(0, sinceStart)) / 1000);
      return { v: 1, state: "throttled", retry_after_s: Math.max(busy ? 3 : 1, wait) };
    }

    // 4. start
    this.markNext(input.next_run);
    this.lastStartAt = t;
    const job = this.run(input, ship, key, cargo).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, job);
    return job;
  }

  private keyOf(input: SearchInput, ship: FlownShip | null): string {
    return JSON.stringify([
      input.objective,
      !!input.avoid_pyro,
      !!input.armistice_only,
      input.min_reports ?? 0,
      !!input.round_trip_only,
      input.budget ?? null,
      !!input.budget_private,
      input.cargo_scu ?? null,
      (input.origin ?? "").trim().toLowerCase(),
      ship ? [ship.name, ship.cargoScu, ship.quantumSpeedMs, ship.spoolSeconds ?? null] : null,
    ]);
  }

  private async run(
    input: SearchInput,
    ship: FlownShip | null,
    key: string,
    cargo: number,
  ): Promise<SuggestAnswer> {
    try {
      const origin: TripRequest["origin"] | undefined = input.origin?.trim()
        ? await this.deps.resolveOrigin(input.origin).catch(() => ({
            terminalName: (input.origin ?? "").trim(),
          }))
        : undefined;
      const req: TripRequest = {
        objective: input.objective,
        cargoScu: cargo,
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
        ...(ship?.quantumSpeedMs ? { quantumSpeedMs: ship.quantumSpeedMs } : {}),
        ...(ship?.quantumSpeedMs && ship.spoolSeconds ? { spoolSeconds: ship.spoolSeconds } : {}),
        ...(origin ? { origin } : {}),
        ...(input.avoid_pyro ? { avoidPyro: true } : {}),
        ...(input.armistice_only ? { armisticeOnly: true } : {}),
        ...(input.min_reports ? { minReports: input.min_reports } : {}),
        limit: 8,
      };
      const result = await this.deps.plan(req);
      const at = this.now();
      const ok = this.shape(result, input, ship, cargo, at);
      if (origin) {
        const kind = origin.planetName ? "planet" : origin.systemName ? "system" : "terminal";
        const name = cleanLabel(
          origin.planetName ?? origin.systemName ?? origin.terminalName ?? input.origin ?? "",
          NAME_MAX,
        );
        if (name) ok.origin = { kind, name };
      }
      this.remember(key, ok, at);
      return ok;
    } catch (error) {
      return failure(error);
    }
  }

  private remember(key: string, ok: SuggestOk, at: number): void {
    this.cache.set(key, { at, ok });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private shape(
    res: TripPlanResult,
    input: SearchInput,
    ship: FlownShip | null,
    cargo: number,
    at: number,
  ): SuggestOk {
    const priv = input.budget_private === true;
    const rel: ReliabilityContext = {
      speedKnown: res.time_model.quantum_speed_ms !== null,
      stopMinutes: res.time_model.stop_minutes,
      localHopMinutes: res.time_model.local_hop_minutes,
      private: priv,
    };
    const options = res.options
      .slice(0, SUGGEST_MAX_OPTIONS)
      .map((o) => this.option(o, priv, at, rel));
    const chains = input.round_trip_only
      ? []
      : res.chains.slice(0, SUGGEST_MAX_CHAINS).map((o) => this.option(o, priv, at, rel));
    markBetterChecked(options);
    markBetterChecked(chains);
    const counts = { reported: 0, estimate: 0, unverified: 0 };
    for (const o of [...options, ...chains]) counts[o.report_status]++;
    const notes = res.notes
      .map((n) => cleanLabel(n, NOTE_MAX))
      .filter((n): n is string => n !== null)
      .slice(0, 4);
    const speedKnown = res.time_model.quantum_speed_ms !== null;
    return {
      v: 1,
      state: "ok",
      objective: res.objective,
      options,
      chains,
      counts,
      cargo_scu: cargo,
      // The page sends the hold only when the player typed one; a typed hold equal to the ship's is still the ship's.
      cargo_source:
        input.cargo_scu !== undefined && input.cargo_scu !== ship?.cargoScu ? "saisie" : "fiche",
      private: priv,
      ship: ship ? cleanLabel(ship.name, NAME_MAX) : null,
      speed_known: speedKnown,
      stop_minutes: res.time_model.stop_minutes,
      partial: res.notes.some((n) => /ran out/i.test(n)),
      reports_incomplete: res.notes.some((n) =>
        /player-report check|not checked for player reports/i.test(n),
      ),
      armistice_degraded: res.notes.some((n) => /Safety heuristic degraded/i.test(n)),
      notes,
      origin: null,
      cached: false,
      age_s: 0,
    };
  }

  private option(o: TripOption, priv: boolean, at: number, rel: ReliabilityContext): SuggestOption {
    const id = randomBytes(16).toString("hex");
    const legs: SuggestLeg[] = o.legs.slice(0, 2).map((l) => {
      const ages = [l.price_age_days.buy, l.price_age_days.sell].filter(
        (a): a is number => a !== null,
      );
      return {
        commodity: cleanLabel(l.commodity, NAME_MAX) ?? "?",
        from: cleanLabel(l.from.terminal, NAME_MAX) ?? "?",
        to: cleanLabel(l.to.terminal, NAME_MAX) ?? "?",
        system: cleanLabel(l.from.system, 40),
        buy_price: l.buy_price,
        sell_price: l.sell_price,
        profit_per_scu: l.profit_per_scu,
        scu: l.scu,
        limited_by: priv && l.limited_by === "budget" ? "hidden" : l.limited_by,
        age_days: ages.length ? Math.max(...ages) : null,
        report_status: l.report_status,
        armistice: { from: l.from.armistice_zone, to: l.to.armistice_zone },
      };
    });
    const first = legs[0] ?? { from: "?", to: "?" };
    const names = [first.from, ...legs.map((l) => l.to)];
    // A one-way route is repeated with an empty return: the cycle ends where it started.
    if (o.trip.returns_to_start && o.mode === "one_way") names.push(first.from);
    const option: SuggestOption = {
      id,
      mode: o.mode,
      route: names.join(" → "),
      legs,
      profit_per_trip: o.trip.profit_per_cycle,
      profit_per_scu: o.trip.profit_per_scu,
      scu_moved: o.trip.scu_moved,
      profit_per_hour: o.trip.profit_per_hour,
      cycle_minutes:
        o.trip.cycle_seconds === null ? null : Math.max(1, Math.round(o.trip.cycle_seconds / 60)),
      report_status: o.report_status,
      estimate: o.estimate,
      stale: o.data_age.stale,
      oldest_age_days: o.data_age.oldest_price_age_days,
      safety: {
        heuristic: true,
        exposure: o.safety.exposure,
        points: o.safety.points,
        factors: o.safety.factors
          .slice(0, 4)
          .map((f) => cleanLabel(f, 140))
          .filter((f): f is string => f !== null),
      },
      ...(priv ? {} : { cost: o.trip.peak_investment }),
      reliability: safeAssessReliability(o, rel),
    };
    this.storePlan(id, option, priv, at, {
      buy: o.legs[0]?.from.terminal_id ?? null,
      sell: o.legs[0]?.to.terminal_id ?? null,
    });
    return option;
  }

  /** The plan "apply" will use: the outbound leg (a plan holds one commodity), the return named in the note. */
  private storePlan(
    id: string,
    o: SuggestOption,
    priv: boolean,
    at: number,
    ids: PreflightIds,
  ): void {
    const leg = o.legs[0];
    if (!leg) return;
    const second = o.legs[1];
    const note =
      second && o.mode === "round_trip"
        ? `Retour : ${second.commodity}`
        : second
          ? `Puis : ${second.commodity} vers ${second.to}`
          : "Cycle complet : retour à vide";
    const plan = parsePlan({
      commodity: leg.commodity,
      buy_terminal: leg.from,
      sell_terminal: leg.to,
      scu: leg.scu,
      expected_profit_auec: Math.round(leg.profit_per_scu * leg.scu),
      buy_unit_price: leg.buy_price,
      sell_unit_price: leg.sell_price,
      ...(o.cycle_minutes !== null ? { est_trip_minutes: o.cycle_minutes } : {}),
      safety_note: `Heuristique : ${o.safety.points} facteur(s) de risque`,
      note,
    });
    if (!plan) return;
    this.plans.set(id, { plan, priv, at, ids });
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
  }
}

/** A planner failure as a state of the answer: a code for the View's sentence, a cleaned detail only for a bad name. */
export function failure(error: unknown): SuggestError {
  if (error instanceof TripPlanError) {
    const m = error.message;
    if (/cargo|hold size/i.test(m)) return { v: 1, state: "error", code: "no_cargo" };
    if (/armistice_only cannot/i.test(m))
      return { v: 1, state: "error", code: "armistice_unavailable" };
    if (/No UEX|matches several|called "/i.test(m)) {
      const detail = cleanLabel(m, 160);
      return { v: 1, state: "error", code: "bad_origin", ...(detail ? { detail } : {}) };
    }
    if (/no prices|time allowed|could not be read|no answer/i.test(m))
      return { v: 1, state: "error", code: "upstream" };
    const detail = cleanLabel(m, 160);
    return { v: 1, state: "error", code: "other", ...(detail ? { detail } : {}) };
  }
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return {
      v: 1,
      state: "error",
      code: "upstream",
      detail: status ? `HTTP ${status}` : (cleanLabel(error.code ?? "", 40) ?? "no answer"),
    };
  }
  return { v: 1, state: "error", code: "other" };
}
