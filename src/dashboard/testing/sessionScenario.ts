/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): made-up saved sessions for the session bar. Shapes are
 * those of providers/sessions/stats.ts (SessionSummary, AggregateStats) and of the session tools' answers. No real
 * balance, no Node-only module: the browser imports it.
 *
 * Money follows the dashboard's rule: a fixture built with `includeBalance` false carries `money: "withheld"`.
 */

export type SessionVariant = "story" | "empty" | "off" | "stale" | "ended" | "readonly" | "gross";

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
}

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
  };
}

export function sessionSummary(f: Fixture, now: number, includeBalance: boolean, gross = false) {
  const startedAt = now - f.startedAgoMs;
  const status = f.status ?? "open";
  return {
    id: `s_fixture_${f.number}`,
    number: f.number,
    status,
    end_reason: status === "ended" ? "gap" : null,
    started_at: new Date(startedAt).toISOString(),
    ended_at: status === "ended" ? new Date(startedAt + f.activeMs + 10 * MIN).toISOString() : null,
    last_activity_at: new Date(
      status === "ended" ? startedAt + f.activeMs : now - 4000,
    ).toISOString(),
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
      current: sessionSummary({ ...CURRENT, startedAgoMs: 4 * HOUR }, nowMs, includeBalance),
      stale: true,
    };
  if (variant === "ended")
    return {
      ...base,
      status: "ok",
      current: sessionSummary(
        { ...CURRENT, status: "ended", startedAgoMs: 3 * HOUR },
        nowMs,
        includeBalance,
      ),
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
  return {
    ...base,
    status: "ok",
    current: sessionSummary(CURRENT, nowMs, includeBalance),
    stale: false,
  };
}

/** What the session tools answer to the View (structured content). */
export function sessionToolAnswer(name: string, args: Record<string, any>, nowMs: number) {
  const include = args["include_balance"] === true;
  const all = [...BASE, CURRENT];
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
  if (name === "sc_session_debrief") {
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
    const csv =
      "session,ended_at,kind,label,scu" +
      (include ? ",net_auec" : "") +
      "\r\n2,2026-11-03T19:10:00Z,trade,Waste Disposal | Easy,96" +
      (include ? ",84000" : "") +
      "\r\n";
    return {
      format: "both",
      sessions: [2],
      trips_total: 9,
      markdown_rows: 9,
      csv_rows: 9,
      truncated: false,
      money_included: include,
      balances_included: balances,
      markdown,
      csv,
    };
  }
  if (name === "sc_session_new")
    return { ok: true, message: "Session 5 started. Session 4 was closed." };
  if (name === "sc_session_end") return { ok: true, message: "Session 4 ended." };
  return {};
}
