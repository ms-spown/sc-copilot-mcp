import { createHash } from "node:crypto";
import {
  buildContracts,
  measureGain,
  type Contract,
  type LedgerBase,
} from "../../dashboard/ledger.js";
import { cleanLabel } from "../../core/untrusted.js";
import {
  buildTradeSection,
  TRADE_UNEXPLAINED_SHARE,
  type RunMoney,
  type TradePlan,
  type TradeRunView,
} from "../../dashboard/tradeRun.js";
import type { Transaction } from "../gamelog/trade.js";
import type { BalancePoint } from "../telemetry/service.js";
import type { TripInput } from "./types.js";

/**
 * Where the trips of a session come from. This file is the SEAM between the session store and whatever reads the
 * game's trade activity:
 *
 *  - `TripSource` is the whole contract. The session manager asks it for the trips it knows and for the last place
 *    and goods the log named; the store keeps what it returns, once (the `key` is a hash, never a game identifier).
 *  - `LedgerTripSource` is today's adapter: a completed CONTRACT of the transport ledger (dashboard/ledger.ts) is a
 *    trip, with the balance change the telemetry measured around it as its result. It writes no second parser.
 *  - `TradeRunTripSource` is the second adapter: a completed trade run of the dashboard's commerce model
 *    (dashboard/tradeRun.ts: turnover, cost, gross margin, fees, net, planned profit; one pairing, no second proration)
 *    is a trip of kind "trade".
 *  - `CompositeTripSource` merges several sources.
 *
 * A trip is returned only once it is SETTLED (its result no longer pending): the store freezes it, so a result is never
 * recomputed later from a balance history that restarts with the server.
 */

export interface TripCollection {
  trips: TripInput[];
  /** Trade runs a plan could be tied to, by trip key: how far each is from it (the closest one takes the plan). */
  plan_distance?: Record<string, number>;
  /** The last place and goods the log named, and when (estimate: the last step the log counted as done). */
  context: { location: string | null; commodity: string | null; at: string | null } | null;
}

export interface CollectOptions {
  /** Before a session closes or the server stops: a trip whose result is still settling is returned with it unknown. */
  final?: boolean;
}

export interface TripSource {
  collect(now: number, opts?: CollectOptions): Promise<TripCollection>;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Reads the contracts the ledger service holds, and the balance history the telemetry kept. */
export class LedgerTripSource implements TripSource {
  constructor(
    private readonly ledger: { state(): LedgerBase },
    private readonly history: () => Promise<readonly BalancePoint[]>,
  ) {}

