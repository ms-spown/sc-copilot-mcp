/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): made-up saved sessions for the session bar. Shapes are
 * those of providers/sessions/stats.ts (SessionSummary, AggregateStats) and of the session tools' answers. No real
 * balance, no Node-only module: the browser imports it.
 *
 * Money follows the dashboard's rule: a fixture built with `includeBalance` false carries `money: "withheld"`.
 */

export type SessionVariant =
  | "story"
  | "empty"
  | "off"
  | "stale"
  | "ended"
  | "waiting"
  | "readonly"
  | "gross"
  | "losses"
  | "manylosses";

const HOUR = 3_600_000;
const MIN = 60_000;

interface Fixture {
  number: number;
  startedAgoMs: number;
  activeMs: number;
  trips: number;
  contracts?: number;
  net: number | null;
  start: number | null;
  last: number | null;
  status?: "open" | "ended";
  interruptions?: number;
  gross?: number | null;
  quality?: string;
  /** Ships destroyed with the player aboard during the session (invented: a model, a cause, the SCU presumed lost). */
  shipLosses?: number;
  /** How long ago the game was last seen in an open session (default: just now). A quiet session is hours old. */
  idleMs?: number;
  /** The game was never seen during the session: it only waits for it. */
  empty?: boolean;
  /** How an ended session ended (default: "gap", the older fixtures). */
  endReason?: "manual" | "new_session" | "gap";
  /** The game wrote its quit line during this open session, this long ago. */
  gameClosedAgoMs?: number;
}

/** What the server paid, in the story, for the cargo lost with a ship (invented). */
export const LOST_CARGO_PAID = 137_911;

const BASE: Fixture[] = [
  {
    number: 1,
    startedAgoMs: 50 * HOUR,
    activeMs: 2 * HOUR,
    trips: 4,
    net: 96_000,
    start: 120_000,
    last: 216_000,
    status: "ended",
  },
  {
    number: 2,
    startedAgoMs: 27 * HOUR,
    activeMs: 3 * HOUR + 10 * MIN,
    trips: 9,
    net: 310_500,
    start: 216_000,
    last: 526_500,
    status: "ended",
    interruptions: 1,
  },
  {
    number: 3,
    startedAgoMs: 5 * HOUR,
    activeMs: 1 * HOUR + 40 * MIN,
    trips: 5,
    net: -12_000,
    start: 526_500,
    last: 514_500,
    status: "ended",
  },
];

function money(f: Fixture, gross = false) {
  const hours = f.activeMs / HOUR;
  const net = gross ? (f.gross ?? null) : f.net;
  return {
    start_balance_auec: f.start,
    start_balance_quality: f.quality ?? "game_start",
    last_balance_auec: f.last,
    balance_change_auec: f.start !== null && f.last !== null ? f.last - f.start : null,
    net_auec: net,
    net_source: net === null ? (f.last !== null && f.start !== null ? "balance" : null) : "trips",
    net_complete: net === null ? null : true,
    turnover_auec: null,
    cost_auec: null,
    fees_auec: null,
    gross_margin_auec: f.gross ?? null,
    measured_net_auec: gross ? null : net,
    gross_only_trips: gross ? f.trips : 0,
    overlap_excluded: 0,
    net_per_hour_auec: net !== null && hours >= 1 / 6 ? Math.round(net / hours) : null,
    avg_trip_net_auec: net !== null && f.trips > 0 ? Math.round(net / f.trips) : null,
    best_trip:
      f.trips > 0
        ? { label: "Waste Disposal | Easy", commodity: "Waste", net_auec: 84_000, gross: false }
        : null,
    plan:
      f.trips > 3
        ? { planned_auec: 100_000, measured_auec: 84_000, efficiency: 0.84, trips: 1 }
        : null,
    lost_cargo_paid_auec: f.shipLosses ? LOST_CARGO_PAID : null,
  };
}

