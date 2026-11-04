import { createHash } from "node:crypto";
import {
  buildContracts,
  measureGain,
  type Contract,
  type LedgerBase,
} from "../../dashboard/ledger.js";
import { cleanLabel } from "../../core/untrusted.js";
import { buildTradeSection, type TradePlan } from "../../dashboard/tradeRun.js";
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
 * Only runs that are complete and whose result is no longer pending are returned (the store freezes a trip). Goods are
 * named only when the plan Claude passed matches the run: the log gives a resource id, never a name.
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
    for (const run of section.runs) {
      const m = run.money;
      if (run.stage !== "complete" || !m) continue;
      if (m.net.reason === "en_cours" || (m.net.reason === "en_attente" && !opts.final)) continue;
      const named = m.plan_match === "ok" ? cleanLabel(this.plan()?.commodity, 60) : null;
      trips.push({
        // The run's own id is the time of its first transaction: stable, and hashed with its end.
        key: hash(`run|${run.id}|${run.ended_at}`),
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
        planned_profit_auec: m.plan_match === "ok" ? m.planned_profit : null,
      });
    }
    return { trips, context: null };
  }
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
    };
  }
}
