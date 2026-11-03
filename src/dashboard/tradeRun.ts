import { cleanLabel } from "../core/untrusted.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import type { TradeTransaction } from "./tradeTypes.js";

/**
 * The commerce model: from the transactions of a trading run, the balance history and the optional plan, what the
 * run really earned. PURE (no file, no network, no clock of its own, no Node module), so the preview can import it.
 *
 * WHICH FIGURE IS WHICH (the whole point of this module; the old "Prévu / Réalisé" block compared a profit with a
 * balance change, which are not the same thing):
 *   - bénéfice prévu      = the plan's expected profit (a margin before any fee, from market prices).
 *   - chiffre d'affaires  = what the sales brought in (the amounts of the sell transactions).
 *   - coût d'achat        = what the purchases cost (the amounts of the buy transactions).
 *   - marge brute         = chiffre d'affaires - coût d'achat. Comparable with the planned profit.
 *   - écart de prix       = marge brute - bénéfice prévu (prices AND quantities: both move it).
 *   - frais               = what the loading service took on top of the prices. The log has NO fee line: they are
 *                           measured against the balance (see reconcileFees) or inferred from the difference.
 *   - bénéfice net        = balance at the end - balance just before the first purchase. The only figure that is
 *                           what the player really gained.
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

/** Transactions kept in memory and examined. */
export const TRADE_MAX_TRANSACTIONS = 400;
/** Runs returned in the payload (newest first). */
export const TRADE_MAX_RUNS = 4;
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
/** Sold quantity within this share of the bought one counts as "everything sold". */
const SOLD_ALL = 0.995;

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
  /** What the sides measured do not explain of (gross margin - net): other costs or a mismatch. */
  unexplained: number | null;
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
}

export interface PlannedNet {
  auec: number;
  /** Which turnover the observed fee rate was applied to. */
  basis: "prix_du_plan" | "chiffre_affaires_observe";
  fee_rate: number;
  fee: number;
}

export interface Projection {
  /** Run time between the first purchase and the last transaction. */
  run_ms: number;
  runs_per_hour: number;
  net_per_hour: number | null;
  day_hours: number;
  runs_per_day: number;
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
  /** True when the cost is only the share of the purchases that was sold (partial run, quantities known). */
  cost_prorata: boolean;
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
  /** `none`: no trade journal feeds the dashboard (the parser is not wired yet, or the log is off). */
  source: "journal" | "none";
  runs: TradeRunView[];
  /** Runs found before the payload kept the newest ones. */
  runs_total: number;
}

export const EMPTY_TRADE: TradeSection = { v: 1, source: "none", runs: [], runs_total: 0 };

export interface TradeInput {
  /** Absent: no journal. Present, even empty: the journal exists. */
  transactions: readonly TradeTransaction[] | undefined;
  history: readonly BalancePoint[];
  includeBalance: boolean;
  plan?: TradePlan | undefined;
  nowMs: number;
  dayHours?: number;
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
  uncertain: boolean;
}

export interface Prepared {
  counted: Tx[];
  failed: Tx[];
  ignored: number;
}

const finitePositive = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1e12;

/** Keeps what is usable, in time order. Anything else is dropped without a word (a transaction can never throw). */
export function prepareTransactions(raw: readonly TradeTransaction[] | undefined): Prepared {
  const out: Prepared = { counted: [], failed: [], ignored: 0 };
  if (!Array.isArray(raw)) return out;
  for (const r of raw.slice(-TRADE_MAX_TRANSACTIONS)) {
    if (!r || typeof r !== "object") continue;
    if (r.kind !== "commodity") {
      if (r.kind === "item") out.ignored += 1;
      continue;
    }
    if (r.side !== "buy" && r.side !== "sell") continue;
    const t = typeof r.at === "string" ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(t) || !finitePositive(r.total_auec)) continue;
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
      commodity: cleanLabel(r.commodity, TRADE_LABEL_MAX),
      shop: cleanLabel(r.shop, TRADE_LABEL_MAX),
      uncertain: r.outcome === "unknown",
    };
    (r.outcome === "failed" ? out.failed : out.counted).push(tx);
  }
  out.counted.sort((a, b) => a.t - b.t);
  out.failed.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Cuts the counted transactions into runs. A run is a purchase phase followed by a sale phase: a purchase that
 * comes after a sale starts a new run, and so does a silence of more than TRADE_RUN_GAP_MS. A sale with no
 * purchase before it makes a run of its own (stage `sold_only`).
 */