  async collect(now: number, opts: CollectOptions = {}): Promise<TripCollection> {
    const base = this.ledger.state();
    if (base.status !== "ok") return { trips: [], context: null };
    const history: readonly BalancePoint[] = await this.history().catch(() => []);
    const trips: TripInput[] = [];
    for (const c of base.contracts) {
      if (c.state !== "completed" || c.endedMs === null) continue;
      const gain = measureGain(c, base.contracts, history, now);
      if (gain.reason === "pending" && !opts.final) continue; // not settled yet: the next look
      const hauling = c.steps.length > 0;
      const pickup = c.steps.find((s) => s.kind === "pickup");
      const drop = [...c.steps].reverse().find((s) => s.kind === "dropoff");
      // Two contracts that were open at the same time each hold the other's reward: summing them would count it twice,
      // so the result stays unknown. (Taking the next contract just AFTER this one ended is not an overlap.)
      const measurable = typeof gain.auec === "number" && !wasParallel(c, base.contracts, now);
      trips.push({
        key: hash(`contract|${c.id ?? ""}|${c.acceptedMs ?? ""}|${c.endedMs}|${c.title}`),
        kind: hauling ? "hauling" : "contract",
        source: "contract_ledger",
        started_at: iso(c.acceptedMs),
        ended_at: new Date(c.endedMs).toISOString(),
        label: cleanLabel(c.title, 80),
        commodity: cleanLabel(pickup?.cargo ?? drop?.cargo, 60),
        buy_terminal: cleanLabel(pickup?.location, 60),
        sell_terminal: cleanLabel(drop?.location, 60),
        net_auec: measurable ? (gain.auec as number) : null,
        net_kind: measurable ? "balance_delta" : null,
      });
    }
    return { trips, context: contextOf(base.contracts, base.asOf) };
  }
}

/** Another contract that could pay was open at some time between this one's acceptance and its end. */
function wasParallel(c: Contract, all: readonly Contract[], now: number): boolean {
  if (c.acceptedMs === null || c.endedMs === null) return false;
  return all.some((o) => {
    if (o === c || o.acceptedMs === null) return false;
    if (o.state === "abandoned" || o.state === "failed" || o.state === "ended") return false;
    const oEnd = o.endedMs ?? now;
    return o.acceptedMs < (c.endedMs as number) && oEnd > (c.acceptedMs as number);
  });
}

/** The last step the log counted as done, as "the last place and goods named" (an estimate: the log does not say which step). */
function contextOf(contracts: readonly Contract[], asOf: number | null) {
  for (let i = contracts.length - 1; i >= 0; i--) {
    const c = contracts[i];
    if (c.steps.length === 0 || c.objectivesDone === 0) continue;
    const step = c.steps[Math.min(c.objectivesDone, c.steps.length) - 1];
    if (!step) continue;
    return {
      location: cleanLabel(step.location, 60),
      commodity: cleanLabel(step.cargo, 60),
      at: iso(c.endedMs ?? asOf),
    };
  }
  return null;
}

// Re-exported for tests that build ledger bases from log events.
export { buildContracts };

// -------------------------------------------------------------------------------------------------
// The commerce model (trade runs)
// -------------------------------------------------------------------------------------------------

/**
 * A completed TRADE RUN of the dashboard's commerce model (dashboard/tradeRun.ts) is a trip of kind "trade". That model
 * is the ONE pairing of the game's commerce lines (the journal's first-in first-out pairing, providers/gamelog/trade.ts,
 * read incrementally by the ledger service): this adapter prorates nothing and pairs nothing itself, it copies the
 * run's figures: turnover, cost, gross margin, fees, the net (measured against the balance, or gross margin minus
 * measured fees) and the profit planned for it.
 *
 * Only runs that are complete and whose result is no longer pending are returned (the store freezes a trip). The log gives
 * a resource id, never a name, so the goods are named, and the plan tied to the run, in one of two ways (`planLinkOf`):
 * by name when the model could compare names (`plan_link: "name"`), else by the PRICES: the run's average buy and sell
 * price per SCU both within 15 % of the plan's, a bought quantity within a factor of 2.5 of the plan's (both known), and a
 * positive unit margin between half and twice the plan's
 * (`plan_link: "prices"`, an association by resemblance that the route calibration reports as unverified goods). A run tied
 * by name is named after the plan here; a run tied by prices is named by the session manager, and only on the one run that
 * carries the plan.
 */
export class TradeRunTripSource implements TripSource {
  constructor(
    private readonly transactions: () => readonly Transaction[] | undefined,
    private readonly history: () => Promise<readonly BalancePoint[]>,
    private readonly plan: () => TradePlan | undefined,
  ) {}

