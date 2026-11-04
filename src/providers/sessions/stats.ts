import { isEmpty, isUntouched } from "./reducer.js";
import type { Session, ShipLossRecord, Trip } from "./types.js";

/**
 * Figures over stored sessions. PURE: sessions in, numbers out, no clock of its own.
 *
 * What is measured and what is estimated is said in the field names and in `basis`:
 *  - `net_auec` is the sum of the trips' results when at least one is known (`net_source: "trips"`), else the change of
 *    the balance over the session (`"balance"`). Both are raw measures: the balance also moves with purchases, fines
 *    and repairs, and a trip result taken from a balance change mixes them in. Neither is a tax-grade profit.
 *  - Rates (per hour) use ACTIVE time, the time the game was seen running, and only from MIN_RATE_ACTIVE_MS of it.
 *  - Nothing is guessed: a figure that cannot be worked out is `null`.
 *
 * Every aUEC figure lives under `money` so that one function (`withoutMoney`) can take them all out.
 */

export const MIN_RATE_ACTIVE_MS = 10 * 60_000;
export const TREND_THRESHOLD = 0.1;

const ms = (s: string | null): number => (s === null ? NaN : Date.parse(s));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const known = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);
const round = (n: number) => Math.round(n);
const perHour = (amount: number, activeMs: number): number | null =>
  activeMs >= MIN_RATE_ACTIVE_MS ? round(amount / (activeMs / 3_600_000)) : null;

export interface SessionMoney {
  start_balance_auec: number | null;
  start_balance_quality: Session["start_balance_quality"];
  /** The balance at the last sighting (for an ended session: at its end). */
  last_balance_auec: number | null;
  balance_change_auec: number | null;
  /**
   * The result of the session on ONE basis: the sum of each trip's result (its net when the model measured or computed
   * one, else the gross margin of the cargo run), else the change of the balance. The two parts are given apart below.
   */
  net_auec: number | null;
  net_source: "trips" | "balance" | null;
  /** True when every trip has a result; null when there is no trip. */
  net_complete: boolean | null;
  /** The part of the trips' result that was MEASURED or computed as a net (balance change, or margin minus fees). */
  measured_net_auec: number | null;
  /** How many trips count with their gross margin only (no net). Fees are not in a gross margin. */
  gross_only_trips: number;
  /** Contracts whose balance change was left out because it overlapped a trade run (counted once, in the run). */
  overlap_excluded: number;
  turnover_auec: number | null;
  cost_auec: number | null;
  fees_auec: number | null;
  net_per_hour_auec: number | null;
  avg_trip_net_auec: number | null;
  /** `gross` is true when the figure is a cargo run's gross margin, not a measured balance change. */
  best_trip: {
    label: string | null;
    commodity: string | null;
    net_auec: number;
    gross: boolean;
  } | null;
  /** Sum of the gross margins of the cargo runs (revenue - cost, no fees): null when there is none. */
  gross_margin_auec: number | null;
  /**
   * aUEC PAID for the cargo presumed lost with destroyed ships (the purchase price, not the value; unconfirmed). From the
   * balance's side: withheld with the rest of `money`. null when no loss carried cargo.
   */
  lost_cargo_paid_auec: number | null;
  plan: {
    planned_auec: number;
    measured_auec: number;
    /**
     * Measured result (net, else gross margin) over the planned profit AS PLANNED (not rescaled to the quantity moved: the
     * route calibration, calibration.ts, compares the gross margin with a plan rescaled to the quantity, so the two figures
     * can differ on purpose). A trip whose net the commerce model flagged doubtful (the balance held a reward, a purchase
     * made elsewhere: not the run's own) is not compared with its plan, as the calibration leaves it out of the net ratio.
     */
    efficiency: number | null;
    trips: number;
    /**
     * How many of those trips had their plan tied to them by PRICE resemblance, not by the goods' name (the game log never
     * names goods): their goods were not verified.
     */
    price_linked_trips: number;
  } | null;
}