export function splitRuns(counted: readonly Tx[]): Tx[][] {
  const runs: Tx[][] = [];
  let current: Tx[] = [];
  let sold = false;
  for (const x of counted) {
    const last = current[current.length - 1];
    const gap = last ? x.t - last.t > TRADE_RUN_GAP_MS : false;
    if (current.length > 0 && (gap || (x.side === "buy" && sold))) {
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

interface Move {
  at: number;
  delta: number;
  /** The stream was cut before this change: the delta may hide unseen changes. */
  gap: boolean;
}

/** The balance changes between consecutive points (the first point has no predecessor, so no change). */
function movesOf(history: readonly BalancePoint[]): Move[] {
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
 */
function balanceBefore(history: readonly BalancePoint[], firstBuy: number): number | null {
  for (let i = 1; i < history.length; i++) {
    const p = history[i]!;
    const q = history[i - 1]!;
    if (p.at < firstBuy - TRADE_MATCH_BEFORE_MS) continue;
    if (p.at > firstBuy + TRADE_MATCH_AFTER_MS) break;
    if (p.uec < q.uec && p.at - q.until <= TRADE_GAP_TOLERANCE_MS) return q.uec;
  }
  return valueAt(history, firstBuy - TRADE_MATCH_BEFORE_MS);
}

// -------------------------------------------------------------------------------------------------
// Fees measured against the balance
// -------------------------------------------------------------------------------------------------

type ClusterResult =
  | { ok: true; fee: number; exact: boolean }
  | { ok: false; why: "none" | "mixed" | "gap" | "implausible" };

/**
 * The fee of one cluster of same-side transactions, from the balance changes in its window (all of them added up):
 *   buy : the balance goes down by price + fee      -> fee = (-change) - price
 *   sell: the balance goes up by price - fee        -> fee = price - change
 * The fee may be charged as a change of its own a moment later (it then comes with the opposite sign for a sale):
 * that is why the changes are summed and not filtered by sign. The match is refused, never guessed, when the window
 * holds a transaction of the other side, a gap in the stream, more than two changes per transaction (something else
 * moved the balance), or when the result is not a plausible fee (negative, or more than half of the price).
 */
function clusterFee(
  cluster: readonly Tx[],
  side: "buy" | "sell",
  everyTx: readonly Tx[],
  moves: readonly Move[],
): ClusterResult {
  const from = cluster[0]!.t - TRADE_MATCH_BEFORE_MS;
  const to = cluster[cluster.length - 1]!.t + TRADE_MATCH_AFTER_MS;
  if (everyTx.some((x) => x.side !== side && x.t >= from && x.t <= to)) {
    return { ok: false, why: "mixed" };
  }
  const inside = moves.filter((m) => m.at >= from && m.at <= to && m.delta !== 0);
  if (inside.some((m) => m.gap)) return { ok: false, why: "gap" };
  if (inside.length === 0) return { ok: false, why: "none" };
  if (inside.length > 2 * cluster.length) return { ok: false, why: "mixed" };
  const price = cluster.reduce((s, x) => s + x.total, 0);
  const change = inside.reduce((s, m) => s + m.delta, 0);
  const fee = side === "buy" ? -change - price : price - change;
  const slack = Math.max(1, price * 0.001);
  if (fee < -slack || fee > price * TRADE_MAX_FEE_SHARE) return { ok: false, why: "implausible" };
  return { ok: true, fee: Math.max(0, Math.round(fee)), exact: cluster.length === 1 };
}

function clustersOf(txs: readonly Tx[]): Tx[][] {
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
 * `everyTx` is every counted transaction of the session (another run may sit in the window).
 */
export function reconcileFees(
  run: readonly Tx[],
  everyTx: readonly Tx[],
  history: readonly BalancePoint[],
): { buy: SideFee | null; sell: SideFee | null } {
  const moves = movesOf(history);
  const side = (which: "buy" | "sell"): SideFee | null => {
    const txs = run.filter((x) => x.side === which);
    if (txs.length === 0) return null;
    let total = 0;
    let exact = true;
    for (const c of clustersOf(txs)) {
      const r = clusterFee(c, which, everyTx, moves);
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

/** The goods that weigh most (by money); the others come after. */
function goodsOf(txs: readonly Tx[]): { main: string | null; more: string[] } {
  const weight = new Map<string, number>();
  for (const x of txs)
    if (x.commodity) weight.set(x.commodity, (weight.get(x.commodity) ?? 0) + x.total);
  const order = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { main: order[0] ?? null, more: order.slice(1, 4) };
}

interface RunFacts {
  txs: Tx[];
  buys: Tx[];
  sells: Tx[];
  stage: RunStage;
  boughtQty: number | null;
  soldQty: number | null;
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
  let stage: RunStage;
  if (buys.length === 0) stage = "sold_only";
  else if (sells.length === 0) stage = "open";
  else if (boughtQty !== null && soldQty !== null) {
    stage = soldQty >= boughtQty * SOLD_ALL ? "complete" : "partial";
  } else {
    // Quantities unknown: a sale after the purchases is taken as the end of the run.
    stage = "complete";
  }
  return { txs, buys, sells, stage, boughtQty, soldQty };
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
    history: readonly BalancePoint[];
    plan: TradePlan | undefined;
    isLatest: boolean;
    nowMs: number;
    nextRunStart: number | null;
    dayHours: number;
    fallbackRate: number | null;
  },
): RunMoney {
  const { history, nowMs } = ctx;
  const turnover = f.sells.length > 0 ? sum(f.sells.map((x) => x.total)) : null;
  const allCost = f.buys.length > 0 ? sum(f.buys.map((x) => x.total)) : null;
  let cost = allCost;
  let prorata = false;
  if (f.stage === "partial" && allCost !== null && f.boughtQty && f.soldQty !== null) {
    cost = Math.round(allCost * Math.min(1, f.soldQty / f.boughtQty));
    prorata = true;
  } else if (f.stage === "open") {
    cost = allCost;
  }
  const grossReady = turnover !== null && cost !== null && f.stage !== "open";
  const gross = grossReady ? turnover - (cost as number) : null;

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
  const sides = reconcileFees(f.txs, ctx.everyTx, history);
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
      net.auec = after - before;
      net.method = "mesure";
      net.start_balance = before;
      net.end_balance = after;
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

  // ---- fees: both sides measured, else the total inferred from gross margin - net
  const fees: FeeReport = {
    total: null,
    method: null,
    buy: null,
    sell: null,
    rate: null,
    unexplained: null,
  };
  if (bothSides && f.sells.length > 0) {
    fees.buy = sides.buy;
    fees.sell = sides.sell;
    fees.total = sides.buy!.auec + sides.sell!.auec;
    fees.method = "mesure";
    if (net.method === "mesure" && gross !== null)
      fees.unexplained = gross - net.auec! - fees.total;
  } else if (net.method === "mesure" && gross !== null && f.stage === "complete") {
    fees.total = gross - (net.auec as number);
    fees.method = "estime";
    // One side measured: the other one is what is left (still an estimate).
    if (sides.buy && !sides.sell) {
      fees.buy = sides.buy;
      fees.sell = { auec: fees.total - sides.buy.auec, method: "estime" };
    } else if (sides.sell && !sides.buy) {
      fees.sell = sides.sell;
      fees.buy = { auec: fees.total - sides.sell.auec, method: "estime" };
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
  if (planned !== null && fees.rate !== null) {
    const planTurnover =
      plan && finitePositive(plan.sell_unit_price) && finitePositive(plan.scu)
        ? plan.sell_unit_price * plan.scu
        : null;
    const base = planTurnover ?? turnover;
    if (base !== null && base > 0) {
      const fee = Math.round(fees.rate * base);
      plannedNet = {
        auec: planned - fee,
        basis: planTurnover !== null ? "prix_du_plan" : "chiffre_affaires_observe",
        fee_rate: fees.rate,
        fee,
      };
    }
  }

  // ---- pace and projection (complete runs only)
  const runMs = last - first;
  let projection: Projection | null = null;
  if (f.stage === "complete" && runMs >= TRADE_MIN_RATE_MS && ctx.isLatest) {
    const perHour = 3_600_000 / runMs;
    const netPerHour = net.auec !== null ? Math.round(net.auec * perHour) : null;
    const runsPerDay = perHour * ctx.dayHours;
    projection = {
      run_ms: runMs,
      runs_per_hour: Math.round(perHour * 100) / 100,
      net_per_hour: netPerHour,
      day_hours: ctx.dayHours,
      runs_per_day: Math.round(runsPerDay * 10) / 10,
      net_per_day: net.auec !== null ? Math.round(net.auec * runsPerDay) : null,
      next_run_net: plannedNet ? plannedNet.auec : net.auec,
      assumptions: [
        "même trajet, mêmes prix et même quantité à chaque fois",
        "durée mesurée du premier achat à la dernière vente : sans le trajet à vide ni l’attente",
        "marchandise toujours disponible, et prix qui ne baissent pas quand tu vends davantage",
        "frais au même taux que ce trajet",
        "une journée de jeu = " + ctx.dayHours + " h (hypothèse)",
      ],
    };
  }

  return {
    planned_profit: planned,
    plan_match: planMatch(plan, goods),
    turnover,
    cost,
    cost_prorata: prorata,
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
    buys: f.buys.length,
    sells: f.sells.length,
    failed: failedHere.length,
    uncertain: f.txs.filter((x) => x.uncertain).length,
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
  const runs = splitRuns(prep.counted).map(factsOf);
  const dayHours = input.dayHours ?? TRADE_DAY_HOURS;
  // The observed fee rate walks forward: a run without one uses the latest earlier run's.
  let carried: number | null = null;
  const moneys: (RunMoney | undefined)[] = [];
  if (input.includeBalance) {
    runs.forEach((f, i) => {
      const money = moneyOf(f, {
        everyTx: prep.counted,
        history: input.history,
        plan: input.plan,
        isLatest: i === runs.length - 1,
        nowMs: input.nowMs,
        nextRunStart: i + 1 < runs.length ? runs[i + 1]!.txs[0]!.t : null,
        dayHours,
        fallbackRate: carried,
      });
      moneys.push(money);
      if (money.fees.rate_from === "ce_trajet" && money.fees.rate !== null)
        carried = money.fees.rate;
    });
  }
  const views = runs.map((f, i) => viewOf(f, prep, moneys[i]));
  const newest = views.slice(-TRADE_MAX_RUNS).reverse();
  return { v: 1, source: "journal", runs: newest, runs_total: views.length };
}
