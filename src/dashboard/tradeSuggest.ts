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
import { parsePlan, type Plan } from "./plan.js";

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

export const suggestInputSchema = z.discriminatedUnion("action", [searchSchema, applySchema]);
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

export type SuggestAnswer = SuggestOk | SuggestThrottled | SuggestError | SuggestApplied;

// -------------------------------------------------------------------------------------------------
// Injected parts
// -------------------------------------------------------------------------------------------------

export interface FlownShip {
  /** The wiki's name for the ship (cleaned). */
  name: string | null;
  cargoScu: number | null;
  quantumSpeedMs: number | null;
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
  applyPlan: (plan: Plan, info: { private: boolean; withBalance: boolean }) => void;
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

interface StoredPlan {
  plan: Plan;
  priv: boolean;
  at: number;
}

export class TradeSuggestService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SuggestAnswer>>();
  private readonly plans = new Map<string, StoredPlan>();
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
    return this.search(input);
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
    this.deps.applyPlan(held.plan, { private: held.priv, withBalance });
    return { v: 1, state: "applied", plan: held.plan, private: held.priv };
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
    // holds. A typed budget is the player's own number, not a secret, and keeps its free cache.
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
      ship ? [ship.name, ship.cargoScu, ship.quantumSpeedMs] : null,
    ]);
  }

  private async run(
    input: SearchInput,
    ship: FlownShip | null,
    key: string,
    cargo: number,
  ): Promise<SuggestAnswer> {
    try {
      const origin = input.origin?.trim()
        ? await this.deps.resolveOrigin(input.origin).catch(() => ({
            terminalName: (input.origin ?? "").trim(),
          }))
        : undefined;
      const req: TripRequest = {
        objective: input.objective,
        cargoScu: cargo,
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
        ...(ship?.quantumSpeedMs ? { quantumSpeedMs: ship.quantumSpeedMs } : {}),
        ...(origin ? { origin } : {}),
        ...(input.avoid_pyro ? { avoidPyro: true } : {}),
        ...(input.armistice_only ? { armisticeOnly: true } : {}),
        ...(input.min_reports ? { minReports: input.min_reports } : {}),
        limit: 8,
      };
      const result = await this.deps.plan(req);
      const at = this.now();
      const ok = this.shape(result, input, ship, cargo, at);
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
    const options = res.options.slice(0, SUGGEST_MAX_OPTIONS).map((o) => this.option(o, priv, at));
    const chains = input.round_trip_only
      ? []
      : res.chains.slice(0, SUGGEST_MAX_CHAINS).map((o) => this.option(o, priv, at));
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
      cached: false,
      age_s: 0,
    };
  }

  private option(o: TripOption, priv: boolean, at: number): SuggestOption {
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
    };
    this.storePlan(id, option, priv, at);
    return option;
  }

  /** The plan "apply" will use: the outbound leg (a plan holds one commodity), the return named in the note. */
  private storePlan(id: string, o: SuggestOption, priv: boolean, at: number): void {
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
    this.plans.set(id, { plan, priv, at });
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