export interface SessionSummary {
  id: string;
  number: number;
  status: "open" | "ended";
  end_reason: Session["end_reason"];
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  /**
   * True for an OPEN session that holds nothing yet: a chronometer the player started (no trip, loss, refused price or note,
   * under 2 minutes played, whatever its start balance), or one the game never filled. Restarting it or ending it loses
   * nothing (the end deletes it), so the dashboard asks no question for a short one.
   */
  empty: boolean;
  /**
   * When the game wrote its quit line during this OPEN session (it resumes if the game comes back within the gap); null
   * once it was seen again, when it is ended, or when the game wrote no quit line.
   */
  game_closed_at: string | null;
  /** From the start to the end (or the last sighting). Includes interruptions. */
  duration_ms: number;
  /** The time the game was seen running. Rates use this one. */
  active_ms: number;
  interruptions: number;
  game_version: string | null;
  game_channel: Session["game_channel"];
  /** Hauling and trade trips. */
  trips: number;
  /** Other contracts that were completed. */
  contracts: number;
  trips_with_net: number;
  trips_dropped: number;
  trips_per_hour: number | null;
  /** ESTIMATE: active time divided by trips. */
  minutes_per_trip: number | null;
  last_location: string | null;
  last_commodity: string | null;
  /** Transactions the game refused because the price moved (a count: no amount, so it is not under `money`). */
  price_refusals: number;
  /**
   * The player's ships destroyed with him aboard, oldest first. Time, model, cause, kind of causer, place token and the SCU
   * presumed lost: no amount (the aUEC paid is `money.lost_cargo_paid_auec`) and no identifier of any kind.
   */
  ship_losses: ShipLossSummary[];
  /** How many ships were lost in all (a View lists only the newest few). */
  ship_losses_count: number;
  note: string;
  money: SessionMoney;
}

export interface ShipLossSummary {
  at: string;
  ship_class: string | null;
  cause: ShipLossRecord["cause"];
  causer: ShipLossRecord["causer"];
  zone: string | null;
  /** null: the trade journal was not readable when it was recorded (unknown, never zero). */
  cargo_scu: number | null;
}

const isTrip = (t: Trip) => t.kind !== "contract";
/** The result of one trip: the net the model measured or computed, else the gross margin of the cargo run. */
export const tripResult = (t: Trip): number | null => t.net_auec ?? t.gross_margin_auec;

const span = (t: Trip): [number, number] => {
  const end = ms(t.ended_at);
  const begin = ms(t.started_at);
  return [Number.isFinite(begin) ? begin : end, end];
};

/**
 * The ONE basis of a session's result: each trip's `tripResult`, except a contract's balance change that overlapped a
 * trade run (it holds that run's sales: counting both would count them twice). That contract's result is unknown and it
 * is flagged `excluded`. Computed when read, so a run that closes after the contract was stored still excludes it.
 */
export function effectiveResults(
  trips: readonly Trip[],
): { trip: Trip; result: number | null; excluded: boolean; duplicate: boolean }[] {
  const runs = trips.filter((t) => t.kind === "trade").map(span);
  // Two trade trips that begin at the same instant with the same goods are one run stored twice (an older file, or a
  // run that grew under another key): only the latest-ending one counts.
  const last = new Map<string, Trip>();
  for (const t of trips) {
    if (t.kind !== "trade") continue;
    const k = `${t.started_at ?? ""}|${t.commodity ?? ""}`;
    const seen = last.get(k);
    if (!seen || ms(t.ended_at) >= ms(seen.ended_at)) last.set(k, t);
  }
  return trips.map((trip) => {
    const [b, e] = span(trip);
    const duplicate =
      trip.kind === "trade" &&
      last.get(`${trip.started_at ?? ""}|${trip.commodity ?? ""}`) !== trip;
    const excluded =
      duplicate ||
      (trip.kind !== "trade" &&
        trip.net_auec !== null &&
        runs.some(([rb, re]) => rb < e && re > b));
    return { trip, result: excluded ? null : tripResult(trip), excluded, duplicate };
  });
}

