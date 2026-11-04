import { cleanLabel } from "../core/untrusted.js";
import type { BalancePoint } from "../providers/telemetry/service.js";
import type { Transaction } from "../providers/gamelog/trade.js";
import {
  TRADE_MATCH_AFTER_MS,
  TRADE_MATCH_BEFORE_MS,
  clusterFee,
  clustersOf,
  movesOf,
  prepareTransactions,
  type Move,
} from "./tradeRun.js";

/**
 * The balance movement explainer: WHERE THE MONEY WENT. PURE (no file, no network, no clock of its own, no Node module,
 * so the preview can import it in a browser).
 *
 * It takes the ordered balance changes the telemetry observed and the facts the game log offers (trade transactions,
 * contract ends, insurance claims, hangar requests, session boundaries), and labels EVERY balance change with at most
 * one cause and an honest confidence. The game log has no fee line, no balance and no contract reward amount, so a
 * label is only ever as strong as the evidence it rests on:
 *
 *   explained_by_transaction          a log transaction (cargo, or item/cargo that matched exactly) and a balance change
 *                                     that agree. confidence `matched`.
 *   fee_on_transaction                the part of a cargo settlement that exceeds the log amount, per cluster, measured by
 *                                     the commerce model's own reconciliation (tradeRun.ts `clusterFee`, not copied).
 *                                     confidence `measured`; `ambiguous` when the same window also holds another candidate.
 *   item_purchase                     a shop item line (completed) whose total equals one balance change. `matched`.
 *   probable_contract_reward          an otherwise unexplained rise shortly after a contract ended `completed`. `probable`:
 *                                     the amount comes from the balance alone, the log has no reward line.
 *   probable_insurance_or_hangar_cost an otherwise unexplained fall shortly after an insurance claim request or a hangar
 *                                     request completed. `probable`.
 *   unexplained                       everything else. Fuel, repairs, fines, transfers between players, rewards without a
 *                                     nearby event leave NO trace in the log: they can only be "non expliqué". A movement
 *                                     whose candidates disagree is `unexplained` with confidence `ambiguous`; one that spans a
 *                                     cut in the stream is `unexplained` with reason `stream_gap`.
 *
 * INVARIANT (tested): every balance change of the window goes to exactly one entry (a settlement that holds a price
 * AND a fee is one balance change split into two parts of ONE cause), and the amounts of all the entries add up, to the
 * aUEC, to the balance change of the window.
 *
 * ASSUMPTIONS, not measured against the real game (the log has no balance; only a capture of both at once could
 * measure them): see the MOVEMENT_* constants. What WAS measured, on 95 real logs of the reference install: none of the
 * 57 contract ends (any state) found in logs that also hold commerce lines lies within 30 s of a shop or commerce line;
 * the "Contract Complete" notice comes up to 3.1 s after `MissionEnded`; cargo purchases of one settlement are at least
 * 10 s apart (consistent with the 20 s cluster); only 12 % of item lines follow another one within 4 s.
 */

// -------------------------------------------------------------------------------------------------
// Bounds and tolerances
// -------------------------------------------------------------------------------------------------

/** A contract reward is looked for from this long before the contract end (the two end lines are up to 3.1 s apart: measured)... */
export const MOVEMENT_REWARD_BEFORE_MS = 3_000;
/** ... to this long after it (twice the ledger's settle delay: an ASSUMPTION, not measured). */
export const MOVEMENT_REWARD_AFTER_MS = 20_000;
/** Same for an insurance claim request or a hangar request completed (ASSUMPTION: no capture of the cost exists). */
export const MOVEMENT_COST_BEFORE_MS = 3_000;
export const MOVEMENT_COST_AFTER_MS = 20_000;
/** Unexplained changes of the same sign this close are shown as one line. */
export const MOVEMENT_MERGE_MS = 1_000;
/** An exact amount match is accepted within the larger of 1 aUEC and this share of the amount (as the fee reconciliation). */
export const MOVEMENT_MATCH_SLACK_SHARE = 0.001;
/** Movements listed in the payload (newest first); the totals always cover all of them. */
export const MOVEMENT_MAX_LISTED = 40;
/** Unexplained movements named in a run's decomposition. */
export const MOVEMENT_MAX_NAMED = 5;
/** Mirror of the telemetry's MAX_BALANCE_POINTS (a test keeps them equal): this many changes at most are remembered. */
export const MOVEMENT_HISTORY_CAP = 500;
/** Labels taken from the log (goods id, item class name, contract title, shop). */
export const MOVEMENT_LABEL_MAX = 60;

