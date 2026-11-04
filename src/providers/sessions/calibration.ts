import {
  calibrationExpected,
  calibrationKey,
  calibrationPick,
} from "../../dashboard/calibrationPanel.js";
import { effectiveResults } from "./stats.js";
import type { Session, Trip } from "./types.js";

/**
 * Route calibration: how the player's OWN saved trade runs compare with what the plan promised.
 *
 * Why: UEX prices are crowdsourced and, for most routes, nobody reported them recently, so the planner's profit is a
 * guess. A run the player really made, with the plan that was applied before it, is evidence. PURE: sessions in,
 * figures out, no clock of its own (`nowMs` is an input), no file, no network.
 *
 * WHAT IS COMPARED. For a trade trip that carries a planned profit (`planned_profit_auec`, a margin BEFORE fees):
 *   - gross ratio = gross margin realised / planned profit (like for like: neither holds the loading fees);
 *   - net ratio   = net realised / planned profit, only for a run whose net is the run's own: the net and the fees are known,
 *                   the commerce model did not flag the net as doubtful, and what the margin and the fees leave unexplained
 *                   of the balance change (gross margin - net - fees, or the `unexplained_auec` the model measured) is at
 *                   most 2 % of the turnover. A net that holds a purchase made elsewhere or a reward is left out and
 *                   counted (`net_excluded`), never guessed. Without that information (an older trip) it is left out too;
 *   - fee rate    = fees / turnover.
 * A plan below CALIBRATION_MIN_PLANNED_AUEC (or below the run's own fees) is ignored: a ratio over a few aUEC is noise.
 * The planned profit is first brought to the quantity really moved when the plan's quantity is known and differs by
 * more than 2 % (a half-loaded hold is not a bad price); a run moved 4 times more or less than planned is left out.
 * Without the planned quantity (older trips) the plan is used as it is and the group says so.
 *
 * GROUPS. By commodity (exact name match once lower-cased and stripped of signs; never a prefix match, never another
 * commodity) and, when the trip holds the plan's two terminals, by route. A commodity group pools every route of that
 * commodity. A figure from one group is never carried to another.
 *
 * WHICH RUNS COUNT, per group, newest first, at most the last CALIBRATION_LAST_RUNS:
 *   - older than CALIBRATION_MAX_AGE_DAYS (60): excluded (prices and routes move);
 *   - from another patch line (the first two numbers of the game version, "4.10") than the current one: excluded.
 *     A run whose version is unknown is kept and counted (`unknown_version`); with no current version known, no run is
 *     excluded for its patch;
 *   - a duplicate of a run stored twice, and a run with no planned profit above zero or no gross margin: not a sample.
 *
 * TYPICAL RATIO. Pooled: the sum of the realised over the sum of the planned, with the median, the minimum and the maximum of
 * the per-run ratios beside it. It is NOT the efficiency figure the sessions already show (`money.plan.efficiency`): that
 * one is the measured result (net, else gross margin) over the plan AS PLANNED, while this one is the gross margin over
 * the plan rescaled to the quantity really moved, so the two can differ on purpose.
 *
 * GOODS NOT VERIFIED. The game log never names goods, so every real plan is tied to its run by the resemblance of the
 * prices (trips.ts `planLinkOf`): a group that rests on such a run says `goods_unverified`, is never labelled `high`,
 * and must never be quoted as if the goods had been checked.
 *
 * CONFIDENCE (none / low / medium / high), from the number of runs n and the spread (max minus min of the per-run ratios,
 * in points of the plan):
 *   none   : n < 2. No figure is given at all, only n.
 *   low    : n is 2 or 3; OR the spread is above 0.6; OR the newest used run is older than 21 days.
 *   medium : n from 4 to 7, spread at most 0.6, fresh.
 *   high   : n is 8 (the cap), spread at most 0.3, fresh. (With a spread between 0.3 and 0.6, medium.) Never high when
 *            a run's plan was tied to it by prices rather than by the goods' name (the log names goods by an id only).
 * It is a label of how much to lean on the figure, not a probability. The real prices can change tomorrow.
 *
 * It claims no cause: a ratio below 1 can come from the prices, the quantity, a slow sale, a price that moved while
 * the player flew. The figures are ESTIMATES drawn from a handful of runs.
 *
 * PRIVACY: ratios and fee rates are derived from the balance. They are returned only to callers that were allowed the
 * balance (the tool with include_balance, the poll for a View that shows it).
 */

