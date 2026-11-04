/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): made-up answers of `sc_trade_suggest`, in the exact shape
 * the server builds (dashboard/tradeSuggest.ts). Invented figures: not UEX data, not a real market.
 */
import type { LegMarket } from "../../providers/uex/legMarket.js";
import type { LegView, TripOption } from "../../providers/uex/tripPlanner.js";
import { assessReliability, markBetterChecked } from "../routeReliability.js";
import type { SuggestLeg, SuggestOption } from "../tradeSuggest.js";
import { preflightAnswer, type PreflightVariant } from "./preflightFixtures.js";

type Rep = "reported" | "estimate" | "unverified";

/** What a made-up leg knows beyond the card's fields: the market facts the reliability block reads. */
const MARKET = new WeakMap<SuggestLeg, Partial<LegMarket>>();
const BODIES = new WeakMap<SuggestLeg, { from: string; to: string }>();

function leg(
  commodity: string,
  from: string,
  to: string,
  buy: number,
  sell: number,
  scu: number,
  opts: {
    age?: number;
    rep?: Rep;
    arm?: boolean | null;
    limited?: SuggestLeg["limited_by"];
    market?: Partial<LegMarket>;
    bodies?: { from: string; to: string };
  } = {},
): SuggestLeg {
  const made = legBase(commodity, from, to, buy, sell, scu, opts);
  if (opts.market) MARKET.set(made, opts.market);
  if (opts.bodies) BODIES.set(made, opts.bodies);
  return made;
}

/** The reliability block the server would build for these made-up legs (same code, made-up facts). */
function reliabilityOf(
  mode: SuggestOption["mode"],
  legs: SuggestLeg[],
  minutes: number | null,
  priv = false,
) {
  const place = (terminal: string, body: string | null) => ({
    terminal,
    terminal_id: 1,
    system: "Stanton",
    planet: body,
    body,
    kind: null,
    armistice_zone: null,
    jurisdiction: null,
  });
  const views = legs.map((l, i): LegView => {
    const reports = l.report_status === "reported" ? 3 : l.report_status === "estimate" ? 0 : null;
    const bodies = BODIES.get(l);
    const extra = MARKET.get(l) ?? {};
    return {
      commodity: l.commodity,
      from: place(l.from, bodies?.from ?? `Corps ${i * 2 + 1}`),
      to: place(l.to, bodies?.to ?? `Corps ${i * 2 + 2}`),
      buy_price: l.buy_price,
      sell_price: l.sell_price,
      profit_per_scu: l.profit_per_scu,
      scu: l.scu,
      limited_by: l.limited_by === "hidden" ? "budget" : l.limited_by,
      cost: l.buy_price * l.scu,
      profit_for_leg: l.profit_per_scu * l.scu,
      destination_demand_scu: null,
      price_updated: { buy: null, sell: null },
      price_age_days: { buy: l.age_days, sell: l.age_days },
      stale: false,
      report_status: l.report_status,
      reports: { origin: reports, destination: reports },
      is_estimate: null,
      estimated_sides: [],
      market: {
        buy_range: null,
        sell_range: null,
        stock_scu: null,
        sell_inventory: null,
        sell_peers: null,
        commodity_reports: null,
        ...extra,
      },
    };
  });
  const o = {
    mode,
    legs: views,
    trip: {
      flights_gm: mode === "two_leg" ? [10, 10] : [10, 10],
      cycle_seconds: minutes === null ? null : minutes * 60,
    },
  } as unknown as TripOption;
  return assessReliability(o, {
    speedKnown: minutes !== null,
    stopMinutes: 8,
    localHopMinutes: 2,
    private: priv,
  });
}

function legBase(
  commodity: string,
  from: string,
  to: string,
  buy: number,
  sell: number,
  scu: number,
  opts: { age?: number; rep?: Rep; arm?: boolean | null; limited?: SuggestLeg["limited_by"] },
): SuggestLeg {
  return {
    commodity,
    from,
    to,
    system: "Stanton",
    buy_price: buy,
    sell_price: sell,
    profit_per_scu: sell - buy,
    scu,
    limited_by: opts.limited ?? "cargo",
    age_days: opts.age ?? 1.4,
    report_status: opts.rep ?? "estimate",
    armistice: { from: opts.arm ?? true, to: opts.arm ?? true },
  };
}