// -------------------------------------------------------------------------------------------------
// Shapes
// -------------------------------------------------------------------------------------------------

export const MOVEMENT_CATEGORIES = [
  "explained_by_transaction",
  "fee_on_transaction",
  "item_purchase",
  "probable_contract_reward",
  "probable_insurance_or_hangar_cost",
  "unexplained",
] as const;
export type MovementCategory = (typeof MOVEMENT_CATEGORIES)[number];

/**
 * matched    the log's amount and the balance's agree.
 * measured   a difference between the two, as the commerce model measures a fee.
 * probable   nothing but time proximity to an event of the log.
 * ambiguous  two causes of different kinds fit: none is chosen.
 * none       nothing explains it.
 */
export type MovementConfidence = "matched" | "measured" | "probable" | "ambiguous" | "none";
export type UnexplainedReason = "no_cause" | "ambiguous" | "stream_gap";
export type MovementHint =
  "contract_penalty" | "session_boundary" | "stream_gap" | "unmatched_transaction";
export type MovementCause = "insurance" | "hangar" | "insurance_or_hangar";

/** A contract that ended, from the ledger (state completed, failed, abandoned or ended). */
export interface ContractEnd {
  state: string;
  endedMs: number;
  title: string;
}

/** The log events the explainer uses, with their time (the ledger service keeps them; see `movementEvents`). */
export type MovementEventType =
  | "insurance_claim_requested"
  | "hangar_request_completed"
  | "login_completed"
  | "spawned"
  | "session_end";
export interface MovementEvent {
  type: MovementEventType;
  atMs: number;
}

/** One entry: a balance change, or the part of one that a cause explains. Times are epoch ms. */
export interface Movement {
  at: number;
  /** Signed aUEC, in the balance's sign: negative is money out. */
  amount: number;
  category: MovementCategory;
  confidence: MovementConfidence;
  side?: "buy" | "sell";
  /** Goods id (cargo), item class name (shop) or contract title; cleaned and capped. Never a guess. */
  ref?: string;
  shop?: string;
  cause?: MovementCause;
  /** Unexplained only. */
  reason?: UnexplainedReason;
  /** Ambiguous only: the categories that fit. */
  candidates?: MovementCategory[];
  /** Probable only: several events (or several changes for one event) compete, so the cause is not pinned to one. */
  several?: true;
  hints?: MovementHint[];
  /** A fee measured in a window that also holds another candidate cause: the figure may include it. */
  doubtful?: true;
}

export interface Coverage {
  /** Balance changes examined in the window. */
  changes: number;
  /** Of which spanned a cut in the stream (their time and content are not known). */
  gap_changes: number;
  /** The window starts before the oldest balance the server remembers: earlier changes are not in the figures. */
  starts_before_history: boolean;
  /** The history is at its cap: older changes were dropped. */
  history_full: boolean;
}

export type CategoryTotals = Record<MovementCategory, { count: number; auec: number }>;

export interface Explanation {
  /** Ascending in time. */
  movements: Movement[];
  totals: CategoryTotals;
  unexplained_split: Record<UnexplainedReason, number>;
  /** Sum of the amounts = the balance change of the window. */
  total_auec: number;
  /** Log transactions of the window for which no balance change was found (they may have failed silently). */
  unmatched_transactions: number;
  coverage: Coverage;
}

export interface ExplainInput {
  history: readonly BalancePoint[];
  /** The trade journal (cargo and items). Absent: no journal. */
  transactions: readonly Transaction[] | undefined;
  contracts: readonly ContractEnd[];
  events: readonly MovementEvent[];
  /** The window: balance changes after `from` (at it too when `fromInclusive`) up to `to`. */
  from: number;
  fromInclusive: boolean;
  to: number;
}

// -------------------------------------------------------------------------------------------------
// The explainer
// -------------------------------------------------------------------------------------------------

const emptyTotals = (): CategoryTotals =>
  Object.fromEntries(MOVEMENT_CATEGORIES.map((c) => [c, { count: 0, auec: 0 }])) as CategoryTotals;

const label = (value: unknown): string | undefined =>
  cleanLabel(value, MOVEMENT_LABEL_MAX) ?? undefined;

