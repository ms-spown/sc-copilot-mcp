import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { rowTimestamp } from "./freshness.js";
import { assessRow, BUILT_IN_LEGEND } from "./marketStatus.js";
import { ageDays, isRow, label, toNumber, unwrapData, type Row } from "./normalize.js";

/**
 * The pre-flight check: "does the plan still hold?". A trade plan is a guess made earlier from UEX prices; this re-reads
 * the CURRENT UEX rows of the plan's goods at its two terminals and says, leg by leg and overall, whether the figures
 * the plan rests on have moved.
 *
 * What it reads: one `commodities_prices` request by goods name (the very request `uex_get_prices` makes, so the answer is
 * shared with it through the cache), filtered locally to the exact goods and the exact terminals. At most
 * PREFLIGHT_MAX_REQUESTS requests, GET only, through the cached and guarded client: no new host, no write.
 *
 * What it never uses: the player's balance, and any quantity. Only unit prices come in (the plan's, UEX's) and only unit
 * prices, per-SCU margins and percentages go out, so a plan sized from the balance and a plan typed by hand give the same
 * shape and reveal nothing about the balance.
 *
 * What it cannot see, and says so: UEX prices are crowdsourced. A price that nobody re-reported since the plan was made
 * looks "unchanged" however much the kiosk's real price moved; that is why the age of the rows, their number of player
 * reports and the stock status are part of the verdict, and why the kiosk's own price always prevails.
 */

/** At most this many UEX requests per check. The check itself makes one; the bound is a guard, tested. */
export const PREFLIGHT_MAX_REQUESTS = 3;
/** The check stops at this point and answers "impossible de vérifier" (the View waits longer). */
export const PREFLIGHT_DEADLINE_MS = 15_000;

// -------------------------------------------------------------------------------------------------
// Thresholds. THEY ARE CHOICES, not measures: nobody knows how much a UEX price may move before a plan stops being worth
// the trip. They are named here, sent with every answer, and shown on the card as "seuils".
// -------------------------------------------------------------------------------------------------

/**
 * Share of the PLANNED per-SCU margin lost (sell price down, buy price up) from which a leg, or the whole margin, is
 * "à surveiller". 0.15 = the plan would earn 15 % less per SCU than planned.
 */
export const PREFLIGHT_WATCH_MARGIN_LOSS = 0.15;
/**
 * Share of the planned margin lost from which it is "dérivé". 0.30, or a margin that is no longer positive (the sign
 * changed): the plan would lose money or hardly earn any.
 */
export const PREFLIGHT_DRIFTED_MARGIN_LOSS = 0.3;
/**
 * A move IN THE PLAYER'S FAVOUR of at least this share of the planned margin is capped at "à surveiller", never "dérivé"
 * and never green: a price that jumps up is as likely a wrong report as a good surprise. It is the same number as the
 * level above, on purpose: a favourable move of that size is as unusual as the adverse one.
 */
export const PREFLIGHT_UNUSUAL_GAIN = PREFLIGHT_DRIFTED_MARGIN_LOSS;
/**
 * A row last reported more than this long ago is "périmé" (the planner's own default for dropping old prices is 7 days).
 * An undated row is stale too. Such a row cannot confirm anything: nobody has looked at that price since.
 */
export const PREFLIGHT_STALE_MS = 7 * 86_400_000;

export type PreflightVerdict = "valid" | "watch" | "drifted" | "unknown";

export type PreflightReason =
  "no_plan" | "plan_incomplete" | "commodity_not_found" | "upstream" | "stale_copy" | "no_prices";

export type PreflightLegProblem = "terminal_not_found" | "terminal_ambiguous" | "no_price";

export type PreflightWarning =
  "buy_out_of_stock" | "buy_shortage" | "sell_no_demand" | "sell_saturating" | "sell_strong_demand";

export type PreflightAction = "go" | "verify" | "search_again" | "retry";

export interface PreflightLeg {
  side: "buy" | "sell";
  /** The plan's terminal name (cleaned). */
  terminal: string;
  verdict: PreflightVerdict;
  /** Set when the leg could not be judged or the price is gone. */
  problem: PreflightLegProblem | null;
  plan_price: number;
  now_price: number | null;
  /** Signed: (now - plan) / plan, in percent, one decimal. */
  drift_pct: number | null;
  /** Share of the planned per-SCU margin this leg takes away (negative: it adds), in percent. */
  margin_effect_pct: number | null;
  /** Age of UEX's row (when a player last reported it), in hours; null: undated. */
  data_age_hours: number | null;
  stale: boolean;
  /** How many players reported this price; null: UEX did not say (never read as 0). */
  reports: number | null;
  /** True: UEX counts 0 player reports (its own estimate). null: not known. */
  estimate: boolean | null;
  stock_level: string | null;
  stock_fill: string | null;
  /** SCU available to buy (buy leg) or still wanted by the terminal (sell leg), as UEX shows it. */
  stock_scu: number | null;
  warnings: PreflightWarning[];
  /** The leg in words (French), added by the dashboard layer (dashboard/preflightText.ts); no name in them. */
  lines?: string[];
}