export function summarizeSession(s: Session): SessionSummary {
  const end = Math.max(ms(s.ended_at) || 0, ms(s.last_activity_at));
  const eff = effectiveResults(s.trips);
  // A run stored twice (an older file) is ONE trip in every count and every sum: only the latest-ending copy counts.
  const counted = eff.filter((e) => !e.duplicate).map((e) => e.trip);
  const trips = counted.filter(isTrip);
  const withResult = eff.filter((e) => e.result !== null);
  const netTrips = withResult.length > 0 ? sum(withResult.map((e) => e.result as number)) : null;
  const measuredNets = known(eff.map((e) => (e.excluded ? null : e.trip.net_auec)));
  const change =
    s.start_balance !== null && s.last_balance !== null ? s.last_balance - s.start_balance : null;
  const net = netTrips ?? change;
  const revenue = known(counted.map((t) => t.revenue_auec));
  const cost = known(counted.map((t) => t.cost_auec));
  const fees = known(counted.map((t) => t.fees_auec));
  const best = withResult.reduce<(typeof withResult)[number] | null>(
    (b, e) => (b === null || (e.result as number) > (b.result as number) ? e : b),
    null,
  );
  const grossRuns = known(counted.map((t) => t.gross_margin_auec));
  const planned = withResult.filter(
    (e) => e.trip.planned_profit_auec !== null && e.trip.net_doubtful !== true,
  );
  const plannedSum = sum(known(planned.map((e) => e.trip.planned_profit_auec)));
  const measuredSum = sum(planned.map((e) => e.result as number));
  return {
    id: s.id,
    number: s.number,
    status: s.ended_at === null ? "open" : "ended",
    end_reason: s.end_reason,
    started_at: s.started_at,
    ended_at: s.ended_at,
    last_activity_at: s.last_activity_at,
    empty: s.ended_at === null && (isEmpty(s) || isUntouched(s)),
    // The quit line counts only while nothing was seen after it (a game back within the resume gap keeps the old line).
    game_closed_at:
      s.ended_at === null && s.quit_at !== null && ms(s.quit_at) >= ms(s.last_activity_at) - 5000
        ? s.quit_at
        : null,
    duration_ms: Math.max(0, end - ms(s.started_at)),
    active_ms: s.active_ms,
    interruptions: s.interruptions.length,
    game_version: s.game_version,
    game_channel: s.game_channel,
    trips: trips.length,
    contracts: counted.length - trips.length,
    trips_with_net: withResult.length,
    trips_dropped: s.trips_dropped,
    trips_per_hour:
      trips.length > 0 && s.active_ms >= MIN_RATE_ACTIVE_MS
        ? Math.round((trips.length / (s.active_ms / 3_600_000)) * 10) / 10
        : null,
    minutes_per_trip:
      trips.length > 0 && s.active_ms >= MIN_RATE_ACTIVE_MS
        ? Math.round((s.active_ms / trips.length / 60_000) * 10) / 10
        : null,
    last_location: s.last_location,
    last_commodity: s.last_commodity,
    price_refusals: s.price_refusals ?? 0,
    // Copied by name: the paid amount stays out of the part every reader gets.
    ship_losses: (s.ship_losses ?? []).map((l) => ({
      at: l.at,
      ship_class: l.ship_class,
      cause: l.cause,
      causer: l.causer,
      zone: l.zone,
      cargo_scu: l.cargo_scu,
    })),
    ship_losses_count: (s.ship_losses ?? []).length,
    note: s.note,
    money: {
      lost_cargo_paid_auec: (() => {
        const paid = known((s.ship_losses ?? []).map((l) => l.cargo_paid_auec));
        return paid.length > 0 && paid.some((x) => x > 0) ? sum(paid) : null;
      })(),
      start_balance_auec: s.start_balance,
      start_balance_quality: s.start_balance_quality,
      last_balance_auec: s.last_balance,
      balance_change_auec: change,
      net_auec: net,
      net_source: netTrips !== null ? "trips" : change !== null ? "balance" : null,
      net_complete: counted.length === 0 ? null : withResult.length === counted.length,
      measured_net_auec: measuredNets.length > 0 ? sum(measuredNets) : null,
      gross_only_trips: withResult.filter((e) => e.trip.net_auec === null).length,
      // A copy of a run stored twice is not a contract and does not make the total partial: only overlaps count.
      overlap_excluded: eff.filter((e) => e.excluded && !e.duplicate).length,
      turnover_auec: revenue.length > 0 ? sum(revenue) : null,
      cost_auec: cost.length > 0 ? sum(cost) : null,
      fees_auec: fees.length > 0 ? sum(fees) : null,
      net_per_hour_auec: net !== null ? perHour(net, s.active_ms) : null,
      gross_margin_auec: grossRuns.length > 0 ? sum(grossRuns) : null,
      avg_trip_net_auec: netTrips !== null ? round(netTrips / withResult.length) : null,
      best_trip: best
        ? {
            label: best.trip.label,
            commodity: best.trip.commodity,
            net_auec: best.result as number,
            gross: best.trip.net_auec === null,
          }
        : null,
      plan:
        planned.length > 0
          ? {
              planned_auec: plannedSum,
              measured_auec: measuredSum,
              efficiency:
                plannedSum > 0 ? Math.round((measuredSum / plannedSum) * 1000) / 1000 : null,
              trips: planned.length,
              price_linked_trips: planned.filter((e) => e.trip.plan_link === "prices").length,
            }
          : null,
    },
  };
}

/** The summary without any aUEC figure: the form every output takes unless the balance was asked for. */
export function withoutMoney<T extends { money: unknown }>(
  summary: T,
): Omit<T, "money"> & { money: "withheld" } {
  return { ...summary, money: "withheld" };
}