/** A line to match exactly against one balance change: a cargo line the reconciliation refused, or a shop item. */
interface Pending {
  t: number;
  side: "buy" | "sell";
  total: number;
  category: "explained_by_transaction" | "item_purchase";
  ref: string | undefined;
  shop: string | undefined;
}

const near = (t: number, at: number, before: number, after: number) =>
  t >= at - before && t <= at + after;

function itemTransactions(raw: readonly Transaction[] | undefined): Pending[] {
  const out: Pending[] = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    if (!r || typeof r !== "object" || r.kind !== "item" || r.status !== "completed") continue;
    if (r.side !== "buy" && r.side !== "sell") continue;
    // aUEC, or a shop that states no currency (the journal assumes aUEC and says so in `currency`).
    if (r.currency !== "aUEC" && !String(r.currency).startsWith("not stated")) continue;
    const t = typeof r.time === "string" ? Date.parse(r.time) : NaN;
    if (!Number.isFinite(t) || !(r.total_auec > 0) || r.total_auec > 1e12) continue;
    out.push({
      t,
      side: r.side,
      total: Math.round(r.total_auec),
      category: "item_purchase",
      ref: label(r.item),
      shop: label(r.shop),
    });
  }
  return out;
}

export function explainMovements(input: ExplainInput): Explanation {
  const { from, to } = input;
  const all = movesOf(input.history).filter((m) => m.delta !== 0);
  const inWin = (m: Move) => (input.fromInclusive ? m.at >= from : m.at > from) && m.at <= to;
  const prep = prepareTransactions(input.transactions);
  const items = itemTransactions(input.transactions);

  const rewardEnds = input.contracts.filter(
    (c) => c.state === "completed" && Number.isFinite(c.endedMs),
  );
  const penaltyEnds = input.contracts.filter(
    (c) => (c.state === "failed" || c.state === "abandoned") && Number.isFinite(c.endedMs),
  );
  const costEvents = input.events.filter(
    (e) => e.type === "insurance_claim_requested" || e.type === "hangar_request_completed",
  );
  const boundaries = input.events.filter(
    (e) => e.type === "login_completed" || e.type === "spawned" || e.type === "session_end",
  );
  const weakNear = (m: Move) =>
    m.delta > 0
      ? rewardEnds.some((c) =>
          near(m.at, c.endedMs, MOVEMENT_REWARD_BEFORE_MS, MOVEMENT_REWARD_AFTER_MS),
        )
      : costEvents.some((e) => near(m.at, e.atMs, MOVEMENT_COST_BEFORE_MS, MOVEMENT_COST_AFTER_MS));

  const taken = new Set<Move>();
  const entryOf = new Map<Move, Movement>();
  const entries: Movement[] = [];
  const unmatchedAt: number[] = [];

  // ---- 1. cargo settlements, with the commerce model's own reconciliation
  const pending: Pending[] = [];
  for (const side of ["buy", "sell"] as const) {
    const txs = prep.counted.filter((x) => x.side === side);
    for (const cluster of clustersOf(txs)) {
      const first = cluster[0]!.t;
      const last = cluster[cluster.length - 1]!.t;
      // Not even near the window: not this window's business.
      if (last + TRADE_MATCH_AFTER_MS < from || first - TRADE_MATCH_BEFORE_MS > to) continue;
      const r = clusterFee(cluster, side, prep.counted, prep.unconfirmed, all);
      const refuse = () => {
        for (const x of cluster)
          pending.push({
            t: x.t,
            side,
            total: x.total,
            category: "explained_by_transaction",
            ref: label(x.commodity),
            shop: label(x.shop),
          });
      };
      if (!r.ok) {
        refuse();
        continue;
      }
      const used = r.used.filter((m) => m.delta !== 0);
      const wholly = used.length > 0 && used.every(inWin);
      const none = used.every((m) => !inWin(m));
      if (!wholly || used.some((m) => taken.has(m))) {
        // A settlement cut by the window's edge: its changes inside stay unexplained, honestly ("unmatched_transaction").
        if (!none) for (const x of cluster) unmatchedAt.push(x.t);
        continue;
      }
      const sum = used.reduce((s, m) => s + m.delta, 0);
      const at = used[0]!.at;
      const goods = [...new Set(cluster.map((x) => label(x.commodity)))].filter(Boolean);
      const shops = [...new Set(cluster.map((x) => label(x.shop)))].filter(Boolean);
      const ref = goods.length === 1 ? goods[0] : undefined;
      const shop = shops.length === 1 ? shops[0] : undefined;
      // Another candidate cause in the same window: a shop item, or a contract/insurance event of the right sign.
      const doubtful =
        items.some(
          (x) => x.t >= first - TRADE_MATCH_BEFORE_MS && x.t <= last + TRADE_MATCH_AFTER_MS,
        ) || used.some(weakNear);
      const tx: Movement = {
        at,
        amount: sum + r.fee,
        category: "explained_by_transaction",
        confidence: "matched",
        side,
        ...(ref ? { ref } : {}),
        ...(shop ? { shop } : {}),
      };
      entries.push(tx);
      const parts: Movement[] = [tx];
      if (r.fee > 0) {
        const fee: Movement = {
          at: used[used.length - 1]!.at,
          amount: -r.fee,
          category: "fee_on_transaction",
          confidence: doubtful ? "ambiguous" : "measured",
          side,
          ...(ref ? { ref } : {}),
          ...(shop ? { shop } : {}),
          ...(doubtful ? { doubtful: true as const } : {}),
        };
        entries.push(fee);
        parts.push(fee);
      }
      for (const m of used) {
        taken.add(m);
        entryOf.set(m, parts[0]!);
      }
    }
  }

  // ---- 2. exact matches: shop items, and cargo lines the reconciliation could not settle
  pending.push(...items);
  pending.sort((a, b) => a.t - b.t);
  const owner = new Map<Move, Pending>();
  const candidatesOf = new Map<Pending, Move[]>();
  const matched = new Set<Pending>();
  for (const p of pending) {
    const slack = Math.max(1, p.total * MOVEMENT_MATCH_SLACK_SHARE);
    const sign = p.side === "buy" ? -1 : 1;
    const cands = all.filter(
      (m) =>
        inWin(m) &&
        !m.gap &&
        Math.sign(m.delta) === sign &&
        Math.abs(Math.abs(m.delta) - p.total) <= slack &&
        m.at >= p.t - TRADE_MATCH_BEFORE_MS &&
        m.at <= p.t + TRADE_MATCH_AFTER_MS,
    );
    candidatesOf.set(p, cands);
    const free = cands.find((m) => !taken.has(m));
    if (!free) {
      if (cands.length === 0 && inWinTime(p.t, from, to)) unmatchedAt.push(p.t);
      continue;
    }
    taken.add(free);
    owner.set(free, p);
    matched.add(p);
    const e: Movement = {
      at: free.at,
      amount: free.delta,
      category: p.category,
      confidence: "matched",
      side: p.side,
      ...(p.ref ? { ref: p.ref } : {}),
      ...(p.shop ? { shop: p.shop } : {}),
    };
    entries.push(e);
    entryOf.set(free, e);
  }
  // A line left without a change while its only candidates went to a line of another identity: the change could be
  // either. It is not chosen.
  for (const p of pending) {
    if (matched.has(p)) continue;
    for (const m of candidatesOf.get(p) ?? []) {
      const q = owner.get(m);
      const e = entryOf.get(m);
      if (!q || !e || q === p) continue;
      if (q.category === p.category && q.ref === p.ref) continue;
      e.category = "unexplained";
      e.confidence = "ambiguous";
      e.reason = "ambiguous";
      e.candidates = [...new Set([q.category, p.category])];
      delete e.side;
      delete e.ref;
      delete e.shop;
    }
    if ((candidatesOf.get(p) ?? []).length > 0) unmatchedAt.push(p.t);
  }

  // ---- 3. weak causes: an event of the log shortly before an otherwise unexplained change
  const rest = all.filter((m) => inWin(m) && !taken.has(m) && !m.gap);
  interface Weak {
    key: string;
    ref?: string;
    cause?: MovementCause;
  }
  const weakOf = new Map<Move, Weak[]>();
  const movesOfEvent = new Map<string, Move[]>();
  for (const m of rest) {
    const list: Weak[] = [];
    if (m.delta > 0) {
      rewardEnds.forEach((c, i) => {
        if (near(m.at, c.endedMs, MOVEMENT_REWARD_BEFORE_MS, MOVEMENT_REWARD_AFTER_MS))
          list.push({ key: `c${i}`, ref: label(c.title) });
      });
    } else {
      costEvents.forEach((e, i) => {
        if (near(m.at, e.atMs, MOVEMENT_COST_BEFORE_MS, MOVEMENT_COST_AFTER_MS))
          list.push({
            key: `e${i}`,
            cause: e.type === "insurance_claim_requested" ? "insurance" : "hangar",
          });
      });
    }
    if (list.length === 0) continue;
    weakOf.set(m, list);
    for (const w of list) movesOfEvent.set(w.key, [...(movesOfEvent.get(w.key) ?? []), m]);
  }
  for (const [m, list] of weakOf) {
    const several = list.length > 1 || list.some((w) => (movesOfEvent.get(w.key) ?? []).length > 1);
    const causes = new Set(list.map((w) => w.cause).filter(Boolean));
    const cause: MovementCause | undefined =
      causes.size === 0 ? undefined : causes.size === 1 ? [...causes][0] : "insurance_or_hangar";
    const e: Movement = {
      at: m.at,
      amount: m.delta,
      category: m.delta > 0 ? "probable_contract_reward" : "probable_insurance_or_hangar_cost",
      confidence: "probable",
      ...(!several && list[0]!.ref ? { ref: list[0]!.ref } : {}),
      ...(cause ? { cause } : {}),
      ...(several ? { several: true as const } : {}),
    };
    taken.add(m);
    entries.push(e);
    entryOf.set(m, e);
  }

  // ---- 4. everything else: unexplained, with what could be said about it (never a cause)
  const leftovers: Movement[] = [];
  for (const m of all) {
    if (!inWin(m) || taken.has(m)) continue;
    const hints: MovementHint[] = [];
    if (m.gap) hints.push("stream_gap");
    else {
      if (
        m.delta < 0 &&
        penaltyEnds.some((c) =>
          near(m.at, c.endedMs, MOVEMENT_COST_BEFORE_MS, MOVEMENT_COST_AFTER_MS),
        )
      )
        hints.push("contract_penalty");
      if (
        boundaries.some((e) => near(m.at, e.atMs, MOVEMENT_COST_BEFORE_MS, MOVEMENT_COST_AFTER_MS))
      )
        hints.push("session_boundary");
      if (
        unmatchedAt.some(
          (t) => m.at >= t - TRADE_MATCH_BEFORE_MS && m.at <= t + TRADE_MATCH_AFTER_MS,
        )
      )
        hints.push("unmatched_transaction");
    }
    leftovers.push({
      at: m.at,
      amount: m.delta,
      category: "unexplained",
      confidence: "none",
      reason: m.gap ? "stream_gap" : "no_cause",
      ...(hints.length ? { hints } : {}),
    });
  }
  // Same-sign changes a moment apart are one line (a payment that arrives in two frames), never across a stream cut.
  let lastEnd = Number.NEGATIVE_INFINITY;
  let open: Movement | null = null;
  for (const e of leftovers) {
    if (
      open &&
      open.reason === "no_cause" &&
      e.reason === "no_cause" &&
      Math.sign(open.amount) === Math.sign(e.amount) &&
      e.at - lastEnd <= MOVEMENT_MERGE_MS
    ) {
      open.amount += e.amount;
      lastEnd = e.at;
      const hints = new Set([...(open.hints ?? []), ...(e.hints ?? [])]);
      if (hints.size) open.hints = [...hints];
      continue;
    }
    open = e;
    lastEnd = e.at;
    entries.push(e);
  }

  entries.sort((a, b) => a.at - b.at);

  // ---- totals
  const totals = emptyTotals();
  const split: Record<UnexplainedReason, number> = { no_cause: 0, ambiguous: 0, stream_gap: 0 };
  let total = 0;
  for (const e of entries) {
    totals[e.category].count += 1;
    totals[e.category].auec += e.amount;
    total += e.amount;
    if (e.category === "unexplained") split[e.reason ?? "no_cause"] += e.amount;
  }
  const inWindow = all.filter(inWin);
  const oldest = input.history.length > 0 ? input.history[0]!.at : null;
  return {
    movements: entries,
    totals,
    unexplained_split: split,
    total_auec: total,
    unmatched_transactions: new Set(unmatchedAt).size,
    coverage: {
      changes: inWindow.length,
      gap_changes: inWindow.filter((m) => m.gap).length,
      starts_before_history: oldest === null || from < oldest,
      history_full: input.history.length >= MOVEMENT_HISTORY_CAP,
    },
  };
}