export const CALIBRATION_MAX_AGE_DAYS = 60;
export const CALIBRATION_LAST_RUNS = 8;
export const CALIBRATION_STALE_DAYS = 21;
export const CALIBRATION_QUANTITY_TOLERANCE = 0.02;
/** A run that moved less than a quarter or more than four times the planned quantity is not comparable. */
export const CALIBRATION_QUANTITY_RANGE: readonly [number, number] = [0.25, 4];
export const CALIBRATION_MIN_RUNS = 2;
/** A plan under this (or under the run's fees) is not compared: a choice, to keep a ratio of a few aUEC out. */
export const CALIBRATION_MIN_PLANNED_AUEC = 1000;
/** A net whose unexplained part of the balance change is above this share of the turnover is not the run's own. */
export const CALIBRATION_UNEXPLAINED_SHARE = 0.02;
export const CALIBRATION_SPREAD_HIGH = 0.6;
export const CALIBRATION_SPREAD_TIGHT = 0.3;
/** Groups kept in the report / in the dashboard poll. */
export const CALIBRATION_MAX_GROUPS = { commodity: 20, route: 20 } as const;
export const CALIBRATION_POLL_GROUPS = { commodity: 8, route: 6 } as const;

export type Confidence = "none" | "low" | "medium" | "high";
export type ConfidenceReason = "few_runs" | "high_variance" | "not_recent" | "goods_unverified";

export interface CalibrationGroup {
  kind: "commodity" | "route";
  commodity: string;
  buy_terminal: string | null;
  sell_terminal: string | null;
  /** Runs used (the most recent ones, within the age and patch rules). Always given. */
  n: number;
  /** Confidence in the gross ratio, which is the headline. */
  confidence: Confidence;
  reasons: ConfidenceReason[];
  /** Realised gross margin over the planned profit; null below 2 runs. */
  gross_ratio: number | null;
  gross_median: number | null;
  gross_min: number | null;
  gross_max: number | null;
  high_variance: boolean;
  /** Realised net over the planned profit, from the runs whose net is their own; null below 2 such runs. */
  net_ratio: number | null;
  net_n: number;
  /** Runs left out of the net because it held a movement of the balance that is not the run's (or could not be told). */
  net_excluded: number;
  net_confidence: Confidence;
  /** Fees as a share of the turnover, from the runs that have both; null below 2. */
  fee_rate: number | null;
  fee_n: number;
  /** How many of those fee rates were measured against the balance (the others were deduced). */
  fee_measured: number;
  last_run_at: string | null;
  last_run_age_days: number | null;
  /** Runs whose plan was scaled to the quantity really moved / whose planned quantity was not stored. */
  quantity_adjusted: number;
  quantity_unknown: number;
  unknown_version: number;
  /** Runs whose plan was tied to them by prices (the log names goods by an id, so the goods were not verified). */
  linked_by_prices: number;
  /** True when at least one used run was tied to its plan by prices: never quote the group as verified. */
  goods_unverified: boolean;
  /** Runs of this group that were left out, by reason. */
  excluded: {
    old: number;
    other_patch: number;
    quantity: number;
    small_plan: number;
    beyond_last: number;
  };
}