/** The answer in words, added by the dashboard layer: the page only displays it. */
export interface PreflightText {
  headline: string;
  /** The per-SCU margin, planned and now ("" when not known). */
  margin: string;
  /** The plain next action: tu peux partir / vérifie au terminal / relance la recherche. */
  action: string;
  notes: string[];
  /**
   * The text "Demander à l'agent" posts into the conversation: built from the verdict alone (names reduced to letters,
   * digits and a few signs, quoted and announced as data; unit prices and per-SCU margins, never a quantity or a total).
   */
  agent: string;
}

export interface PreflightMargin {
  plan_per_scu: number;
  now_per_scu: number | null;
  /** Signed, in percent of the planned margin; null when a price is missing. */
  drift_pct: number | null;
}

export interface PreflightPlanEcho {
  commodity: string;
  buy_terminal: string;
  sell_terminal: string;
  buy_price: number;
  sell_price: number;
}

export interface PreflightResult {
  v: 1;
  state: "preflight";
  verdict: PreflightVerdict;
  /** Why the verdict is "unknown" (absent otherwise). */
  reason?: PreflightReason;
  /** The plan the check was made for: the page compares it with the plan on its card. */
  plan: PreflightPlanEcho | null;
  legs: PreflightLeg[];
  margin: PreflightMargin | null;
  action: PreflightAction;
  /** How long ago this server read the UEX rows, in seconds (the cache keeps them up to 5 minutes). Null: not read. */
  read_age_s: number | null;
  /** UEX requests this check made (cache hits make none). */
  requests: number;
  /** Failure detail ("HTTP 503"), cleaned. */
  detail?: string;
  /** Served from the check's own short memory. */
  cached: boolean;
  age_s: number;
  thresholds: { watch_pct: number; drifted_pct: number; stale_days: number };
  text?: PreflightText;
}

/** What the check takes from the plan: unit prices and names. NEVER a quantity or a profit. */
export interface PreflightPlan {
  commodity?: string | undefined;
  buy_terminal?: string | undefined;
  sell_terminal?: string | undefined;
  buy_unit_price?: number | undefined;
  sell_unit_price?: number | undefined;
}

export interface PreflightDeps {
  client: HttpClient;
  now?: () => number;
  maxRequests?: number;
  deadlineMs?: number;
}

const RANK: Record<PreflightVerdict, number> = { valid: 0, watch: 1, unknown: 2, drifted: 3 };
const worst = (a: PreflightVerdict, b: PreflightVerdict): PreflightVerdict =>
  RANK[a] >= RANK[b] ? a : b;
const pct = (x: number): number => Math.round(x * 1000) / 10;
const THRESHOLDS = {
  watch_pct: PREFLIGHT_WATCH_MARGIN_LOSS * 100,
  drifted_pct: PREFLIGHT_DRIFTED_MARGIN_LOSS * 100,
  stale_days: PREFLIGHT_STALE_MS / 86_400_000,
};