function option(
  id: string,
  mode: SuggestOption["mode"],
  legs: SuggestLeg[],
  minutes: number | null,
  points: number,
  priv: boolean,
  extra: Partial<SuggestOption> = {},
): SuggestOption {
  const trip = legs.reduce((s, l) => s + l.profit_per_scu * l.scu, 0);
  const scu = legs.reduce((s, l) => s + l.scu, 0);
  const names = [legs[0]!.from, ...legs.map((l) => l.to)];
  if (mode === "one_way") names.push(legs[0]!.from);
  const rep: Rep = legs.some((l) => l.report_status === "estimate")
    ? "estimate"
    : legs.some((l) => l.report_status === "unverified")
      ? "unverified"
      : "reported";
  const ages = legs.map((l) => l.age_days ?? 0);
  return {
    id,
    mode,
    route: names.join(" → "),
    legs,
    profit_per_trip: trip,
    profit_per_scu: Math.round((trip / scu) * 10) / 10,
    scu_moved: scu,
    profit_per_hour: minutes === null ? null : Math.round((trip / minutes) * 60),
    cycle_minutes: minutes,
    report_status: rep,
    estimate: rep === "estimate",
    stale: Math.max(...ages) > 7,
    oldest_age_days: Math.max(...ages),
    safety: {
      heuristic: true,
      exposure: points <= 1 ? "lower" : points <= 3 ? "medium" : "higher",
      points,
      factors:
        points === 0
          ? []
          : points === 1
            ? ["a surface outpost stop (+1)"]
            : [
                "a stop outside an armistice zone according to UEX (station) (+1)",
                "a surface outpost stop (+1)",
              ],
    },
    ...(priv ? {} : { cost: legs[0]!.buy_price * legs[0]!.scu }),
    reliability: reliabilityOf(mode, legs, minutes, priv),
    ...extra,
  };
}

export type SuggestVariant = "ok" | "empty" | "wait" | "error" | "nospeed" | "reported" | "mixed";

/** Candidates in the order of the profit-per-hour objective; the objective re-orders them as the planner would. */
function candidates(priv: boolean, speed: boolean, mixed = false): SuggestOption[] {
  const m = (v: number | null) => (speed ? v : null);
  return [
    option(
      "000000000000000000000000000000a0",
      "round_trip",
      [
        leg("Laranite", "Port Tressler", "Area18 TDD", 189, 457, 696, {
          arm: false,
          age: 0.6,
          limited: "stock",
          market: {
            sell_range: { low: 380, high: 457 },
            sell_peers: { same_price: 6, priced: 8 },
          },
        }),
        leg("Medical Supplies", "Area18 TDD", "Port Tressler", 1180, 1412, 120, {
          arm: false,
          age: 0.6,
          market: { sell_inventory: { code: 6, fill: "72-85%" } },
        }),
      ],
      m(46),
      3,
      priv,
    ),
    option(
      "000000000000000000000000000000a1",
      "one_way",
      [
        leg("Agricium", "Lorville CBD", "Area18 TDD", 2410, 2790, 400, {
          age: 1.1,
          rep: mixed ? "reported" : "estimate",
        }),
      ],
      m(38),
      0,
      priv,
    ),
    option(
      "000000000000000000000000000000a2",
      "round_trip",
      [
        leg("Gold", "Everus Harbor", "Seraphim Station", 5870, 6210, 300, {
          age: 2.3,
          rep: mixed ? "reported" : "estimate",
        }),
        leg("Processed Food", "Seraphim Station", "Everus Harbor", 1410, 1520, 300, { age: 2.3 }),
      ],
      m(29),
      0,
      priv,
    ),
    option(
      "000000000000000000000000000000a3",
      "one_way",
      [leg("Quartz", "Magnus Gateway", "Area18 TDD", 1480, 1599, 500, { age: 5.2 })],
      m(52),
      1,
      priv,
    ),
    option(
      "000000000000000000000000000000a4",
      "round_trip",
      [
        leg("Scrap", "Everus Harbor", "Port Tressler", 1485, 1623, 640, { age: 8.4 }),
        leg("Waste", "Port Tressler", "Everus Harbor", 290, 330, 200, { age: 8.4 }),
      ],
      m(61),
      2,
      priv,
    ),
  ];
}