export interface CalibrationReport {
  v: 1;
  as_of: string;
  /** The current patch line the runs were matched against ("4.10"), or null when the current version is not known. */
  patch_line: string | null;
  rules: {
    max_age_days: number;
    last_runs: number;
    stale_days: number;
    min_runs: number;
    spread_high: number;
    spread_tight: number;
  };
  /** Trade runs that carry a planned profit and a result (before the age, patch and quantity rules). */
  runs_with_plan: number;
  groups: CalibrationGroup[];
  note: string;
}

/**
 * Said with every answer of the tool. It must stay under 200 characters: the registry cuts every string of an
 * untrusted_text answer there, and the part about unverified goods must survive.
 */
export const CALIBRATION_NOTE =
  "ESTIMATE from the player's own runs; few runs = low confidence; no cause claimed. goods_unverified true: plan tied to runs by price resemblance, not name; never call it verified.";

// -------------------------------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const norm = calibrationKey;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** "4.10" from "4.10.197.2878 (build 12881860)"; null when the text does not start with two numbers. */
export function patchLine(version: string | null | undefined): string | null {
  const m = /^\s*(\d+)\.(\d+)/.exec(version ?? "");
  return m ? `${m[1]}.${m[2]}` : null;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface Pair {
  num: number;
  den: number;
}

interface RatioFigures {
  typical: number;
  median: number;
  min: number;
  max: number;
  spread: number;
}

/** Pooled ratio plus the per-run median and range. Null below CALIBRATION_MIN_RUNS pairs. */
function ratioOf(pairs: readonly Pair[]): RatioFigures | null {
  if (pairs.length < CALIBRATION_MIN_RUNS) return null;
  const per = pairs.map((p) => p.num / p.den);
  const min = Math.min(...per);
  const max = Math.max(...per);
  return {
    typical: round3(sum(pairs.map((p) => p.num)) / sum(pairs.map((p) => p.den))),
    median: round3(median(per)),
    min: round3(min),
    max: round3(max),
    spread: round3(max - min),
  };
}

/** The confidence label for n runs, a spread and the age of the newest one (see the header). */
export function confidenceOf(
  n: number,
  spread: number | null,
  newestAgeDays: number | null,
  goodsUnverified = false,
): { confidence: Confidence; reasons: ConfidenceReason[] } {
  if (n < CALIBRATION_MIN_RUNS || spread === null) return { confidence: "none", reasons: [] };
  const reasons: ConfidenceReason[] = [];
  if (n < 4) reasons.push("few_runs");
  if (spread > CALIBRATION_SPREAD_HIGH) reasons.push("high_variance");
  if (newestAgeDays !== null && newestAgeDays > CALIBRATION_STALE_DAYS) reasons.push("not_recent");
  let confidence: Confidence;
  if (reasons.length > 0) confidence = "low";
  else if (n >= CALIBRATION_LAST_RUNS && spread <= CALIBRATION_SPREAD_TIGHT) confidence = "high";
  else confidence = "medium";
  // The plan was tied to the runs by their prices, not by the goods' name: never the top label.
  if (goodsUnverified && confidence === "high") {
    confidence = "medium";
    reasons.push("goods_unverified");
  }
  return { confidence, reasons };
}

// -------------------------------------------------------------------------------------------------
// Samples
// -------------------------------------------------------------------------------------------------

type Skip = "old" | "other_patch" | "quantity" | "small_plan" | null;

interface Sample {
  commodity: string;
  buy: string | null;
  sell: string | null;
  endedMs: number;
  endedAt: string;
  skip: Skip;
  gross: Pair;
  net: Pair | null;
  /** A net was recorded but is not the run's own. */
  netPolluted: boolean;
  fee: (Pair & { measured: boolean }) | null;
  adjusted: boolean;
  quantityUnknown: boolean;
  versionUnknown: boolean;
  byPrices: boolean;
}

/** The sessions the sessions' own statistics look at (`last` newest ones, empty ones ignored). */
export function usedSessions(sessions: readonly Session[], last?: number): readonly Session[] {
  const used = sessions.filter(
    (s) => s.trips.length > 0 || s.active_ms > 0 || s.start_balance !== null,
  );
  return last ? used.slice(-last) : used;
}

function samplesOf(
  sessions: readonly Session[],
  nowMs: number,
  current: string | null,
): { samples: Sample[]; withPlan: number } {
  const samples: Sample[] = [];
  let withPlan = 0;
  for (const s of sessions) {
    const line = patchLine(s.game_version);
    for (const e of effectiveResults(s.trips)) {
      const t: Trip = e.trip;
      if (e.duplicate || t.kind !== "trade" || t.source !== "trade_journal") continue;
      const planned = t.planned_profit_auec;
      if (t.commodity === null || planned === null || !(planned > 0)) continue;
      if (t.gross_margin_auec === null) continue;
      const endedMs = Date.parse(t.ended_at);
      if (!Number.isFinite(endedMs)) continue;
      withPlan += 1;
      // The plan, for the quantity really moved.
      let plannedAdj = planned;
      let adjusted = false;
      let quantityUnknown = true;
      let skip: Skip = null;
      if (t.planned_scu !== null && t.planned_scu > 0 && t.scu !== null && t.scu > 0) {
        quantityUnknown = false;
        const factor = t.scu / t.planned_scu;
        if (factor < CALIBRATION_QUANTITY_RANGE[0] || factor > CALIBRATION_QUANTITY_RANGE[1])
          skip = "quantity";
        else if (Math.abs(factor - 1) > CALIBRATION_QUANTITY_TOLERANCE) {
          plannedAdj = planned * factor;
          adjusted = true;
        }
      }
      if (skip === null && planned < Math.max(CALIBRATION_MIN_PLANNED_AUEC, t.fees_auec ?? 0))
        skip = "small_plan";
      if (skip === null && nowMs - endedMs > CALIBRATION_MAX_AGE_DAYS * DAY) skip = "old";
      if (skip === null && current !== null && line !== null && line !== current)
        skip = "other_patch";
      // A net counts only when it is the run's own: with its fees, not flagged doubtful, and with what the margin and the
      // fees leave unexplained of the balance change small. Measured fees give that residual from the figures stored;
      // deduced fees (net = margin - fees by construction) only the model's own measure can tell, so an older trip without
      // it is left out.
      const turnover = t.revenue_auec ?? 0;
      const residual =
        t.unexplained_auec ??
        (t.fees_method === "mesure" && t.fees_auec !== null && t.net_auec !== null
          ? t.gross_margin_auec - t.net_auec - t.fees_auec
          : null);
      const hasNet = t.net_auec !== null && t.fees_auec !== null;
      const netClean =
        hasNet &&
        t.net_doubtful !== true &&
        residual !== null &&
        turnover > 0 &&
        Math.abs(residual) <= CALIBRATION_UNEXPLAINED_SHARE * turnover;
      samples.push({
        commodity: t.commodity,
        buy: t.plan_buy_terminal,
        sell: t.plan_sell_terminal,
        endedMs,
        endedAt: new Date(endedMs).toISOString(),
        skip,
        gross: { num: t.gross_margin_auec, den: plannedAdj },
        net: netClean ? { num: t.net_auec as number, den: plannedAdj } : null,
        netPolluted: hasNet && !netClean,
        fee:
          t.fees_auec !== null && t.revenue_auec !== null && t.revenue_auec > 0
            ? { num: t.fees_auec, den: t.revenue_auec, measured: t.fees_method === "mesure" }
            : null,
        adjusted,
        quantityUnknown,
        versionUnknown: line === null,
        byPrices: t.plan_link === "prices",
      });
    }
  }
  return { samples, withPlan };
}

function groupOf(
  kind: CalibrationGroup["kind"],
  members: readonly Sample[],
  nowMs: number,
): CalibrationGroup {
  const first = members[0]!;
  const excluded = { old: 0, other_patch: 0, quantity: 0, small_plan: 0, beyond_last: 0 };
  for (const m of members) if (m.skip) excluded[m.skip] += 1;
  const eligible = members.filter((m) => m.skip === null).sort((a, b) => b.endedMs - a.endedMs);
  const used = eligible.slice(0, CALIBRATION_LAST_RUNS);
  excluded.beyond_last = eligible.length - used.length;
  const newest = used[0] ?? null;
  const age = newest ? Math.max(0, Math.floor((nowMs - newest.endedMs) / DAY)) : null;
  const gross = ratioOf(used.map((u) => u.gross));
  const netSamples = used.filter((u) => u.net !== null);
  const net = ratioOf(netSamples.map((u) => u.net as Pair));
  const fees = used.filter((u) => u.fee !== null);
  const byPrices = used.filter((u) => u.byPrices).length;
  const verdict = confidenceOf(used.length, gross ? gross.spread : null, age, byPrices > 0);
  const netVerdict = confidenceOf(netSamples.length, net ? net.spread : null, age, byPrices > 0);
  // Fees over turnover, pooled like the other ratios (a big run weighs more than a small one).
  const feeFigures = ratioOf(fees.map((u) => u.fee as Pair));
  return {
    kind,
    commodity: first.commodity,
    buy_terminal: kind === "route" ? first.buy : null,
    sell_terminal: kind === "route" ? first.sell : null,
    n: used.length,
    confidence: verdict.confidence,
    reasons: verdict.reasons,
    gross_ratio: gross ? gross.typical : null,
    gross_median: gross ? gross.median : null,
    gross_min: gross ? gross.min : null,
    gross_max: gross ? gross.max : null,
    high_variance: gross ? gross.spread > CALIBRATION_SPREAD_HIGH : false,
    net_ratio: net ? net.typical : null,
    net_n: netSamples.length,
    net_excluded: used.filter((u) => u.netPolluted).length,
    net_confidence: netVerdict.confidence,
    fee_rate: feeFigures ? feeFigures.typical : null,
    fee_n: fees.length,
    fee_measured: fees.filter((u) => (u.fee as { measured: boolean }).measured).length,
    last_run_at: newest ? newest.endedAt : null,
    last_run_age_days: age,
    quantity_adjusted: used.filter((u) => u.adjusted).length,
    quantity_unknown: used.filter((u) => u.quantityUnknown).length,
    unknown_version: used.filter((u) => u.versionUnknown).length,
    linked_by_prices: byPrices,
    goods_unverified: byPrices > 0,
    excluded,
  };
}

// -------------------------------------------------------------------------------------------------
// The report
// -------------------------------------------------------------------------------------------------

export interface CalibrationOptions {
  nowMs: number;
  /** The game version now (a session's `game_version`): runs of another patch line are left out. Null: no patch rule. */
  gameVersion?: string | null;
}

const byWeight = (a: CalibrationGroup, b: CalibrationGroup) =>
  b.n - a.n ||
  (a.last_run_age_days ?? Infinity) - (b.last_run_age_days ?? Infinity) ||
  a.commodity.localeCompare(b.commodity);

export function buildCalibration(
  sessions: readonly Session[],
  opts: CalibrationOptions,
): CalibrationReport {
  const current = patchLine(opts.gameVersion);
  const { samples, withPlan } = samplesOf(sessions, opts.nowMs, current);
  const commodities = new Map<string, Sample[]>();
  const routes = new Map<string, Sample[]>();
  for (const s of samples) {
    const ck = norm(s.commodity);
    if (ck === "") continue;
    commodities.set(ck, [...(commodities.get(ck) ?? []), s]);
    if (s.buy !== null && s.sell !== null && norm(s.buy) !== "" && norm(s.sell) !== "") {
      const rk = `${ck}|${norm(s.buy)}|${norm(s.sell)}`;
      routes.set(rk, [...(routes.get(rk) ?? []), s]);
    }
  }
  const all = (m: Map<string, Sample[]>, kind: CalibrationGroup["kind"], max: number) =>
    [...m.values()]
      .map((list) => groupOf(kind, list, opts.nowMs))
      // A group with no run left after the rules has nothing to say.
      .filter((g) => g.n > 0)
      .sort(byWeight)
      .slice(0, max);
  return {
    v: 1,
    as_of: new Date(opts.nowMs).toISOString(),
    patch_line: current,
    rules: {
      max_age_days: CALIBRATION_MAX_AGE_DAYS,
      last_runs: CALIBRATION_LAST_RUNS,
      stale_days: CALIBRATION_STALE_DAYS,
      min_runs: CALIBRATION_MIN_RUNS,
      spread_high: CALIBRATION_SPREAD_HIGH,
      spread_tight: CALIBRATION_SPREAD_TIGHT,
    },
    runs_with_plan: withPlan,
    groups: [
      ...all(commodities, "commodity", CALIBRATION_MAX_GROUPS.commodity),
      ...all(routes, "route", CALIBRATION_MAX_GROUPS.route),
    ],
    note: CALIBRATION_NOTE,
  };
}

// -------------------------------------------------------------------------------------------------
// Using it
// -------------------------------------------------------------------------------------------------

/**
 * The group to lean on for a commodity (and a route when both terminals are given): the route's when it has at least
 * two runs, else the commodity's when it has at least two. Never another commodity's. null when there is nothing.
 */
export function pickGroup(
  groups: readonly CalibrationGroup[],
  commodity: string,
  buy?: string | null,
  sell?: string | null,
): { group: CalibrationGroup; scope: "route" | "commodity" } | null {
  // The one implementation lives with the View (dashboard/calibrationPanel.ts), which draws the card line.
  return calibrationPick({ groups }, commodity, buy, sell);
}

/**
 * "Net expected ≈ planned x the typical ratio (n runs)": an ESTIMATE, never a promise.
 *   net_ratio                : planned x the net ratio, when at least two runs have their net and fees.
 *   gross_ratio_minus_fees   : planned x the gross ratio minus the typical fee rate x the planned turnover, when the
 *                              net ratio is not available but the gross ratio and the fee rate are (needs the turnover).
 * null when neither can be worked out. The one implementation lives with the View (dashboard/calibrationPanel.ts) because
 * the card draws it; it is re-exported here for the server's side.
 */
export const expectedNet = calibrationExpected;

// -------------------------------------------------------------------------------------------------
// What the dashboard poll carries
// -------------------------------------------------------------------------------------------------

/** What the View reads of a group: the figures and their sample size, not the audit trail (that stays in the tool). */
export type PollGroup = Omit<
  CalibrationGroup,
  | "reasons"
  | "gross_median"
  | "fee_measured"
  | "last_run_at"
  | "unknown_version"
  | "linked_by_prices"
  | "excluded"
>;

export interface CalibrationSection {
  v: 1;
  patch_line: string | null;
  groups: PollGroup[];
}

function slim(g: CalibrationGroup): PollGroup {
  const {
    reasons: _r,
    gross_median: _m,
    fee_measured: _f,
    last_run_at: _l,
    unknown_version: _u,
    linked_by_prices: _p,
    excluded: _e,
    ...rest
  } = g;
  void [_r, _m, _f, _l, _u, _p, _e];
  return rest;
}

/** The report as the dashboard poll carries it: only groups with at least two runs, fewer of them, no prose. */
export function calibrationForPoll(report: CalibrationReport): CalibrationSection {
  const keep = (kind: CalibrationGroup["kind"], max: number) =>
    report.groups
      .filter((g) => g.kind === kind && g.n >= CALIBRATION_MIN_RUNS)
      .slice(0, max)
      .map(slim);
  return {
    v: 1,
    patch_line: report.patch_line,
    groups: [
      ...keep("commodity", CALIBRATION_POLL_GROUPS.commodity),
      ...keep("route", CALIBRATION_POLL_GROUPS.route),
    ],
  };
}