const norm = (s: unknown): string =>
  (typeof s === "string" ? s : "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** The plan's identity, cleaned: the page compares it with the plan on its card. Null when something is missing. */
export function planIdentity(plan: PreflightPlan | undefined): PreflightPlanEcho | null {
  if (!plan) return null;
  const commodity = label(plan.commodity, 60);
  const buyT = label(plan.buy_terminal, 60);
  const sellT = label(plan.sell_terminal, 60);
  const buy = plan.buy_unit_price;
  const sell = plan.sell_unit_price;
  if (!commodity || !buyT || !sellT) return null;
  if (typeof buy !== "number" || !Number.isFinite(buy) || buy <= 0) return null;
  if (typeof sell !== "number" || !Number.isFinite(sell) || sell <= 0) return null;
  return { commodity, buy_terminal: buyT, sell_terminal: sellT, buy_price: buy, sell_price: sell };
}

/** An "unknown" answer, built without any UEX request. */
export function unknownPreflight(
  reason: PreflightReason,
  plan: PreflightPlanEcho | null,
  extra: { requests?: number; read_age_s?: number | null; detail?: string } = {},
): PreflightResult {
  return {
    v: 1,
    state: "preflight",
    verdict: "unknown",
    reason,
    plan,
    legs: [],
    margin: null,
    action: reason === "upstream" ? "retry" : "verify",
    read_age_s: extra.read_age_s ?? null,
    requests: extra.requests ?? 0,
    ...(extra.detail ? { detail: extra.detail } : {}),
    cached: false,
    age_s: 0,
    thresholds: THRESHOLDS,
  };
}

type Found = { kind: "row"; row: Row } | { kind: "none" } | { kind: "ambiguous" };

/**
 * The row of one terminal. The names must match exactly (case and spaces aside; a plan name that was cut with an ellipsis
 * matches by its start). Two terminals with that name are ambiguous: nothing is guessed. Several rows of ONE terminal (two
 * game versions) keep the most recently reported.
 */
export function findTerminalRow(rows: readonly Row[], wanted: string): Found {
  const cut = wanted.endsWith("…");
  const needle = norm(cut ? wanted.slice(0, -1) : wanted);
  if (!needle) return { kind: "none" };
  const hits = rows.filter((r) => {
    const name = norm(label(r.terminal_name, 80));
    return cut ? name.startsWith(needle) : name === needle;
  });
  if (hits.length === 0) return { kind: "none" };
  const ids = new Set(hits.map((r) => toNumber(r.id_terminal) ?? norm(r.terminal_name)));
  if (ids.size > 1) return { kind: "ambiguous" };
  const newest = [...hits].sort((a, b) => (rowTimestamp(b) ?? 0) - (rowTimestamp(a) ?? 0))[0];
  return newest ? { kind: "row", row: newest } : { kind: "none" };
}

const levelOf = (loss: number): PreflightVerdict =>
  loss >= PREFLIGHT_DRIFTED_MARGIN_LOSS
    ? "drifted"
    : loss >= PREFLIGHT_WATCH_MARGIN_LOSS
      ? "watch"
      : loss <= -PREFLIGHT_UNUSUAL_GAIN
        ? "watch"
        : "valid";

function judgeLeg(
  side: "buy" | "sell",
  row: Found,
  plan: PreflightPlanEcho,
  planMargin: number,
  now: number,
): PreflightLeg {
  const terminal = side === "buy" ? plan.buy_terminal : plan.sell_terminal;
  const planPrice = side === "buy" ? plan.buy_price : plan.sell_price;
  const blank: PreflightLeg = {
    side,
    terminal,
    verdict: "unknown",
    problem: row.kind === "ambiguous" ? "terminal_ambiguous" : "terminal_not_found",
    plan_price: planPrice,
    now_price: null,
    drift_pct: null,
    margin_effect_pct: null,
    data_age_hours: null,
    stale: false,
    reports: null,
    estimate: null,
    stock_level: null,
    stock_fill: null,
    stock_scu: null,
    warnings: [],
  };
  if (row.kind !== "row") return blank;
  const r = row.row;
  const field = side === "buy" ? "price_buy" : "price_sell";
  const price = toNumber(r[field]) ?? 0;
  const ts = rowTimestamp(r);
  const age = ageDays(ts, now);
  const stale = ts === null || now - ts > PREFLIGHT_STALE_MS;
  const usersRaw = r[side === "buy" ? "price_buy_users_rows" : "price_sell_users_rows"];
  const reports = toNumber(usersRaw) ?? null;
  const status = assessRow(r, BUILT_IN_LEGEND);
  const stock = side === "buy" ? status.buy : status.sell;
  const warnings = status.warnings
    .filter((w) => w.side === side)
    .map((w) => w.code as PreflightWarning);
  const criticalCondition = status.warnings.some(
    (w) => w.side === side && w.severity === "critical",
  );
  const warnCondition = status.warnings.some((w) => w.side === side && w.severity === "warning");
  const common = {
    data_age_hours: age === null ? null : Math.round(age * 24 * 10) / 10,
    stale,
    reports,
    estimate: reports === null ? null : reports === 0,
    stock_level: stock.level ? label(stock.level, 60) : null,
    stock_fill: stock.fill ? label(stock.fill, 12) : null,
    stock_scu: side === "buy" ? status.buy.scu_available : status.sell.demand_scu,
    warnings,
  };
  if (price <= 0) {
    // UEX no longer shows a price on this side at this terminal: nothing to rely on.
    return { ...blank, ...common, verdict: "drifted", problem: "no_price" };
  }
  // Adverse move: a buy price that rose, a sell price that fell, in aUEC per SCU.
  const adverse = side === "buy" ? price - planPrice : planPrice - price;
  const loss = adverse / planMargin;
  let verdict = levelOf(loss);
  if (criticalCondition) verdict = worst(verdict, "drifted");
  else if (warnCondition || stale) verdict = worst(verdict, "watch");
  return {
    side,
    terminal,
    verdict,
    problem: null,
    plan_price: planPrice,
    now_price: price,
    drift_pct: pct((price - planPrice) / planPrice),
    margin_effect_pct: pct(loss),
    ...common,
  };
}

/** The verdict from the rows already read. PURE: rows and a clock in, an answer out. */
export function judgePreflight(
  plan: PreflightPlanEcho,
  rows: readonly Row[],
  now: number,
): PreflightResult {
  const planMargin = plan.sell_price - plan.buy_price;
  if (!(planMargin > 0)) return unknownPreflight("plan_incomplete", plan);
  const buyRow = findTerminalRow(rows, plan.buy_terminal);
  const sellRow = findTerminalRow(rows, plan.sell_terminal);
  const legs = [
    judgeLeg("buy", buyRow, plan, planMargin, now),
    judgeLeg("sell", sellRow, plan, planMargin, now),
  ];
  const buyNow = legs[0]?.now_price ?? null;
  const sellNow = legs[1]?.now_price ?? null;
  let margin: PreflightMargin = { plan_per_scu: planMargin, now_per_scu: null, drift_pct: null };
  let verdict: PreflightVerdict = "valid";
  for (const l of legs) verdict = worst(verdict, l.verdict);
  if (buyNow !== null && sellNow !== null) {
    const nowMargin = sellNow - buyNow;
    const drift = (nowMargin - planMargin) / planMargin;
    margin = { plan_per_scu: planMargin, now_per_scu: nowMargin, drift_pct: pct(drift) };
    // A margin that is no longer positive is a changed sign: always "dérivé".
    verdict = worst(verdict, nowMargin <= 0 ? "drifted" : levelOf(-drift));
  }
  const action: PreflightAction =
    verdict === "valid" ? "go" : verdict === "drifted" ? "search_again" : "verify";
  return {
    v: 1,
    state: "preflight",
    verdict,
    plan,
    legs,
    margin,
    action,
    read_age_s: null,
    requests: 0,
    cached: false,
    age_s: 0,
    thresholds: THRESHOLDS,
  };
}

/** A client that refuses to go past `max` requests (a guard; the check makes one). */
function counting(client: HttpClient, max: number) {
  let count = 0;
  const wrapped = {
    defaults: client.defaults,
    get: ((url: string, config?: unknown) => {
      if (count >= max) throw new Error("pre-flight request budget used up");
      count++;
      return client.get(url, config as never);
    }) as HttpClient["get"],
  } as unknown as HttpClient;
  return { client: wrapped, count: () => count };
}

function failureDetail(error: unknown): string | undefined {
  const e = error as { response?: { status?: unknown }; code?: unknown } | null;
  const status = e?.response?.status;
  if (typeof status === "number") return `HTTP ${status}`;
  return label(typeof e?.code === "string" ? e.code : "", 40) ?? undefined;
}

/**
 * Reads the current UEX rows of the plan's goods and judges the plan. Never throws: every failure is an "unknown" answer
 * with its reason. A stale copy of the cache (served when UEX is down) is NEVER a verdict: it is the very case "UEX could
 * not be reached".
 */
export async function runPreflight(
  deps: PreflightDeps,
  plan: PreflightPlanEcho,
): Promise<PreflightResult> {
  const now = (deps.now ?? Date.now)();
  const guard = counting(deps.client, deps.maxRequests ?? PREFLIGHT_MAX_REQUESTS);
  let timer: NodeJS.Timeout | undefined;
  try {
    const fetched = await Promise.race([
      fetchWithCache(
        guard.client,
        "/commodities_prices",
        { params: { commodity_name: plan.commodity } },
        { record: false },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("deadline")),
          deps.deadlineMs ?? PREFLIGHT_DEADLINE_MS,
        );
      }),
    ]);
    const readAge = Math.max(0, Math.round((now - fetched.fetchedAt) / 1000));
    if (fetched.cache === "stale-disk") {
      return unknownPreflight("stale_copy", plan, {
        requests: guard.count(),
        read_age_s: readAge,
      });
    }
    const data = unwrapData(fetched.data);
    if (data.kind !== "rows")
      return unknownPreflight("no_prices", plan, { requests: guard.count(), read_age_s: readAge });
    // The goods must match exactly: UEX's own name filter is not trusted to.
    const wanted = norm(plan.commodity);
    const rows = data.rows.filter((r) => isRow(r) && norm(label(r.commodity_name, 80)) === wanted);
    if (rows.length === 0)
      return unknownPreflight("commodity_not_found", plan, {
        requests: guard.count(),
        read_age_s: readAge,
      });
    const judged = judgePreflight(plan, rows, now);
    return { ...judged, requests: guard.count(), read_age_s: readAge };
  } catch (error) {
    const detail = failureDetail(error);
    return unknownPreflight("upstream", plan, {
      requests: guard.count(),
      ...(detail ? { detail } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