function inWinTime(t: number, from: number, to: number): boolean {
  return t + TRADE_MATCH_AFTER_MS >= from && t - TRADE_MATCH_BEFORE_MS <= to;
}

// -------------------------------------------------------------------------------------------------
// Plain words
// -------------------------------------------------------------------------------------------------

const THIN = String.fromCharCode(0x202f);

/** "+143 000", "−43 568" (the View's own format: narrow no-break space, true minus). */
export function moneyText(value: number, signed = false): string {
  const digits = String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  if (value < 0 && Math.round(value) !== 0) return "−" + digits;
  return signed && Math.round(value) > 0 ? "+" + digits : digits;
}

const NOTHING_IN_LOG =
  "Le journal du jeu n’a aucune ligne pour le carburant, les réparations, les amendes, les virements entre joueurs ni le montant d’une récompense : un mouvement non expliqué peut être l’un d’eux, rien ne permet de trancher.";

/** The sentence that says what the unexplained part is made of (or that it is empty). */
function unexplainedSentence(e: Explanation): string[] {
  const { no_cause, ambiguous, stream_gap } = e.unexplained_split;
  const n = e.totals.unexplained;
  if (n.count === 0) return ["Rien n’est resté non expliqué."];
  const bits: string[] = [];
  const count = (reason: UnexplainedReason) =>
    e.movements.filter((m) => m.category === "unexplained" && m.reason === reason).length;
  if (count("no_cause") > 0)
    bits.push(
      `${count("no_cause")} mouvement(s) sans aucune ligne du journal à côté (${moneyText(no_cause, true)} aUEC)`,
    );
  if (count("ambiguous") > 0)
    bits.push(
      `${count("ambiguous")} mouvement(s) que deux causes différentes pourraient expliquer, aucune n’est choisie (${moneyText(ambiguous, true)} aUEC)`,
    );
  if (count("stream_gap") > 0)
    bits.push(
      `${count("stream_gap")} variation(s) pendant une coupure du flux, dont ni l’heure ni le détail ne sont connus (${moneyText(stream_gap, true)} aUEC)`,
    );
  return ["Non expliqué : " + bits.join(" ; ") + ".", NOTHING_IN_LOG];
}