export function sessionSummary(f: Fixture, now: number, includeBalance: boolean, gross = false) {
  const startedAt = now - f.startedAgoMs;
  const status = f.status ?? "open";
  return {
    id: `s_fixture_${f.number}`,
    number: f.number,
    status,
    end_reason: status === "ended" ? (f.endReason ?? "gap") : null,
    started_at: new Date(startedAt).toISOString(),
    ended_at: status === "ended" ? new Date(startedAt + f.activeMs + 10 * MIN).toISOString() : null,
    last_activity_at: new Date(
      status === "ended" ? startedAt + f.activeMs : now - (f.idleMs ?? 4000),
    ).toISOString(),
    empty: f.empty ?? false,
    game_closed_at:
      f.gameClosedAgoMs !== undefined ? new Date(now - f.gameClosedAgoMs).toISOString() : null,
    duration_ms: f.activeMs + 10 * MIN,
    active_ms: f.activeMs,
    interruptions: f.interruptions ?? 0,
    game_version: "4.10.2",
    game_channel: "live",
    trips: f.trips,
    contracts: f.contracts ?? 0,
    trips_with_net: gross ? 0 : f.trips,
    trips_dropped: 0,
    trips_per_hour: f.trips > 0 ? Math.round((f.trips / (f.activeMs / HOUR)) * 10) / 10 : null,
    minutes_per_trip: f.trips > 0 ? Math.round((f.activeMs / f.trips / MIN) * 10) / 10 : null,
    last_location: "Port Tressler",
    last_commodity: "Waste",
    note: "",
    ship_losses: Array.from({ length: f.shipLosses ?? 0 }, (_, i) => ({
      at: new Date(now - (i + 1) * 5 * MIN).toISOString(),
      ship_class: "MISC_Freelancer",
      cause: "collision",
      causer: "unknown",
      zone: "OOC_Stanton_3a_Lyria",
      cargo_scu: 100 * (i + 1),
    })).reverse(),
    ship_losses_count: f.shipLosses ?? 0,
    money: includeBalance ? money(f, gross) : "withheld",
  };
}

const CURRENT: Fixture = {
  number: 4,
  startedAgoMs: 95 * MIN,
  activeMs: 88 * MIN,
  trips: 6,
  contracts: 1,
  net: 184_500,
  start: 250_000,
  last: 434_500,
  interruptions: 1,
};

/** The story's session 4, ended by hand 3 hours after it began... */
const ENDED_BY_HAND: Fixture = {
  ...CURRENT,
  status: "ended",
  startedAgoMs: 3 * HOUR,
  endReason: "manual",
};
/** ...and the empty session that waits for the game (nothing seen during it: no trip, no balance, no played time). */
const WAITING: Fixture = {
  number: 5,
  startedAgoMs: 4 * MIN,
  activeMs: 0,
  trips: 0,
  net: null,
  start: null,
  last: null,
  empty: true,
  idleMs: 4 * MIN,
};

/** The `sessions` field of a poll answer. */
export function sessionBar(
  nowMs: number,
  includeBalance: boolean,
  variant: SessionVariant = "story",
) {
  const base = { v: 1 as const, gap_hours: 3, notice: null as string | null };
  if (variant === "off") return { ...base, status: "off", current: null, stale: false };
  if (variant === "empty") return { ...base, status: "ok", current: null, stale: false };
  if (variant === "readonly")
    return {
      ...base,
      status: "readonly",
      notice:
        "The session file is from a newer version (2); sessions are kept in memory only until it is updated.",
      current: sessionSummary(CURRENT, nowMs, includeBalance),
      stale: false,
    };
  if (variant === "stale")
    return {
      ...base,
      status: "ok",
      current: sessionSummary(
        { ...CURRENT, startedAgoMs: 4 * HOUR, idleMs: 3.5 * HOUR },
        nowMs,
        includeBalance,
      ),
      stale: true,
    };
  if (variant === "ended")
    return {
      ...base,
      status: "ok",
      current: sessionSummary(ENDED_BY_HAND, nowMs, includeBalance),
      stale: false,
    };
  if (variant === "waiting")
    return {
      ...base,
      status: "ok",
      current: sessionSummary(WAITING, nowMs, includeBalance),
      stale: false,
    };
  if (variant === "gross")
    return {
      ...base,
      status: "ok",
      current: sessionSummary(
        {
          ...CURRENT,
          net: null,
          start: null,
          last: null,
          gross: 61_250,
          trips: 3,
          contracts: 0,
          interruptions: 0,
          quality: "first_seen",
        },
        nowMs,
        includeBalance,
        true,
      ),
      stale: false,
    };
  if (variant === "losses" || variant === "manylosses")
    // A resumed session (1 interruption) whose start balance is not the game's, a store notice, and ships lost: every note at once.
    return {
      ...base,
      status: "degraded",
      notice: "Sessions could not be saved: the folder is read-only.",
      current: sessionSummary(
        {
          ...CURRENT,
          interruptions: 1,
          quality: "late",
          idleMs: 5 * HOUR,
          shipLosses: variant === "losses" ? 3 : 5,
        },
        nowMs,
        includeBalance,
      ),
      stale: true,
    };
  return {
    ...base,
    status: "ok",
    current: sessionSummary(CURRENT, nowMs, includeBalance),
    stale: false,
  };
}

