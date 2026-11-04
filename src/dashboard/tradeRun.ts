import { cleanLabel } from "../core/untrusted.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import { pairCargoRuns, type Transaction } from "../providers/gamelog/trade.js";
import { priceRefusalsOf, type PriceRefusal } from "../providers/gamelog/priceRefusals.js";
import { lossCuts, type ShipLoss } from "../providers/gamelog/shipLoss.js";
import type { RunDecomposition } from "./balanceMovements.js";

/**
 * The commerce model: from the transactions of a trading run, the balance history and the optional plan, what the
 * run really earned. PURE (no file, no network, no clock of its own, no Node module), so the preview can import it.
 *
 * WHICH FIGURE IS WHICH (the whole point of this module; the old "Prévu / Réalisé" block compared a profit with a
 * balance change, which are not the same thing):
 *   - bénéfice prévu      = the plan's expected profit (a margin before any fee, from market prices).
 *   - chiffre d'affaires  = what the sales brought in (the amounts of the sell transactions).
 *   - coût d'achat        = what the purchases cost (the amounts of the buy transactions).
 *   - marge brute         = the journal's own first-in first-out pairing per commodity (`pairCargoRuns`, the one behind
 *                           `sc_trade_journal`): revenue of the paired SCU minus their cost. Comparable with the planned
 *                           profit. Unsold SCU and sold SCU that were not bought in the run (stock from before) are not
 *                           valued, so the card and the journal can never disagree in sign. Remaining differences: the
 *                           model pairs the transactions of one run, the journal those of one commodity over the session.
 *   - écart de prix       = marge brute - bénéfice prévu (prices AND quantities: both move it).
 *   - frais               = what the loading service took on top of the prices. The log has NO fee line: they are
 *                           measured against the balance (see reconcileFees) or inferred from the difference, and the
 *                           inferred total is refused when it is not a plausible fee (0 to 50 % of the turnover).
 *   - bénéfice net        = balance at the end - balance just before the first purchase: the VARIATION OF THE BALANCE
 *                           over the run, so it holds every movement of that time (a reward, another purchase), not only
 *                           the run. `fees.unexplained` says how much of it the margin and the fees do not explain.
 *
 * PRIVACY: every figure that is an amount of aUEC lives in `money`, which is built ONLY when the View asked for the
 * balance. Without it a run carries commodity, places, quantities, times and counts, nothing else.
 *
 * NOTHING IS INVENTED: a figure that cannot be known is null and says why; an estimate is labelled as one
 * (`method`), with what it was inferred from.
 */

// -------------------------------------------------------------------------------------------------
// Bounds and tolerances
// -------------------------------------------------------------------------------------------------

/** Where the transactions come from: the trade journal of the game log (providers/gamelog/trade.ts). */
export type TradeSource = () => readonly Transaction[] | undefined;

/** Transactions kept in memory and examined. */
export const TRADE_MAX_TRANSACTIONS = 400;
/** Runs returned in the payload (newest first). */
export const TRADE_MAX_RUNS = 4;
/** Price refusals (the game refused a transaction because the price moved) returned in the payload, newest last. */
export const TRADE_MAX_REFUSALS = 3;
/** Ship losses (the player's ship destroyed with him aboard) returned in the payload, newest last. */
export const TRADE_MAX_LOSSES = 5;
/** Labels (commodity, shop) taken from the log. */
export const TRADE_LABEL_MAX = 60;
/** More than this between two transactions: another run. */
export const TRADE_RUN_GAP_MS = 2 * 3_600_000;
/** Transactions of one side this close to each other are settled together (one "cluster"). */
export const TRADE_CLUSTER_GAP_MS = 20_000;
/**
 * A log line and the balance change it causes are matched within this window around the cluster. The log's time is
 * the game's and the balance's time is this server's clock when the frame arrived: the window absorbs the skew and the
 * delay of a fee charged a moment after the sale. The values are ASSUMPTIONS, not measured with the real game.
 */
export const TRADE_MATCH_BEFORE_MS = 2_000;
export const TRADE_MATCH_AFTER_MS = 8_000;
/** The final balance is read this long after the last transaction (a fee may be charged just after it). */
export const TRADE_SETTLE_MS = 8_000;
/** A balance point answers for an instant at most this long after its last frame (as in ledger.ts). */
export const TRADE_GAP_TOLERANCE_MS = 3_000;
/** No hourly rate under this much run time. */
export const TRADE_MIN_RATE_MS = 120_000;
/** A fee above this share of the transaction is not a fee: the match is refused. */
export const TRADE_MAX_FEE_SHARE = 0.5;
/** Hypothesis for "per day": hours of play. Said as such wherever it is shown. */
export const TRADE_DAY_HOURS = 4;
/** Sold quantity within this share of the bought one counts as "everything sold" (when the pairing is not possible). */
const SOLD_ALL = 0.995;
/** Overhead assumed per cycle when only one run was seen: loading, empty trip, waiting. NOT measured. */
export const TRADE_OVERHEAD_MS = 10 * 60_000;
/** The unexplained part of the balance is flagged above this share of the turnover. */
export const TRADE_UNEXPLAINED_SHARE = 0.02;
/** SCU below this are rounding noise. */
const SCU_EPS = 0.01;

// -------------------------------------------------------------------------------------------------
// Public shapes
// -------------------------------------------------------------------------------------------------

/** What the model knows of the plan (a subset of dashboard/plan.ts, without the free text). */
export interface TradePlan {
  commodity?: string;
  scu?: number;
  expected_profit_auec?: number;
  buy_unit_price?: number;
  sell_unit_price?: number;
  /** The plan's two terminals (UEX names): kept on the saved trip for the route calibration, never shown by the model. */
  buy_terminal?: string;
  sell_terminal?: string;
}