function coverageSentence(c: Coverage): string[] {
  const out: string[] = [];
  if (c.starts_before_history)
    out.push(
      "Le serveur n’a pas vu le solde au début de cette période : les mouvements d’avant ne sont pas dans ces chiffres.",
    );
  if (c.history_full)
    out.push(
      "La mémoire des variations du solde est pleine (500) : les plus anciennes ont été oubliées.",
    );
  return out;
}

/** The plain-language account of a window (a session). */
export function explainWindowText(e: Explanation): string[] {
  const out: string[] = [];
  if (e.coverage.changes === 0) {
    out.push("Aucune variation du solde vue sur cette période.");
    return [...out, ...coverageSentence(e.coverage)];
  }
  out.push(
    `Variation du solde sur la période : ${moneyText(e.total_auec, true)} aUEC en ${e.coverage.changes} variation(s).`,
  );
  const t = e.totals;
  const parts: string[] = [];
  if (t.explained_by_transaction.count)
    parts.push(
      `transactions de marchandise rapprochées du journal ${moneyText(t.explained_by_transaction.auec, true)}`,
    );
  if (t.fee_on_transaction.count)
    parts.push(`frais mesurés ${moneyText(t.fee_on_transaction.auec, true)}`);
  if (t.item_purchase.count) parts.push(`objets ${moneyText(t.item_purchase.auec, true)}`);
  if (t.probable_contract_reward.count)
    parts.push(
      `récompenses probables de contrat ${moneyText(t.probable_contract_reward.auec, true)}`,
    );
  if (t.probable_insurance_or_hangar_cost.count)
    parts.push(
      `coûts probables d’assurance ou de hangar ${moneyText(t.probable_insurance_or_hangar_cost.auec, true)}`,
    );
  if (t.unexplained.count) parts.push(`non expliqué ${moneyText(t.unexplained.auec, true)}`);
  if (parts.length) out.push("Dont : " + parts.join(" ; ") + ".");
  out.push(...unexplainedSentence(e));
  if (e.unmatched_transactions > 0)
    out.push(
      `${e.unmatched_transactions} ligne(s) du journal n’ont trouvé aucun mouvement du solde correspondant.`,
    );
  out.push(...coverageSentence(e.coverage));
  return out;
}