// -------------------------------------------------------------------------------------------------
// Across sessions
// -------------------------------------------------------------------------------------------------

export interface RouteStat {
  commodity: string;
  buy_terminal: string | null;
  sell_terminal: string | null;
  trips: number;
  /** Trips of this route whose plan was tied to them by price resemblance (goods not verified). */
  price_linked_trips: number;
  avg_net_auec: number;
  total_net_auec: number;
}

export interface AggregateMoney {
  sessions_with_net: number;
  net_auec: number | null;
  turnover_auec: number | null;
  /** Total net divided by the total active time of the sessions that have both. */
  avg_net_per_hour_auec: number | null;
  avg_net_per_session_auec: number | null;
  best_session: { number: number; net_per_hour_auec: number; net_auec: number | null } | null;
  worst_session: { number: number; net_per_hour_auec: number; net_auec: number | null } | null;
  trend: {
    direction: "up" | "down" | "flat";
    recent_per_hour_auec: number;
    previous_per_hour_auec: number;
    sessions_each: number;
  } | null;
  plan: { efficiency: number | null; trips: number; price_linked_trips: number } | null;
  per_session: {
    number: number;
    net_auec: number | null;
    net_per_hour_auec: number | null;
  }[];
  best_routes: RouteStat[];
  best_commodities: {
    commodity: string;
    trips: number;
    /** Trips of this goods whose plan was tied to them by price resemblance (goods not verified). */
    price_linked_trips: number;
    avg_net_auec: number;
    total_net_auec: number;
  }[];
}

export interface AggregateStats {
  sessions: number;
  empty_sessions_ignored: number;
  from: string | null;
  to: string | null;
  trips: number;
  contracts: number;
  active_ms: number;
  trips_per_hour: number | null;
  /** Transactions the game refused because the price moved, over these sessions (a count: no amount). */
  price_refusals: number;
  per_session: {
    number: number;
    started_at: string;
    trips: number;
    active_ms: number;
    price_refusals: number;
  }[];
  money: AggregateMoney;
  basis: string;
}

const BASIS =
  "Raw measures from the player's balance and the game log (purchases and fines are mixed in); rates use the time the game was seen running; a figure that cannot be worked out is null.";