export type RunStage =
  /** Bought, nothing sold yet. */
  | "open"
  /** Bought and part of it sold. */
  | "partial"
  /** Everything bought was sold. */
  | "complete"
  /** Sales without a purchase in view (the purchase is before what the dashboard saw). */
  | "sold_only";

/** How a figure was obtained. */
export type Method = "mesure" | "calcule" | "estime";

export interface SideFee {
  /** aUEC charged on top of the prices of this side. */
  auec: number;
  /**
   * `exact`: one transaction in its window, the fee is the balance change minus the price.
   * `groupe`: several transactions of the side settled together, the fee is for the group.
   * `estime`: inferred from the difference between the gross margin and the net (not seen against the balance).
   */
  method: "exact" | "groupe" | "estime";
}

export interface FeeReport {
  /** Total fees; null when neither measured nor inferable. */
  total: number | null;
  /** `mesure`: both sides seen against the balance. `estime`: gross margin minus net (total only). null: unknown. */
  method: "mesure" | "estime" | null;
  buy: SideFee | null;
  sell: SideFee | null;
  /** Fees as a share of the turnover (0.137 = 13.7 %); only for a complete run. */
  rate: number | null;
  /** Where the rate comes from when this run has none. */
  rate_from?: "ce_trajet" | "trajet_precedent";
  /**
   * What the margin and the fees do not explain of the balance: gross margin - net - fees (fees measured), or the
   * deduced total minus the fee rate observed on an earlier run times the turnover; when the deduced total is refused,
   * the whole gap. Positive: the balance went down more than the margin says. null: no reference to compare with.
   */
  unexplained: number | null;
  /** Why the total is unknown although the net is known. */
  reason?: "solde_autre_raison" | "lignes_non_confirmees" | "stock_anterieur";
}

/**
 * The balance changes the net is made of: the ones after `from` (`from` itself included when `from_inclusive`) up to
 * `to`, so their sum is exactly `end_balance - start_balance`. The balance movement explainer decomposes this window.
 */
export interface NetWindow {
  from: number;
  to: number;
  from_inclusive: boolean;
}

export interface NetReport {
  auec: number | null;
  /** `mesure`: end balance - start balance. `calcule`: gross margin - measured fees. null: unknown. */
  method: Method | null;
  /** Why it is unknown, or what an estimate rests on. */
  reason?:
    | "en_cours"
    | "en_attente"
    | "solde_avant_inconnu"
    | "solde_apres_inconnu"
    | "cout_inconnu"
    | "pas_de_solde";
  start_balance?: number;
  end_balance?: number;
  /** Only with `method: "mesure"`: the instants the two balances were read at. */
  window?: NetWindow;
}

export interface PlannedNet {
  auec: number;
  /** Which turnover the observed fee rate was applied to. */
  basis: "prix_du_plan" | "chiffre_affaires_observe";
  fee_rate: number;
  /** Where the rate comes from: this run's own measure, or an earlier run's (always the case for deduced fees). */
  rate_from: "ce_trajet" | "trajet_precedent";
  fee: number;
}

export interface Projection {
  /** Run time between the first purchase and the last transaction. */
  run_ms: number;
  /** The cycle the hourly figures rest on: the time between the start of this run and the previous one when both exist, else the run plus an assumed overhead. */
  cycle_ms: number;
  basis: "cycle_observe" | "duree_plus_marge";
  /** The overhead added to the run time when no cycle was observed (loading, empty trip, waiting): an assumption. */
  overhead_ms: number;
  /** Runs whose net was measured (this one included). */
  measured_runs: number;
  /** The balance variation holds movements the margin and the fees do not explain: no figure is built on it. */
  net_doubtful: boolean;
  runs_per_hour: number;
  net_per_hour: number | null;
  day_hours: number;
  /** Only with at least two measured runs. */
  runs_per_day: number | null;
  net_per_day: number | null;
  /** What the next run would earn: the planned profit net of the observed fees, else this run's net. */
  next_run_net: number | null;
  assumptions: string[];
}

export interface RunMoney {
  planned_profit: number | null;
  /** Whether the plan can be assumed to be this run's (the commodity matches or is not comparable). */
  plan_match: "ok" | "non_verifie" | null;
  turnover: number | null;
  cost: number | null;
  /** True when the cost is only that of the SCU paired with a sale (the rest is unsold, or the sale had no purchase). */
  cost_paired: boolean;
  gross_margin: number | null;
  /** gross margin - planned profit (prices and quantities mixed). */
  price_gap: number | null;
  /** The bought quantity differs from the planned one by more than 2 %: the gap is not only about prices. */
  gap_includes_quantity: boolean;
  fees: FeeReport;
  net: NetReport;
  /** Average aUEC per SCU, when the quantities are known. */
  avg_buy_per_scu: number | null;
  avg_sell_per_scu: number | null;
  planned_net: PlannedNet | null;
  projection: Projection | null;
  /**
   * What the balance variation is made of, change by change (balanceMovements.ts). Added after the model by
   * `withDecompositions` (movementsLedger.ts), only for a measured net. Absent otherwise.
   */
  decomposition?: RunDecomposition;
}