function chains(priv: boolean, speed: boolean): SuggestOption[] {
  const m = (v: number | null) => (speed ? v : null);
  return [
    option(
      "000000000000000000000000000000c0",
      "two_leg",
      [
        leg("Laranite", "Port Tressler", "Area18 TDD", 189, 457, 696, { arm: false, age: 0.6 }),
        leg("Agricium", "Area18 TDD", "Lorville CBD", 2410, 2735, 400, { age: 1.1 }),
      ],
      m(57),
      3,
      priv,
    ),
  ];
}

const KEY: Record<string, (o: SuggestOption) => number> = {
  profit_per_hour: (o) => -(o.profit_per_hour ?? o.profit_per_trip / 1000),
  profit: (o) => -o.profit_per_trip,
  speed: (o) => o.cycle_minutes ?? 9999,
  safety: (o) => o.safety.points * 1e9 - (o.profit_per_hour ?? o.profit_per_trip),
};

/** Whether the last search was made with a budget that is the balance (the real server remembers it per plan). */
let lastSearchPrivate = false;

export interface SuggestFixtureOptions {
  variant?: SuggestVariant;
  /** Which tool answer id prefix to use (so two answers do not share ids). */
  batch?: string;
  /** What the pre-flight check answers (default: the plan still holds). */
  preflight?: PreflightVariant;
}

/** The structured answer of sc_trade_suggest for the given arguments. */
export function suggestAnswer(
  args: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  options: SuggestFixtureOptions = {},
): Record<string, unknown> {
  const variant = options.variant ?? "ok";
  if (args["action"] === "preflight") return preflightAnswer(options.preflight ?? "valid");
  if (args["action"] === "apply") {
    // The plan of the option with that id, as the server builds it: the outbound leg.
    const found = [...candidates(false, true), ...chains(false, true)].find(
      (o) => o.id === args["id"],
    );
    const first = found?.legs[0];
    if (!found || !first) return { v: 1, state: "error", code: "expired" };
    return {
      v: 1,
      state: "applied",
      private: lastSearchPrivate,
      plan: {
        commodity: first.commodity,
        buy_terminal: first.from,
        sell_terminal: first.to,
        scu: first.scu,
        expected_profit_auec: first.profit_per_scu * first.scu,
        buy_unit_price: first.buy_price,
        sell_unit_price: first.sell_price,
        ...(found.cycle_minutes !== null ? { est_trip_minutes: found.cycle_minutes } : {}),
        safety_note: `Heuristique : ${found.safety.points} facteur(s) de risque`,
        note: found.legs[1]
          ? `Retour : ${found.legs[1].commodity}`
          : "Cycle complet : retour à vide",
      },
    };
  }
  if (variant === "wait") return { v: 1, state: "throttled", retry_after_s: 6 };
  if (variant === "error") return { v: 1, state: "error", code: "upstream", detail: "HTTP 503" };
  const priv = args["budget_private"] === true;
  lastSearchPrivate = priv;
  const speed = variant !== "nospeed";
  let list = candidates(priv, speed, variant === "mixed");
  let chainList = args["round_trip_only"] ? [] : chains(priv, speed);
  if (args["avoid_pyro"] || args["armistice_only"]) list = list.filter((o) => o.safety.points <= 2);
  if (args["armistice_only"]) list = list.filter((o) => o.safety.points === 0);
  if (args["min_reports"]) {
    // Almost nothing has a player report today.
    list = variant === "reported" ? list.slice(0, 1) : [];
    chainList = [];
  }
  if (variant === "empty") {
    list = [];
    chainList = [];
  }
  const key = KEY[String(args["objective"] ?? "profit_per_hour")] ?? KEY["profit_per_hour"]!;
  list.sort((a, b) => key(a) - key(b));
  markBetterChecked(list);
  const all = [...list, ...chainList];
  const counts = { reported: 0, estimate: 0, unverified: 0 };
  for (const o of all) counts[o.report_status]++;
  return {
    v: 1,
    state: "ok",
    objective: args["objective"] ?? "profit_per_hour",
    options: list,
    chains: chainList,
    counts,
    cargo_scu: typeof args["cargo_scu"] === "number" ? args["cargo_scu"] : 696,
    // The page sends the hold only when the player typed one; the server's ship has 696 SCU in this made-up world.
    cargo_source:
      typeof args["cargo_scu"] === "number" && args["cargo_scu"] !== 696 ? "saisie" : "fiche",
    private: priv,
    ship: "Hull C",
    speed_known: speed,
    stop_minutes: 8,
    partial: false,
    reports_incomplete: false,
    armistice_degraded: false,
    notes: [],
    cached: false,
    age_s: 0,
  };
}