// -------------------------------------------------------------------------------------------------
// A run: the net, decomposed
// -------------------------------------------------------------------------------------------------

export interface UnexplainedNamed {
  at: string;
  amount: number;
  reason: UnexplainedReason;
  hints: MovementHint[];
}

export interface RunDecomposition {
  window: { from: string; to: string };
  /** The net as the commerce model measured it: the balance variation over the run. */
  net: number;
  /** The model's gross margin (null when it has none). */
  margin: number | null;
  /** In the balance's sign (negative = out). Together they add up to `net`, exactly. */
  parts: {
    transactions: number;
    fees: number;
    items: number;
    probable_rewards: number;
    probable_costs: number;
    unexplained: number;
    ambiguous: number;
    stream_gap: number;
  };
  /** net - (margin + fees + items + rewards + costs): what neither the margin nor a named cause explains. null without a margin. */
  residual: number | null;
  /**
   * The margin equation closes: the transaction parts equal the gross margin (everything bought was sold in the run,
   * no stock from before, every line found its balance change). When false, only the movements are added up.
   */
  closes: boolean;
  /** The fees were measured in a window that also holds another candidate cause: they may include it. */
  fees_doubtful: boolean;
  unmatched_transactions: number;
  named: UnexplainedNamed[];
  coverage: Coverage;
  explanation: string[];
}