export interface TradeRunView {
  /** Time of the first counted transaction. */
  id: string;
  commodity: string | null;
  /** Other goods of the same run, when there are several. */
  more_commodities: string[];
  buy_shops: string[];
  sell_shops: string[];
  stage: RunStage;
  started_at: string;
  ended_at: string;
  /** First counted transaction to last. */
  duration_ms: number;
  scu_bought: number | null;
  scu_sold: number | null;
  /** SCU sold that were not bought in this run (stock from before): never valued. 0 when none. */
  prior_stock_scu: number;
  buys: number;
  sells: number;
  /** Transactions that failed (not counted) and ones whose result is unknown (counted, flagged). */
  failed: number;
  uncertain: number;
  /** Transactions of other kinds (items), not counted. */
  ignored: number;
  /** Only with the balance. */
  money?: RunMoney;
}

export interface TradeSection {
  v: 1;
  /** `none`: no trade journal feeds the dashboard (the game log is off, unreadable or not read yet). */
  source: "journal" | "none";
  runs: TradeRunView[];
  /** Runs found before the payload kept the newest ones. */
  runs_total: number;
  /**
   * Transactions the game refused because the price moved (TransactionCostMismatch), newest last. A time, a side and a
   * kind: NO amount, so they are sent with or without the balance. Absent when there is none.
   */
  price_refusals?: PriceRefusal[];
  /**
   * A ship destroyed with the player aboard (providers/gamelog/shipLoss.ts), newest last, with the cargo bought for it
   * and not sold, which is only PRESUMED lost. The SCU and the counts are not amounts and go with or without the balance;
   * `paid_auec` (the purchase price paid, not the value) exists only with `includeBalance`. Absent when there is none.
   */
  ship_losses?: ShipLossView[];
}

export interface ShipLossView {
  at: string;
  ship_class: string | null;
  cause: ShipLoss["cause"];
  causer: ShipLoss["causer"];
  zone: string | null;
  via: ShipLoss["via"];
  /** SCU presumed lost; null when no journal was available (unknown, not zero). */
  cargo_scu: number | null;
  /** Purchase lines behind `cargo_scu`, and purchases the journal could not confirm (not counted). */
  cargo_buys: number;
  unconfirmed_buys: number;
  /** Sales the journal could not confirm: not counted, so the SCU presumed lost may be overestimated. */
  unconfirmed_sells: number;
  /** The run (its `id`) the lost cargo was bought in; null when there is no cargo. */
  run_id: string | null;
  /** aUEC PAID (purchase price, not the value). Only with the balance. */
  paid_auec?: number;
}

export const EMPTY_TRADE: TradeSection = { v: 1, source: "none", runs: [], runs_total: 0 };

export interface TradeInput {
  /** Absent: no journal. Present, even empty: the journal exists. */
  transactions: readonly Transaction[] | undefined;
  history: readonly BalancePoint[];
  includeBalance: boolean;
  plan?: TradePlan | undefined;
  nowMs: number;
  dayHours?: number;
  /** The ships destroyed (ledgerService.shipLosses()): a loss with cargo cuts the run it interrupted. */
  losses?: readonly ShipLoss[] | undefined;
}

// -------------------------------------------------------------------------------------------------
// Input hygiene
// -------------------------------------------------------------------------------------------------

export interface Tx {
  t: number;
  side: "buy" | "sell";
  total: number;
  quantity: number | null;
  commodity: string | null;
  shop: string | null;
  /** The journal's own record (for its pairing). */
  src: Transaction;
}

export interface Prepared {
  counted: Tx[];
  failed: Tx[];
  /** Lines the journal could not confirm (status unconfirmed, ambiguous ones included): never counted. */
  unconfirmed: Tx[];
  ignored: number;
}

const finitePositive = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1e12;