export function aggregate(
  sessions: readonly Session[],
  opts: { last?: number } = {},
): AggregateStats {
  const used = sessions.filter(
    (s) => s.trips.length > 0 || s.active_ms > 0 || s.start_balance !== null,
  );
  const picked = opts.last ? used.slice(-opts.last) : used;
  const sums = picked.map(summarizeSession);
  const allEff = picked.flatMap((s) => effectiveResults(s.trips));
  // Each run once, even when an older file stored it twice (the same rule as summarizeSession).
  const allTrips = allEff.filter((e) => !e.duplicate).map((e) => e.trip);
  const tripsOnly = allTrips.filter(isTrip);
  const active = sum(sums.map((s) => s.active_ms));

  const withNet = sums.filter((s) => s.money.net_auec !== null);
  const rated = sums.filter((s) => s.money.net_per_hour_auec !== null);
  const netTotal = withNet.length > 0 ? sum(withNet.map((s) => s.money.net_auec as number)) : null;
  const activeRated = sum(
    withNet.filter((s) => s.active_ms >= MIN_RATE_ACTIVE_MS).map((s) => s.active_ms),
  );
  const netRated = sum(
    withNet.filter((s) => s.active_ms >= MIN_RATE_ACTIVE_MS).map((s) => s.money.net_auec as number),
  );
  const rev = known(allEff.filter((e) => !e.duplicate).map((e) => e.trip.revenue_auec));

  const byRate = [...rated].sort(
    (a, b) => (b.money.net_per_hour_auec as number) - (a.money.net_per_hour_auec as number),
  );
  const pick = (s: SessionSummary | undefined) =>
    s
      ? {
          number: s.number,
          net_per_hour_auec: s.money.net_per_hour_auec as number,
          net_auec: s.money.net_auec,
        }
      : null;

  // Trend: the last k rated sessions against the k before them (k up to 3), 10 percent as the threshold.
  let trend: AggregateMoney["trend"] = null;
  if (rated.length >= 4) {
    const k = Math.min(3, Math.floor(rated.length / 2));
    const rates = rated.map((s) => s.money.net_per_hour_auec as number);
    const recent = sum(rates.slice(-k)) / k;
    const previous = sum(rates.slice(-2 * k, -k)) / k;
    const ratio = previous !== 0 ? (recent - previous) / Math.abs(previous) : recent === 0 ? 0 : 1;
    trend = {
      direction: ratio > TREND_THRESHOLD ? "up" : ratio < -TREND_THRESHOLD ? "down" : "flat",
      recent_per_hour_auec: round(recent),
      previous_per_hour_auec: round(previous),
      sessions_each: k,
    };
  }

  const planned = allEff.filter(
    (e) => e.trip.planned_profit_auec !== null && e.result !== null && e.trip.net_doubtful !== true,
  );
  const plannedSum = sum(known(planned.map((e) => e.trip.planned_profit_auec)));

  const routes = new Map<string, { t: Trip[] }>();
  const goods = new Map<string, Trip[]>();
  const resultOf = new Map<Trip, number | null>(allEff.map((e) => [e.trip, e.result]));
  for (const { trip: t, result } of allEff) {
    if (result === null || t.commodity === null) continue;
    const key = [t.commodity, t.buy_terminal ?? "", t.sell_terminal ?? ""].join("\u0001");
    if (t.buy_terminal !== null || t.sell_terminal !== null) {
      const r = routes.get(key) ?? { t: [] };
      r.t.push(t);
      routes.set(key, r);
    }
    const g = goods.get(t.commodity) ?? [];
    g.push(t);
    goods.set(t.commodity, g);
  }
  const stat = (list: Trip[]) => {
    const total = sum(known(list.map((t) => resultOf.get(t) ?? null)));
    return {
      trips: list.length,
      price_linked_trips: list.filter((t) => t.plan_link === "prices").length,
      total_net_auec: total,
      avg_net_auec: round(total / list.length),
    };
  };
  const best_routes: RouteStat[] = [...routes.values()]
    .map(({ t }) => ({
      commodity: t[0].commodity as string,
      buy_terminal: t[0].buy_terminal,
      sell_terminal: t[0].sell_terminal,
      ...stat(t),
    }))
    .sort((a, b) => b.avg_net_auec - a.avg_net_auec || b.trips - a.trips)
    .slice(0, 5);
  const best_commodities = [...goods.entries()]
    .map(([commodity, t]) => ({ commodity, ...stat(t) }))
    .sort((a, b) => b.avg_net_auec - a.avg_net_auec || b.trips - a.trips)
    .slice(0, 5);

  return {
    sessions: picked.length,
    empty_sessions_ignored: sessions.length - used.length,
    from: picked.length > 0 ? picked[0].started_at : null,
    to: picked.length > 0 ? picked[picked.length - 1].last_activity_at : null,
    trips: tripsOnly.length,
    contracts: allTrips.length - tripsOnly.length,
    active_ms: active,
    trips_per_hour:
      tripsOnly.length > 0 && active >= MIN_RATE_ACTIVE_MS
        ? Math.round((tripsOnly.length / (active / 3_600_000)) * 10) / 10
        : null,
    price_refusals: sum(sums.map((s) => s.price_refusals)),
    per_session: sums.slice(-12).map((s) => ({
      number: s.number,
      started_at: s.started_at,
      trips: s.trips,
      active_ms: s.active_ms,
      price_refusals: s.price_refusals,
    })),
    money: {
      sessions_with_net: withNet.length,
      net_auec: netTotal,
      turnover_auec: rev.length > 0 ? sum(rev) : null,
      avg_net_per_hour_auec:
        activeRated >= MIN_RATE_ACTIVE_MS ? round(netRated / (activeRated / 3_600_000)) : null,
      avg_net_per_session_auec: netTotal !== null ? round(netTotal / withNet.length) : null,
      best_session: rated.length >= 2 ? pick(byRate[0]) : null,
      worst_session: rated.length >= 2 ? pick(byRate[byRate.length - 1]) : null,
      trend,
      plan:
        planned.length > 0
          ? {
              efficiency:
                plannedSum > 0
                  ? Math.round((sum(planned.map((e) => e.result as number)) / plannedSum) * 1000) /
                    1000
                  : null,
              trips: planned.length,
              price_linked_trips: planned.filter((e) => e.trip.plan_link === "prices").length,
            }
          : null,
      per_session: sums.slice(-12).map((s) => ({
        number: s.number,
        net_auec: s.money.net_auec,
        net_per_hour_auec: s.money.net_per_hour_auec,
      })),
      best_routes,
      best_commodities,
    },
    basis: BASIS,
  };
}

export function aggregateWithoutMoney(
  a: AggregateStats,
): Omit<AggregateStats, "money"> & { money: "withheld" } {
  return { ...a, money: "withheld" };
}