export interface RunFacts {
  net: number;
  margin: number | null;
  /** Anything that stops the margin from being the sum of the transaction parts. */
  marginPartial: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function decomposeRun(
  e: Explanation,
  run: RunFacts,
  from: number,
  to: number,
): RunDecomposition {
  const t = e.totals;
  const parts = {
    transactions: t.explained_by_transaction.auec,
    fees: t.fee_on_transaction.auec,
    items: t.item_purchase.auec,
    probable_rewards: t.probable_contract_reward.auec,
    probable_costs: t.probable_insurance_or_hangar_cost.auec,
    unexplained: e.unexplained_split.no_cause,
    ambiguous: e.unexplained_split.ambiguous,
    stream_gap: e.unexplained_split.stream_gap,
  };
  const known = parts.fees + parts.items + parts.probable_rewards + parts.probable_costs;
  const residual = run.margin === null ? null : run.net - (run.margin + known);
  const slack = Math.max(1, Math.abs(run.margin ?? 0) * 0.001);
  const closes =
    run.margin !== null &&
    !run.marginPartial &&
    e.unmatched_transactions === 0 &&
    Math.abs(parts.transactions - run.margin) <= slack;
  const doubtful = e.movements.some((m) => m.doubtful === true);
  const named = e.movements
    .filter((m) => m.category === "unexplained")
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, MOVEMENT_MAX_NAMED)
    .sort((a, b) => a.at - b.at)
    .map((m) => ({
      at: iso(m.at),
      amount: m.amount,
      reason: m.reason ?? ("no_cause" as const),
      hints: m.hints ?? [],
    }));
  const d: RunDecomposition = {
    window: { from: iso(from), to: iso(to) },
    net: run.net,
    margin: run.margin,
    parts,
    residual,
    closes,
    fees_doubtful: doubtful,
    unmatched_transactions: e.unmatched_transactions,
    named,
    coverage: e.coverage,
    explanation: [],
  };
  d.explanation = decompositionText(d, e);
  return d;
}

function decompositionText(d: RunDecomposition, e: Explanation): string[] {
  const out: string[] = [];
  const p = d.parts;
  const m = moneyText;
  const lines: string[] = [];
  if (d.closes && d.margin !== null) {
    lines.push(`marge brute ${m(d.margin, true)}`);
    if (p.fees)
      lines.push(
        `frais ${m(p.fees, true)}${d.fees_doubtful ? " (peut inclure un autre mouvement)" : " (mesurés)"}`,
      );
  } else {
    if (p.transactions)
      lines.push(`ventes moins achats rapprochés du journal ${m(p.transactions, true)}`);
    if (p.fees)
      lines.push(
        `frais ${m(p.fees, true)}${d.fees_doubtful ? " (peut inclure un autre mouvement)" : " (mesurés)"}`,
      );
  }
  if (p.items) lines.push(`objets achetés ${m(p.items, true)}`);
  if (p.probable_rewards)
    lines.push(
      `récompenses probables de contrat ${m(p.probable_rewards, true)} (montant lu sur le solde seul)`,
    );
  if (p.probable_costs)
    lines.push(`coûts probables d’assurance ou de hangar ${m(p.probable_costs, true)}`);
  // What is left of the net once every named part is out: by construction the unexplained movements.
  const rest = d.net - (p.transactions + p.fees + p.items + p.probable_rewards + p.probable_costs);
  lines.push(`non expliqué ${m(rest, true)}`);
  out.push(`Variation du solde ${m(d.net, true)} aUEC = ` + lines.join(" ; ") + ".");
  if (!d.closes)
    out.push(
      "Le compte ne se ferme pas sur la marge brute (SCU invendus, stock d’avant, ligne sans variation du solde ou marge inconnue) : seules les variations du solde sont additionnées.",
    );
  out.push(...unexplainedSentence(e));
  if (d.unmatched_transactions > 0)
    out.push(
      `${d.unmatched_transactions} ligne(s) du journal n’ont trouvé aucun mouvement du solde correspondant.`,
    );
  out.push(...coverageSentence(d.coverage));
  return out;
}