/** Keeps what is usable, in time order. Anything else is dropped without a word (a transaction can never throw). */
export function prepareTransactions(raw: readonly Transaction[] | undefined): Prepared {
  const out: Prepared = { counted: [], failed: [], unconfirmed: [], ignored: 0 };
  if (!Array.isArray(raw)) return out;
  for (const r of raw.slice(-TRADE_MAX_TRANSACTIONS)) {
    if (!r || typeof r !== "object") continue;
    if (r.kind !== "commodity") {
      if (r.kind === "item") out.ignored += 1;
      continue;
    }
    if (r.side !== "buy" && r.side !== "sell") continue;
    // The journal states an amount in aUEC for cargo; anything else is never added to aUEC.
    if (r.currency !== "aUEC") continue;
    const t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
    // A cargo sale for nothing is always rejected by the game (the journal lists it as failed with `zero_amount`): it
    // has no positive amount, but it is a failed line all the same and the card must tell it, as the journal does.
    const amountOk = finitePositive(r.total_auec) || (r.status === "failed" && r.total_auec === 0);
    if (!Number.isFinite(t) || !amountOk) continue;
    const quantity =
      r.unit === "SCU" &&
      typeof r.quantity === "number" &&
      Number.isFinite(r.quantity) &&
      r.quantity > 0
        ? Math.min(r.quantity, 1e7)
        : null;
    const tx: Tx = {
      t,
      side: r.side,
      total: Math.round(r.total_auec),
      quantity,
      commodity: cleanLabel(r.commodity_id, TRADE_LABEL_MAX),
      shop: cleanLabel(r.shop, TRADE_LABEL_MAX),
      src: r,
    };
    // Exactly as the journal does: only completed lines count; failed and unconfirmed ones are listed, not counted.
    if (r.status === "completed") out.counted.push(tx);
    else if (r.status === "failed") out.failed.push(tx);
    else if (r.status === "unconfirmed") out.unconfirmed.push(tx);
  }
  out.counted.sort((a, b) => a.t - b.t);
  out.failed.sort((a, b) => a.t - b.t);
  out.unconfirmed.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Cuts the counted transactions into runs. A run is a purchase phase followed by a sale phase: a purchase that
 * comes after a sale starts a new run, and so does a silence of more than TRADE_RUN_GAP_MS or a ship lost
 * with its cargo (`cuts`, epoch ms). A sale with no
 * purchase before it makes a run of its own (stage `sold_only`).
 */
export function splitRuns(counted: readonly Tx[], cuts: readonly number[] = []): Tx[][] {
  const runs: Tx[][] = [];
  let current: Tx[] = [];
  let sold = false;
  for (const x of counted) {
    const last = current[current.length - 1];
    const gap = last ? x.t - last.t > TRADE_RUN_GAP_MS : false;
    // A ship destroyed with its cargo ends the run: what the player does next is another run (shipLoss.ts).
    const cut = last ? cuts.some((c) => c > last.t && c <= x.t) : false;
    if (current.length > 0 && (gap || cut || (x.side === "buy" && sold))) {
      runs.push(current);
      current = [];
      sold = false;
    }
    current.push(x);
    if (x.side === "sell") sold = true;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

// -------------------------------------------------------------------------------------------------
// The balance
// -------------------------------------------------------------------------------------------------

export interface Move {
  at: number;
  delta: number;
  /** The stream was cut before this change: the delta may hide unseen changes. */
  gap: boolean;
}

/** The balance changes between consecutive points (the first point has no predecessor, so no change). */
export function movesOf(history: readonly BalancePoint[]): Move[] {
  const moves: Move[] = [];
  for (let i = 1; i < history.length; i++) {
    const p = history[i]!;
    const q = history[i - 1]!;
    moves.push({
      at: p.at,
      delta: p.uec - q.uec,
      gap: p.at - q.until > TRADE_GAP_TOLERANCE_MS,
    });
  }
  return moves;
}

/** The balance in effect at `t`, or null when the telemetry cannot vouch for it. */
function valueAt(history: readonly BalancePoint[], t: number): number | null {
  let found: BalancePoint | undefined;
  for (const p of history) {
    if (p.at <= t) found = p;
    else break;
  }
  if (!found) return null;
  return t <= found.until + TRADE_GAP_TOLERANCE_MS ? found.uec : null;
}

/**
 * The balance just before the first purchase: the value before the first decrease inside the purchase window; if no
 * decrease was seen there, the value in effect just before the window (it is certain only if the telemetry covered it).
 * `from` says which balance changes come after that value (see NetWindow), so the net can be decomposed change by change.
 */
function balanceBefore(
  history: readonly BalancePoint[],
  firstBuy: number,
): { value: number; from: number; inclusive: boolean } | null {
  for (let i = 1; i < history.length; i++) {
    const p = history[i]!;
    const q = history[i - 1]!;
    if (p.at < firstBuy - TRADE_MATCH_BEFORE_MS) continue;
    if (p.at > firstBuy + TRADE_MATCH_AFTER_MS) break;
    if (p.uec < q.uec && p.at - q.until <= TRADE_GAP_TOLERANCE_MS)
      return { value: q.uec, from: p.at, inclusive: true };
  }
  const t = firstBuy - TRADE_MATCH_BEFORE_MS;
  const value = valueAt(history, t);
  return value === null ? null : { value, from: t, inclusive: false };
}

// -------------------------------------------------------------------------------------------------
// Fees measured against the balance
// -------------------------------------------------------------------------------------------------

export type ClusterResult =
  | {
      ok: true;
      fee: number;
      exact: boolean;
      /** The balance changes the fee was measured from: the explainer labels exactly these. */
      used: readonly Move[];
    }
  | { ok: false; why: "none" | "mixed" | "gap" | "implausible" };

/**
 * The fee of one cluster of same-side transactions, from the balance changes in its window (all of them added up):
 *   buy : the balance goes down by price + fee      -> fee = (-change) - price
 *   sell: the balance goes up by price - fee        -> fee = price - change
 * The fee may be charged as a change of its own a moment later (it then comes with the opposite sign for a sale):
 * that is why the changes are summed and not filtered by sign. The match is refused, never guessed, when the window
 * holds a transaction of the other side, a gap in the stream, more than two changes per transaction (something else
 * moved the balance), a line the journal could not confirm (it may have gone through and moved the balance too), or
 * when the result is not a plausible fee (negative, or more than half of the price).
 */
export function clusterFee(
  cluster: readonly Tx[],
  side: "buy" | "sell",
  everyTx: readonly Tx[],
  unconfirmed: readonly Tx[],
  moves: readonly Move[],
): ClusterResult {
  const from = cluster[0]!.t - TRADE_MATCH_BEFORE_MS;
  const to = cluster[cluster.length - 1]!.t + TRADE_MATCH_AFTER_MS;
  if (everyTx.some((x) => x.side !== side && x.t >= from && x.t <= to)) {
    return { ok: false, why: "mixed" };
  }
  if (unconfirmed.some((x) => x.t >= from && x.t <= to)) return { ok: false, why: "mixed" };
  const inside = moves.filter((m) => m.at >= from && m.at <= to && m.delta !== 0);
  if (inside.some((m) => m.gap)) return { ok: false, why: "gap" };
  if (inside.length === 0) return { ok: false, why: "none" };
  if (inside.length > 2 * cluster.length) return { ok: false, why: "mixed" };
  const price = cluster.reduce((s, x) => s + x.total, 0);
  const change = inside.reduce((s, m) => s + m.delta, 0);
  const fee = side === "buy" ? -change - price : price - change;
  const slack = Math.max(1, price * 0.001);
  if (fee < -slack || fee > price * TRADE_MAX_FEE_SHARE) return { ok: false, why: "implausible" };
  return {
    ok: true,
    fee: Math.max(0, Math.round(fee)),
    exact: cluster.length === 1,
    used: inside,
  };
}

export function clustersOf(txs: readonly Tx[]): Tx[][] {
  const out: Tx[][] = [];
  for (const x of txs) {
    const group = out[out.length - 1];
    if (group && x.t - group[group.length - 1]!.t <= TRADE_CLUSTER_GAP_MS) group.push(x);
    else out.push([x]);
  }
  return out;
}

/**
 * The fee of each side of a run, measured against the balance history. A side is reported only when EVERY cluster of
 * it could be matched; otherwise it is null and the caller falls back to the total (gross margin - net).
 * `everyTx` is every counted transaction of the session (another run may sit in the window); `unconfirmed` the lines
 * the journal could not confirm (a window that holds one is refused).
 */
export function reconcileFees(
  run: readonly Tx[],
  everyTx: readonly Tx[],
  history: readonly BalancePoint[],
  unconfirmed: readonly Tx[] = [],
): { buy: SideFee | null; sell: SideFee | null } {
  const moves = movesOf(history);
  const side = (which: "buy" | "sell"): SideFee | null => {
    const txs = run.filter((x) => x.side === which);
    if (txs.length === 0) return null;
    let total = 0;
    let exact = true;
    for (const c of clustersOf(txs)) {
      const r = clusterFee(c, which, everyTx, unconfirmed, moves);
      if (!r.ok) return null;
      total += r.fee;
      exact = exact && r.exact;
    }
    return { auec: total, method: exact ? "exact" : "groupe" };
  };
  return { buy: side("buy"), sell: side("sell") };
}

// -------------------------------------------------------------------------------------------------
// A run
// -------------------------------------------------------------------------------------------------

const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0);
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Same goods? Short ids ("LARA") are prefixes of the name ("Laranite"). Unknown on either side: not comparable. */
function sameGoods(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return null;
  if (x.startsWith(y) || y.startsWith(x)) return true;
  return false;
}

function distinct(list: readonly (string | null)[], max: number): string[] {
  const seen: string[] = [];
  for (const s of list) if (s && !seen.includes(s)) seen.push(s);
  return seen.slice(0, max);
}

/**
 * The goods of a run in order of first appearance. Never by amount: without the balance the answer (and so the ledger
 * hash) must not depend on relative amounts.
 */
function goodsOf(txs: readonly Tx[]): { main: string | null; more: string[] } {
  const order = distinct(
    txs.map((x) => x.commodity),
    4,
  );
  return { main: order[0] ?? null, more: order.slice(1) };
}

interface Pairing {
  ok: boolean;
  cost: number;
  revenue: number;
  paired: number;
  unsold: number;
  withoutPurchase: number;
}

/**
 * The journal's own first-in first-out pairing (per commodity) over the transactions of one run. Not possible when a
 * quantity is missing (the card then falls back on the plain totals).
 */
function pairRun(txs: readonly Tx[]): Pairing {
  const none: Pairing = {
    ok: false,
    cost: 0,
    revenue: 0,
    paired: 0,
    unsold: 0,
    withoutPurchase: 0,
  };
  if (!txs.every((x) => x.quantity !== null && x.quantity > 0)) return none;
  const runs = pairCargoRuns(
    txs.map((x) => ({ ...x.src, resource: x.src.resource ?? x.src.commodity_id ?? "unknown" })),
  );
  return {
    ok: true,
    cost: sum(runs.map((r) => r.cost_auec)),
    revenue: sum(runs.map((r) => r.revenue_auec)),
    paired: sum(runs.map((r) => r.paired_scu)),
    unsold: sum(runs.map((r) => r.unsold_scu)),
    withoutPurchase: sum(runs.map((r) => r.sold_without_purchase_scu)),
  };
}

interface RunFacts {
  txs: Tx[];
  buys: Tx[];
  sells: Tx[];
  stage: RunStage;
  boughtQty: number | null;
  soldQty: number | null;
  pair: Pairing;
  /** SCU sold that were not bought in the run (quantities only: no amount). */
  priorStock: number;
}

function factsOf(txs: Tx[]): RunFacts {
  const buys = txs.filter((x) => x.side === "buy");
  const sells = txs.filter((x) => x.side === "sell");
  const qty = (list: Tx[]) =>
    list.length > 0 && list.every((x) => x.quantity !== null)
      ? sum(list.map((x) => x.quantity as number))
      : null;
  const boughtQty = qty(buys);
  const soldQty = qty(sells);
  const pair = pairRun(txs);
  let stage: RunStage;
  if (buys.length === 0) stage = "sold_only";
  else if (sells.length === 0) stage = "open";
  else if (pair.ok) stage = pair.unsold > SCU_EPS ? "partial" : "complete";
  else if (boughtQty !== null && soldQty !== null) {
    stage = soldQty >= boughtQty * SOLD_ALL ? "complete" : "partial";
  } else {
    // Quantities unknown: a sale after the purchases is taken as the end of the run.
    stage = "complete";
  }
  const priorStock = pair.ok && buys.length > 0 ? pair.withoutPurchase : 0;
  return { txs, buys, sells, stage, boughtQty, soldQty, pair, priorStock };
}

function planMatch(plan: TradePlan | undefined, goods: string | null): "ok" | "non_verifie" | null {
  if (!plan) return null;
  const same = sameGoods(plan.commodity, goods);
  return same === true ? "ok" : "non_verifie";
}

/** The money side of one run. Only called with the balance allowed. */
function moneyOf(
  f: RunFacts,
  ctx: {
    everyTx: readonly Tx[];
    unconfirmed: readonly Tx[];
    history: readonly BalancePoint[];
    plan: TradePlan | undefined;
    isLatest: boolean;
    nowMs: number;
    nextRunStart: number | null;
    dayHours: number;
    fallbackRate: number | null;
    /** Start of the run before this one, and how many earlier runs had a measured net. */
    prevStart: number | null;
    measuredBefore: number;
  },
): RunMoney {
  const { history, nowMs } = ctx;
  const turnover = f.sells.length > 0 ? sum(f.sells.map((x) => x.total)) : null;
  const allCost = f.buys.length > 0 ? sum(f.buys.map((x) => x.total)) : null;
  // Cost and gross margin follow the journal's pairing (first in, first out, per commodity): only the paired SCU are valued.
  let cost: number | null = allCost;
  let gross: number | null = null;
  let costPaired = false;
  if (f.stage === "sold_only") {
    cost = null;
  } else if (f.stage !== "open" && turnover !== null) {
    if (f.pair.ok) {
      costPaired = f.pair.unsold > SCU_EPS || f.pair.withoutPurchase > SCU_EPS;
      if (f.pair.paired > SCU_EPS) {
        cost = Math.round(f.pair.cost);
        gross = Math.round(f.pair.revenue - f.pair.cost);
      } else {
        cost = null;
      }
    } else if (allCost !== null) {
      gross = turnover - allCost;
    }
  }

  const plan = ctx.isLatest ? ctx.plan : undefined;
  const planned =
    plan && typeof plan.expected_profit_auec === "number" ? plan.expected_profit_auec : null;
  const goods = goodsOf(f.txs).main;
  const gap = gross !== null && planned !== null && f.stage === "complete" ? gross - planned : null;
  const gapQty =
    !!plan &&
    typeof plan.scu === "number" &&
    plan.scu > 0 &&
    f.boughtQty !== null &&
    Math.abs(f.boughtQty - plan.scu) > plan.scu * 0.02;

  const first = f.txs[0]!.t;
  const last = f.txs[f.txs.length - 1]!.t;
  const firstBuy = f.buys.length > 0 ? f.buys[0]!.t : null;

  // ---- fees against the balance
  const sides = reconcileFees(f.txs, ctx.everyTx, history, ctx.unconfirmed);
  // A line the journal could not confirm may have moved the balance: the margin and so the deduced fees would absorb it.
  const lo = f.txs[0]!.t - TRADE_MATCH_AFTER_MS;
  const hi = f.txs[f.txs.length - 1]!.t + TRADE_MATCH_AFTER_MS;
  const unsure = ctx.unconfirmed.some((x) => x.t >= lo && x.t <= hi);
  const bothSides = sides.buy !== null && (f.sells.length === 0 || sides.sell !== null);

  // ---- net: the balance after minus the balance just before the first purchase
  const net: NetReport = { auec: null, method: null };
  const endLimit = Math.min(
    last + TRADE_SETTLE_MS,
    ctx.nextRunStart !== null ? ctx.nextRunStart - TRADE_MATCH_BEFORE_MS : Infinity,
  );
  if (f.stage === "open" || f.stage === "partial") {
    net.reason = "en_cours";
  } else if (f.stage === "sold_only" || firstBuy === null) {
    net.reason = "solde_avant_inconnu";
  } else if (nowMs < endLimit) {
    net.reason = "en_attente";
  } else {
    const before = balanceBefore(history, firstBuy);
    const after = valueAt(history, endLimit);
    if (before === null) net.reason = "solde_avant_inconnu";
    else if (after === null) net.reason = "solde_apres_inconnu";
    else {
      net.auec = after - before.value;
      net.method = "mesure";
      net.start_balance = before.value;
      net.end_balance = after;
      net.window = { from: before.from, to: endLimit, from_inclusive: before.inclusive };
    }
  }
  // Net inferred from the gross margin and the fees measured on both sides (no balance before/after).
  if (
    net.auec === null &&
    f.stage === "complete" &&
    gross !== null &&
    bothSides &&
    net.reason !== "en_attente"
  ) {
    net.auec = gross - (sides.buy!.auec + sides.sell!.auec);
    net.method = "calcule";
  }

  // ---- fees: both sides measured, else the total deduced from gross margin - net (only when it is a plausible fee)
  const fees: FeeReport = {
    total: null,
    method: null,
    buy: null,
    sell: null,
    rate: null,
    unexplained: null,
  };
  const cap = turnover !== null ? turnover * TRADE_UNEXPLAINED_SHARE : 0;
  if (bothSides && f.sells.length > 0) {
    fees.buy = sides.buy;
    fees.sell = sides.sell;
    fees.total = sides.buy!.auec + sides.sell!.auec;
    fees.method = "mesure";
    if (net.method === "mesure" && gross !== null)
      fees.unexplained = gross - net.auec! - fees.total;
  } else if (net.method === "mesure" && gross !== null && f.stage === "complete") {
    if (unsure) {
      fees.reason = "lignes_non_confirmees";
    } else if (f.priorStock > SCU_EPS) {
      fees.reason = "stock_anterieur";
    } else {
      const deduced = gross - (net.auec as number);
      const plausible =
        turnover !== null &&
        turnover > 0 &&
        deduced >= 0 &&
        deduced <= turnover * TRADE_MAX_FEE_SHARE;
      if (plausible) {
        fees.total = deduced;
        fees.method = "estime";
        // One side measured: the other one is what is left (still an estimate).
        if (sides.buy && !sides.sell) {
          fees.buy = sides.buy;
          fees.sell = { auec: deduced - sides.buy.auec, method: "estime" };
        } else if (sides.sell && !sides.buy) {
          fees.sell = sides.sell;
          fees.buy = { auec: deduced - sides.sell.auec, method: "estime" };
        }
        // Compared with the rate seen on an earlier run, if any: the rest is not a fee.
        if (ctx.fallbackRate !== null && turnover !== null)
          fees.unexplained = Math.round(deduced - ctx.fallbackRate * turnover);
      } else {
        // The balance moved for another reason (a reward received, goods bought elsewhere): not shown as fees.
        fees.reason = "solde_autre_raison";
        fees.unexplained = deduced;
        if (sides.buy) fees.buy = sides.buy;
        if (sides.sell) fees.sell = sides.sell;
      }
    }
  } else {
    if (sides.buy) fees.buy = sides.buy;
    if (sides.sell) fees.sell = sides.sell;
  }
  if (fees.total !== null && f.stage === "complete" && turnover !== null && turnover > 0) {
    fees.rate = fees.total / turnover;
    fees.rate_from = "ce_trajet";
  } else if (ctx.fallbackRate !== null && f.stage !== "sold_only") {
    fees.rate = ctx.fallbackRate;
    fees.rate_from = "trajet_precedent";
  }

  // ---- the plan, net of the observed fees
  let plannedNet: PlannedNet | null = null;
  // The rate that nets the plan is a measured one: this run's own when it was measured, else the one seen on an earlier
  // run. Fees deduced from the balance (`estime`) are shown, but not used to promise a net.
  const planRate = fees.method === "estime" ? ctx.fallbackRate : fees.rate;
  if (planned !== null && planRate !== null) {
    const planTurnover =
      plan && finitePositive(plan.sell_unit_price) && finitePositive(plan.scu)
        ? plan.sell_unit_price * plan.scu
        : null;
    const base = planTurnover ?? turnover;
    if (base !== null && base > 0) {
      const fee = Math.round(planRate * base);
      plannedNet = {
        auec: planned - fee,
        basis: planTurnover !== null ? "prix_du_plan" : "chiffre_affaires_observe",
        fee_rate: planRate,
        rate_from: fees.method === "estime" ? "trajet_precedent" : (fees.rate_from ?? "ce_trajet"),
        fee,
      };
    }
  }

  // ---- pace and projection (a finished run that sold only what it bought)
  const runMs = last - first;
  let projection: Projection | null = null;
  if (
    f.stage === "complete" &&
    runMs >= TRADE_MIN_RATE_MS &&
    ctx.isLatest &&
    f.priorStock <= SCU_EPS
  ) {
    const measuredRuns = ctx.measuredBefore + (net.method === "mesure" ? 1 : 0);
    // The cycle the hours are made of: the time seen between two runs when there are two, else the run alone plus an
    // overhead that is an ASSUMPTION (it ignores loading, the empty trip back and waiting otherwise).
    const between = ctx.prevStart !== null ? first - ctx.prevStart : null;
    const observed =
      between !== null && between >= TRADE_MIN_RATE_MS && between <= TRADE_RUN_GAP_MS;
    const cycle = observed ? (between as number) : runMs + TRADE_OVERHEAD_MS;
    const perHour = 3_600_000 / cycle;
    const showDay = measuredRuns >= 2;
    const doubtful =
      fees.reason !== undefined || (fees.unexplained !== null && Math.abs(fees.unexplained) > cap);
    const usableNet = net.auec !== null && !doubtful ? net.auec : null;
    const runsPerDay = perHour * ctx.dayHours;
    projection = {
      run_ms: runMs,
      cycle_ms: cycle,
      basis: observed ? "cycle_observe" : "duree_plus_marge",
      overhead_ms: observed ? 0 : TRADE_OVERHEAD_MS,
      measured_runs: measuredRuns,
      net_doubtful: doubtful,
      runs_per_hour: Math.round(perHour * 100) / 100,
      net_per_hour: usableNet !== null ? Math.round(usableNet * perHour) : null,
      day_hours: ctx.dayHours,
      runs_per_day: showDay ? Math.round(runsPerDay * 10) / 10 : null,
      net_per_day: showDay && usableNet !== null ? Math.round(usableNet * runsPerDay) : null,
      next_run_net: plannedNet ? plannedNet.auec : usableNet,
      assumptions: [
        observed
          ? "un cycle = le temps mesuré entre le début de ce trajet et celui du précédent"
          : "un cycle = la durée mesurée du premier achat à la dernière vente + " +
            Math.round(TRADE_OVERHEAD_MS / 60_000) +
            " min pour le chargement, le trajet à vide et l’attente (hypothèse, non mesurée)",
        "même trajet, mêmes prix et même quantité à chaque fois",
        "marchandise toujours disponible, et prix qui ne baissent pas quand tu vends davantage",
        "frais au même taux que ce trajet",
        ...(showDay ? ["une journée de jeu = " + ctx.dayHours + " h (hypothèse)"] : []),
      ],
    };
  }

  return {
    planned_profit: planned,
    plan_match: planMatch(plan, goods),
    turnover,
    cost,
    cost_paired: costPaired,
    gross_margin: gross,
    price_gap: gap,
    gap_includes_quantity: gapQty,
    fees,
    net,
    avg_buy_per_scu: allCost !== null && f.boughtQty ? Math.round(allCost / f.boughtQty) : null,
    avg_sell_per_scu: turnover !== null && f.soldQty ? Math.round(turnover / f.soldQty) : null,
    planned_net: plannedNet,
    projection,
  };
}

function viewOf(f: RunFacts, prep: Prepared, money: RunMoney | undefined): TradeRunView {
  const goods = goodsOf(f.txs);
  const first = f.txs[0]!.t;
  const last = f.txs[f.txs.length - 1]!.t;
  const failedHere = prep.failed.filter(
    (x) => x.t >= first - TRADE_MATCH_AFTER_MS && x.t <= last + TRADE_MATCH_AFTER_MS,
  );
  return {
    id: new Date(first).toISOString(),
    commodity: goods.main,
    more_commodities: goods.more,
    buy_shops: distinct(
      f.buys.map((x) => x.shop),
      3,
    ),
    sell_shops: distinct(
      f.sells.map((x) => x.shop),
      3,
    ),
    stage: f.stage,
    started_at: new Date(first).toISOString(),
    ended_at: new Date(last).toISOString(),
    duration_ms: last - first,
    scu_bought: f.boughtQty,
    scu_sold: f.soldQty,
    prior_stock_scu: Math.round(f.priorStock * 100) / 100,
    buys: f.buys.length,
    sells: f.sells.length,
    failed: failedHere.length,
    uncertain: prep.unconfirmed.filter(
      (x) => x.t >= first - TRADE_MATCH_AFTER_MS && x.t <= last + TRADE_MATCH_AFTER_MS,
    ).length,
    ignored: prep.ignored,
    ...(money ? { money } : {}),
  };
}

/**
 * The trade section of the ledger payload. Newest run first. The amounts (`money`) exist only with `includeBalance`;
 * without it the section carries no figure in aUEC at all.
 */
export function buildTradeSection(input: TradeInput): TradeSection {
  if (input.transactions === undefined) return EMPTY_TRADE;
  const prep = prepareTransactions(input.transactions);
  const runs = splitRuns(prep.counted, lossCuts(input.losses ?? [])).map(factsOf);
  const dayHours = input.dayHours ?? TRADE_DAY_HOURS;
  // The observed fee rate walks forward: a run without one uses the latest earlier run's.
  let carried: number | null = null;
  let measured = 0;
  const moneys: (RunMoney | undefined)[] = [];
  if (input.includeBalance) {
    runs.forEach((f, i) => {
      const money = moneyOf(f, {
        everyTx: prep.counted,
        unconfirmed: prep.unconfirmed,
        history: input.history,
        plan: input.plan,
        isLatest: i === runs.length - 1,
        nowMs: input.nowMs,
        nextRunStart: i + 1 < runs.length ? runs[i + 1]!.txs[0]!.t : null,
        dayHours,
        fallbackRate: carried,
        prevStart: i > 0 ? runs[i - 1]!.txs[0]!.t : null,
        measuredBefore: measured,
      });
      moneys.push(money);
      if (money.net.method === "mesure") measured += 1;
      // Only a rate MEASURED against the balance is carried forward. A deduced one (gross margin minus net, when the stream
      // was cut or the window unreadable) may hold a reward or a purchase made elsewhere: it is the next run's yardstick
      // only if it is nothing but fees, which nothing can tell.
      if (
        money.fees.rate_from === "ce_trajet" &&
        money.fees.rate !== null &&
        money.fees.method === "mesure"
      )
        carried = money.fees.rate;
    });
  }
  const views = runs.map((f, i) => viewOf(f, prep, moneys[i]));
  const newest = views.slice(-TRADE_MAX_RUNS).reverse();
  const refusals = priceRefusalsOf(input.transactions).slice(-TRADE_MAX_REFUSALS);
  const losses = lossViews(input.losses, runs, input.includeBalance);
  return {
    v: 1,
    source: "journal",
    runs: newest,
    runs_total: views.length,
    ...(refusals.length > 0 ? { price_refusals: refusals } : {}),
    ...(losses.length > 0 ? { ship_losses: losses } : {}),
  };
}

/**
 * The ship losses as the section carries them: the run each one interrupted (found by the time of its latest lost purchase),
 * and the paid amount only with the balance. Nothing else of a loss is read, so nothing the parser dropped can come back.
 */
function lossViews(
  losses: readonly ShipLoss[] | undefined,
  runs: readonly RunFacts[],
  includeBalance: boolean,
): ShipLossView[] {
  if (!Array.isArray(losses)) return [];
  return losses.slice(-TRADE_MAX_LOSSES).map((l) => {
    const buyAt = l.cargo?.last_buy_at ? Date.parse(l.cargo.last_buy_at) : NaN;
    const run = Number.isFinite(buyAt)
      ? runs.find((r) => r.txs.some((x) => x.t === buyAt))
      : undefined;
    return {
      at: l.at,
      ship_class: l.ship_class,
      cause: l.cause,
      causer: l.causer,
      zone: l.zone,
      via: l.via,
      cargo_scu: l.cargo ? l.cargo.scu : null,
      cargo_buys: l.cargo ? l.cargo.buys : 0,
      unconfirmed_buys: l.cargo ? l.cargo.unconfirmed_buys : 0,
      unconfirmed_sells: l.cargo ? l.cargo.unconfirmed_sells : 0,
      run_id: run ? new Date(run.txs[0]!.t).toISOString() : null,
      ...(includeBalance && l.cargo ? { paid_auec: l.cargo.paid_auec } : {}),
    };
  });
}