/** What the session tools answer to the View (structured content). */
export function sessionToolAnswer(
  name: string,
  args: Record<string, any>,
  nowMs: number,
  variant: SessionVariant = "story",
) {
  const include = args["include_balance"] !== false;
  // The history the variant implies: session 4 is the one in progress, ended by hand, or replaced by the waiting session 5.
  const all =
    variant === "ended"
      ? [...BASE, ENDED_BY_HAND]
      : variant === "waiting"
        ? [...BASE, { ...ENDED_BY_HAND, endReason: "new_session" as const }, WAITING]
        : [...BASE, CURRENT];
  if (name === "sc_session_list") {
    return {
      total: all.length,
      sessions: [...all].reverse().map((f) => sessionSummary(f, nowMs, include)),
    };
  }
  if (name === "sc_session_stats") {
    return {
      sessions: all.length,
      empty_sessions_ignored: 0,
      trips: all.reduce((n, f) => n + f.trips, 0),
      contracts: 1,
      active_ms: all.reduce((n, f) => n + f.activeMs, 0),
      trips_per_hour: 3.2,
      money: include
        ? {
            sessions_with_net: 4,
            net_auec: 579_000,
            turnover_auec: null,
            avg_net_per_hour_auec: 63_700,
            avg_net_per_session_auec: 144_750,
            best_session: { number: 2, net_per_hour_auec: 98_100, net_auec: 310_500 },
            worst_session: { number: 3, net_per_hour_auec: -7_200, net_auec: -12_000 },
            trend: {
              direction: "up",
              recent_per_hour_auec: 85_000,
              previous_per_hour_auec: 40_000,
              sessions_each: 2,
            },
            plan: { efficiency: 0.84, trips: 2 },
            best_routes: [
              {
                commodity: "Waste",
                buy_terminal: "Port Tressler",
                sell_terminal: "Area18",
                trips: 3,
                avg_net_auec: 61_000,
                total_net_auec: 183_000,
              },
            ],
            best_commodities: [],
          }
        : "withheld",
    };
  }
  if (name === "sc_session_current") {
    const f = all.find((x) => `s_fixture_${x.number}` === args["id"]) ?? CURRENT;
    return {
      session: sessionSummary(f, nowMs, include),
      is_current: false,
      recent_trips: [
        {
          ended_at: new Date(nowMs - 20 * MIN).toISOString(),
          label: "Waste Disposal | Easy",
          commodity: "Waste",
          buy_terminal: "Port Tressler",
          sell_terminal: "Area18",
          net_auec: include ? 84_000 : null,
        },
        {
          ended_at: new Date(nowMs - 50 * MIN).toISOString(),
          label: "Cargo Stims",
          commodity: "Stims",
          buy_terminal: null,
          sell_terminal: null,
          net_auec: include ? 12_500 : null,
        },
      ],
      interruptions: f.interruptions
        ? [
            {
              from: new Date(nowMs - 3 * HOUR).toISOString(),
              to: new Date(nowMs - 2.5 * HOUR).toISOString(),
              kind: "unclean",
            },
          ]
        : [],
    };
  }
  if (name === "sc_session_export") {
    // A made-up report with the same shape as the server's (the real text is built by providers/sessions/debrief.ts and
    // tested there): amounts only with include_balance, the balances only with include_start_balance on top.
    const balances = include && args["include_start_balance"] === true;
    const markdown = [
      "# Bilan de la session 2",
      "",
      "- Trajets : 9 · 2,8 par heure",
      include
        ? "- Résultat des trajets : 310 500 aUEC (mesure brute)"
        : "- Montants : masqués. Ils viennent du solde du joueur.",
      ...(balances ? ["- Solde : 216 000 aUEC au départ → 526 500 aUEC au dernier relevé"] : []),
      "",
      "| Fin (UTC) | Trajet | SCU |",
      "| --- | --- | ---: |",
      "| 2026-11-03 19:10 | Cargaison · Waste Disposal \\| Easy | 96 |",
    ].join("\n");
    const d = args["csv_delimiter"] === ";" ? ";" : ",";
    const csv =
      ["session", "ended_at", "kind", "label", "scu", ...(include ? ["net_auec"] : [])].join(d) +
      "\r\n" +
      ["2", "2026-11-03T19:10:00Z", "trade", '"Waste Disposal | Easy"', d === ";" ? "96,5" : "96.5"]
        .concat(include ? ["84000"] : [])
        .join(d) +
      "\r\n";
    return {
      sessions: [2],
      trips_total: 9,
      markdown_omitted: 0,
      csv_omitted: 0,
      truncated: false,
      money_included: include,
      balances_included: balances,
      csv_delimiter: d,
      // only the text asked for (kind), like the server
      ...(args["kind"] === "csv" ? { csv } : { markdown }),
    };
  }
  // The shapes of tools/sessions.ts (the server's English messages are never shown by the View).
  const live = variant === "waiting" ? WAITING : variant === "ended" ? ENDED_BY_HAND : CURRENT;
  if (name === "sc_session_new") {
    const closes = variant === "story" || variant === "stale" || variant === "readonly";
    return variant === "waiting"
      ? {
          ok: true,
          started: false,
          closed_session: null,
          message: "Nothing started: session 5 is empty and still waits for the game.",
          session: sessionSummary(live, nowMs, false),
          persistence: { saved: true, status: "ok" },
        }
      : {
          ok: true,
          started: true,
          closed_session: closes ? live.number : null,
          message: "Session 5 started.",
          session: sessionSummary(WAITING, nowMs, false),
          persistence: { saved: true, status: "ok" },
        };
  }
  if (name === "sc_session_end") {
    const reason =
      variant === "waiting" ? "empty" : variant === "ended" ? "already_ended" : "ended";
    const done = reason === "ended";
    return {
      ok: done,
      reason,
      message: done ? "Session 4 ended." : "Nothing ended.",
      session: sessionSummary(done ? ENDED_BY_HAND : live, nowMs, false),
      persistence: { saved: true, status: "ok" },
    };
  }
  return {};
}

/**
 * A stateful stand-in for the server's session side: the bar and the tools answer from ONE variant, and "Terminer" /
 * "Nouvelle session" move it the way the real reducer does (end: in progress to ended, an empty session stays; new: anything
 * but a waiting session to a waiting session 5). So a test or the preview sees the card change after a click.
 */
export function sessionFake(initial: SessionVariant = "story") {
  let variant = initial;
  const calls: string[] = [];
  return {
    get variant() {
      return variant;
    },
    set variant(v: SessionVariant) {
      variant = v;
    },
    /** Every session tool call, in order (the same names as the real tools). */
    calls,
    bar: (nowMs: number, include: boolean) => sessionBar(nowMs, include, variant),
    tool: (name: string, args: Record<string, any>, nowMs: number) => {
      const answer = sessionToolAnswer(name, args, nowMs, variant);
      if (name === "sc_session_end" || name === "sc_session_new") {
        calls.push(name);
        if (name === "sc_session_end" && (answer as any).ok === true) variant = "ended";
        if (name === "sc_session_new" && (answer as any).started === true) variant = "waiting";
      }
      return answer;
    },
  };
}