// -------------------------------------------------------------------------------------------------
// The session section (what the View lists)
// -------------------------------------------------------------------------------------------------

export interface MovementView {
  at: string;
  amount: number;
  category: MovementCategory;
  confidence: MovementConfidence;
  side?: "buy" | "sell";
  ref?: string;
  shop?: string;
  cause?: MovementCause;
  reason?: UnexplainedReason;
  candidates?: MovementCategory[];
  several?: true;
  hints?: MovementHint[];
  doubtful?: true;
}

export interface MovementsSection {
  v: 1;
  window: { from: string; to: string; basis: "session" | "history" };
  total_auec: number;
  count: number;
  totals: CategoryTotals;
  unexplained_split: Record<UnexplainedReason, number>;
  unmatched_transactions: number;
  coverage: Coverage;
  /** Newest first, at most MOVEMENT_MAX_LISTED. */
  listed: MovementView[];
  truncated: boolean;
  explanation: string[];
}

export function movementView(m: Movement): MovementView {
  const { at, ...rest } = m;
  return { at: iso(at), ...rest };
}

/**
 * The section for the current game session: from the latest `login_completed` of the log (else from the oldest
 * balance the server remembers) to now. Every amount in it is derived from the balance: build it only when the View
 * asked for the balance.
 */
export function buildMovementsSection(
  input: Omit<ExplainInput, "from" | "fromInclusive" | "to"> & { nowMs: number },
): MovementsSection | null {
  if (input.history.length < 2) return null;
  const logins = input.events.filter((e) => e.type === "login_completed" && e.atMs <= input.nowMs);
  const login = logins.length > 0 ? Math.max(...logins.map((e) => e.atMs)) : null;
  const oldest = input.history[0]!.at;
  const useLogin = login !== null && login >= oldest;
  const from = useLogin ? login : oldest;
  const e = explainMovements({
    ...input,
    from,
    fromInclusive: useLogin,
    to: input.nowMs,
  });
  // The session began before the first balance the server saw: the figures miss what happened in between.
  if (login !== null && login < oldest) e.coverage.starts_before_history = true;
  const newestFirst = [...e.movements].reverse();
  return {
    v: 1,
    // `to` is the newest balance change seen, NOT the clock: the section must not change while the balance does not, or
    // the ledger's hash would change at every poll and the delta protocol would resend it each time.
    window: {
      from: iso(from),
      to: iso(input.history[input.history.length - 1]!.at),
      basis: useLogin ? "session" : "history",
    },
    total_auec: e.total_auec,
    count: e.movements.length,
    totals: e.totals,
    unexplained_split: e.unexplained_split,
    unmatched_transactions: e.unmatched_transactions,
    coverage: e.coverage,
    listed: newestFirst.slice(0, MOVEMENT_MAX_LISTED).map(movementView),
    truncated: newestFirst.length > MOVEMENT_MAX_LISTED,
    explanation: explainWindowText(e).map((s) => s.slice(0, 400)),
  };
}

/**
 * HOOK for the session summary (the sessions PR owns that file; nothing here writes to it). A session can store these
 * few numbers beside its start and end balance: how much of its balance variation each kind of cause explains. They
 * are balance-derived like everything else here: only ever computed with the balance allowed, and `unexplained_auec`
 * is a lower bound of "money whose cause is unknown", never a claim about what it was.
 */
export function movementsForSummary(section: MovementsSection | null): {
  total_auec: number;
  fees_auec: number;
  unexplained_auec: number;
} | null {
  if (!section) return null;
  return {
    total_auec: section.total_auec,
    fees_auec: section.totals.fee_on_transaction.auec,
    unexplained_auec: section.totals.unexplained.auec,
  };
}