  async collect(now: number, opts: CollectOptions = {}): Promise<TripCollection> {
    const tx = this.transactions();
    if (tx === undefined) return { trips: [], context: null };
    const history: readonly BalancePoint[] = await this.history().catch(() => []);
    const section = buildTradeSection({
      transactions: tx,
      history,
      includeBalance: true,
      plan: this.plan(),
      nowMs: now,
    });
    const trips: TripInput[] = [];
    const distance: Record<string, number> = {};
    for (const run of section.runs) {
      const m = run.money;
      if (run.stage !== "complete" || !m) continue;
      if (m.net.reason === "en_cours" || (m.net.reason === "en_attente" && !opts.final)) continue;
      const plan = this.plan();
      const hit = planLinkOf(plan, run, m);
      const link = hit ? hit.link : null;
      if (hit) distance[hash(`run|${run.id}`)] = hit.distance;
      // By name only: a run tied to its plan by prices is named after the plan by the manager, on the run that carries it.
      const named = link === "name" ? cleanLabel(plan?.commodity, 60) : null;
      // The balance moved for another reason than the run (a purchase elsewhere, a reward): the net is then not the run's.
      const cap = (m.turnover ?? 0) * TRADE_UNEXPLAINED_SHARE;
      const doubtful =
        m.fees.reason !== undefined ||
        (m.fees.unexplained !== null && Math.abs(m.fees.unexplained) > cap);
      trips.push({
        // The run's own id (the time of its first transaction) is its identity: it does not change when a late sale
        // is added to the run (the end moves, the key does not), so the stored trip is REPLACED, not doubled.
        key: hash(`run|${run.id}`),
        kind: "trade",
        source: "trade_journal",
        started_at: run.started_at,
        ended_at: run.ended_at,
        label: named ? `Cargo ${named}` : null,
        commodity: named,
        scu: run.scu_sold ?? run.scu_bought,
        cost_auec: m.cost,
        revenue_auec: m.turnover,
        fees_auec: m.fees.total,
        gross_margin_auec: m.gross_margin,
        net_auec: m.net.auec,
        net_kind:
          m.net.auec === null ? null : m.net.method === "mesure" ? "balance_delta" : "transactions",
        planned_profit_auec: hit && plan ? (plan.expected_profit_auec ?? null) : null,
        fees_method: m.fees.total === null ? null : m.fees.method,
        unexplained_auec: m.fees.unexplained,
        net_doubtful: m.net.auec === null ? null : doubtful,
        plan_link: link,
        ...planFacts(link !== null ? plan : undefined),
      });
    }
    return { trips, context: null, plan_distance: distance };
  }
}

/**
 * The thresholds below are CHOICES made to keep a foreign run from taking a plan, not measurements: UEX prices are
 * crowdsourced and move, so a true run drifts from its plan, but a run of other goods, a flat or losing run must not pass.
 * A run that fails any test is not tied to the plan, which stays free for the right run.
 */
/** The run's average buy AND sell price per SCU must each be within this share of the plan's. */
export const PLAN_PRICE_TOLERANCE = 0.15;
/** The bought quantity must be within this factor of the plan's (both must be known). */
export const PLAN_SCU_FACTOR = 2.5;
/** The realised unit margin (sell minus buy) must be positive and within this band of the plan's unit margin. */
export const PLAN_MARGIN_BAND: readonly [number, number] = [0.5, 2];

export interface PlanLinkHit {
  link: "name" | "prices";
  /** How far the run is from the plan (0 for a name link); the closest candidate takes the plan. */
  distance: number;
}

/**
 * How a plan is tied to a completed run: by name when the commerce model could compare names ("ok"), else by prices (see
 * the header and the thresholds above). null when neither holds: the run then carries no plan, never a doubtful one. A plan
 * without both unit prices (and a positive unit margin) or without a quantity cannot be tied to a run whose goods have no
 * name.
 */
export function planLinkOf(
  plan: TradePlan | undefined,
  run: Pick<TradeRunView, "scu_bought">,
  money: Pick<RunMoney, "plan_match" | "avg_buy_per_scu" | "avg_sell_per_scu">,
): PlanLinkHit | null {
  if (!plan || typeof plan.expected_profit_auec !== "number") return null;
  if (money.plan_match === "ok") return { link: "name", distance: 0 };
  const { buy_unit_price: pb, sell_unit_price: ps, scu } = plan;
  if (typeof pb !== "number" || typeof ps !== "number" || !(pb > 0) || !(ps > 0)) return null;
  const planMargin = ps - pb;
  if (!(planMargin > 0)) return null;
  const b = money.avg_buy_per_scu;
  const s = money.avg_sell_per_scu;
  if (b === null || s === null || !(b > 0) || !(s > 0)) return null;
  const dBuy = Math.abs(b / pb - 1);
  const dSell = Math.abs(s / ps - 1);
  if (dBuy > PLAN_PRICE_TOLERANCE || dSell > PLAN_PRICE_TOLERANCE) return null;
  // Both quantities must be known: a plan with no quantity, or a run whose quantity is not known, is never tied by prices.
  if (typeof scu !== "number" || !(scu > 0) || run.scu_bought === null || !(run.scu_bought > 0))
    return null;
  const factor = run.scu_bought / scu;
  if (factor < 1 / PLAN_SCU_FACTOR || factor > PLAN_SCU_FACTOR) return null;
  const margin = s - b;
  if (!(margin > 0)) return null;
  const share = margin / planMargin;
  if (share < PLAN_MARGIN_BAND[0] || share > PLAN_MARGIN_BAND[1]) return null;
  return {
    link: "prices",
    distance: dBuy + dSell + Math.abs(Math.log(share)) + Math.abs(Math.log(factor)),
  };
}

/** What the plan said about its run beyond the profit: the quantity and the two terminals (null when not given). */
export function planFacts(
  plan: TradePlan | undefined,
): Pick<TripInput, "planned_scu" | "plan_buy_terminal" | "plan_sell_terminal"> {
  const scu = plan?.scu;
  return {
    planned_scu: typeof scu === "number" && Number.isFinite(scu) && scu > 0 ? scu : null,
    plan_buy_terminal: cleanLabel(plan?.buy_terminal, 60),
    plan_sell_terminal: cleanLabel(plan?.sell_terminal, 60),
  };
}

/** Several sources as one: their trips are concatenated, the first context found wins. */
export class CompositeTripSource implements TripSource {
  constructor(private readonly sources: readonly TripSource[]) {}

  async collect(now: number, opts: CollectOptions = {}): Promise<TripCollection> {
    const parts = await Promise.all(
      this.sources.map((s) =>
        s.collect(now, opts).catch((): TripCollection => ({ trips: [], context: null })),
      ),
    );
    return {
      trips: parts.flatMap((p) => p.trips),
      context: parts.map((p) => p.context).find((c) => c !== null) ?? null,
      // Without this the manager sees no distance and the OLDEST candidate wins instead of the closest.
      plan_distance: Object.assign({}, ...parts.map((p) => p.plan_distance ?? {})),
    };
  }
}
