import type { TelemetryEvent } from "../providers/telemetry/events.js";
import type { Pilot, Ship, Weapons } from "../providers/telemetry/normalize.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../providers/telemetry/service.js";
import type { ShipSpecs } from "./specs.js";

/**
 * What the View receives from sc_live_poll (as `structuredContent`, which the host does not add to the model's
 * context). Built here from the telemetry service's own outputs, with nothing added that the stream did not
 * carry. The aUEC balance exists ONLY in `balance`, and only when the View asked for it.
 */

export interface SessionMarker {
  kind: "start" | "end" | "reset_delta";
  at: string;
}

export interface SessionState {
  startedAt: number | null;
  endedAt: number | null;
  /** Events with a higher seq than this belong to the session. */
  startSeq: number;
  /** Set when the session was ended: later events do not count. */
  endSeq: number | null;
  markers: SessionMarker[];
}

export interface SessionSummary {
  started_at: string | null;
  ended_at: string | null;
  takeoffs: number;
  landings: number;
  jumps: number;
  /** Time in flight, ESTIMATED from the took_off and landed events (the game sends no flight timer). */
  flight_ms: number;
  flight_ms_is_estimate: true;
  markers: SessionMarker[];
}

/** A ship without the parts the View never shows (guesses the field test could not confirm, bookkeeping). */
export type PublicShip = Omit<Ship, "unverified" | "parts_missing">;

export type PublicEvent = Pick<
  TelemetryEvent,
  "seq" | "type" | "group" | "confidence" | "at" | "text" | "data"
>;

export interface PollResult {
  v: 1;
  /** Epoch ms on the server when this answer was built. */
  at: number;
  enabled: boolean;
  state: TelemetryStatusReport["state"];
  cause: string;
  frame_age_ms: number | null;
  received_at: string | null;
  ship: PublicShip | null;
  pilot: Omit<Pilot, "uec_balance" | "unverified" | "parts_missing"> | null;
  weapons: Weapons | null;
  derived: Record<string, boolean | string> | null;
  not_available: string[];
  events: PublicEvent[];
  last_seq: number;
  session: SessionSummary;
  /** Present only when the View asked for it (after the player clicked "show balance"). */
  balance?: { uec: number | string; delta: number | null; since: string | null };
  /** The wiki sheet of the ship (specs.ts). Present only while a ship is flown. Third-party figures, bounded. */
  specs?: ShipSpecs;
  not_in_stream: readonly string[];
  /** Present only when the answer had to be cut to stay bounded. */
  truncated?: string;
}

export const EMPTY_SESSION: SessionState = {
  startedAt: null,
  endedAt: null,
  startSeq: 0,
  endSeq: null,
  markers: [],
};

const CAUSE_OFF =
  "Telemetry is switched off on the server side (SC_TELEMETRY is not 'on'). Nothing was read from the game.";

/** The answer while the telemetry is off. Built without touching the telemetry service at all. */
export function offPoll(nowMs: number, session: SessionState = EMPTY_SESSION): PollResult {
  return {
    v: 1,
    at: nowMs,
    enabled: false,
    state: "off",
    cause: CAUSE_OFF,
    frame_age_ms: null,
    received_at: null,
    ship: null,
    pilot: null,
    weapons: null,
    derived: null,
    not_available: [],
    events: [],
    last_seq: 0,
    session: summarizeSession([], session, nowMs, false),
    not_in_stream: [],
  };
}

/**
 * Takeoffs, landings, jumps and an estimated flight time over the events of the session. `airborneNow` is the
 * current `landed === false` reading: it closes the open interval at "now".
 */
export function summarizeSession(
  events: readonly Pick<TelemetryEvent, "type" | "at">[],
  session: SessionState,
  nowMs: number,
  airborneNow: boolean,
): SessionSummary {
  let takeoffs = 0;
  let landings = 0;
  let jumps = 0;
  let flight = 0;
  let airborneSince: number | null = null;
  const startMs = session.startedAt;
  const endMs = session.endedAt ?? nowMs;
  const first = events.find((e) => e.type === "took_off" || e.type === "landed");
  // The first thing seen is a landing: the ship was flying when the session began.
  if (first?.type === "landed" && startMs !== null) airborneSince = startMs;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (e.type === "took_off") {
      takeoffs++;
      airborneSince ??= t;
    } else if (e.type === "landed") {
      landings++;
      if (airborneSince !== null) flight += Math.max(0, t - airborneSince);
      airborneSince = null;
    } else if (e.type === "jump_started") {
      jumps++;
    }
  }
  if (airborneSince !== null && airborneNow) flight += Math.max(0, endMs - airborneSince);
  return {
    started_at: startMs === null ? null : new Date(startMs).toISOString(),
    ended_at: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
    takeoffs,
    landings,
    jumps,
    flight_ms: flight,
    flight_ms_is_estimate: true,
    markers: session.markers.slice(-40),
  };
}

/** The poll answer never exceeds this many characters once serialised (the telemetry tools use the same bound). */
export const MAX_POLL_CHARS = 40_000;
const MAX_POLL_WEAPONS = 64;

/**
 * Keeps an answer under MAX_POLL_CHARS whatever the stream sent: weapons are cut to 64, then, while the answer is
 * still too large, events and weapons are halved. What was cut is said in `truncated`. Never raises the size.
 */
export function boundPoll(result: PollResult, maxChars: number = MAX_POLL_CHARS): PollResult {
  let out = result;
  const notes: string[] = [];
  if (out.weapons && out.weapons.weapons.length > MAX_POLL_WEAPONS) {
    out = {
      ...out,
      weapons: { ...out.weapons, weapons: out.weapons.weapons.slice(0, MAX_POLL_WEAPONS) },
    };
    notes.push(`weapons cut to ${MAX_POLL_WEAPONS}`);
  }
  for (let i = 0; i < 8 && JSON.stringify(out).length > maxChars; i++) {
    const events = out.events.slice(Math.floor(out.events.length / 2));
    const weapons = out.weapons
      ? {
          ...out.weapons,
          weapons: out.weapons.weapons.slice(0, Math.floor(out.weapons.weapons.length / 2)),
        }
      : out.weapons;
    out = { ...out, events, weapons };
    notes.push("events and weapons halved");
  }
  return notes.length ? { ...out, truncated: notes.join("; ") } : out;
}

export interface PollInput {
  status: TelemetryStatusReport;
  snapshot: TelemetrySnapshot | null;
  events: readonly TelemetryEvent[];
  lastSeq: number;
  /** The events since the start marker (empty when there is none). */
  sessionEvents: readonly TelemetryEvent[];
  session: SessionState;
  includeBalance: boolean;
  nowMs: number;
  /** What the wiki says about the ship being flown (specs.ts). Never fetched here: the caller passes what it has. */
  specs?: ShipSpecs;
}

const publicEvent = (e: TelemetryEvent): PublicEvent => ({
  seq: e.seq,
  type: e.type,
  group: e.group,
  confidence: e.confidence,
  at: e.at,
  text: e.text,
  data: e.data,
});

/** The ship as the View sees it. */
function publicShip(ship: Ship): PublicShip {
  const { unverified, parts_missing, ...rest } = ship;
  void unverified;
  void parts_missing;
  return rest;
}

export function buildPoll(input: PollInput): PollResult {
  const { status, snapshot, includeBalance, nowMs } = input;
  const state = snapshot?.state ?? null;
  const unavailable: string[] = [];
  if (snapshot && state) {
    if (!state.ship) unavailable.push("ship");
    if (!state.weapons) unavailable.push("weapons");
    if (!state.pilot) unavailable.push("pilot");
  }
  let pilot: PollResult["pilot"] = null;
  let balance: PollResult["balance"];
  if (state?.pilot) {
    const { uec_balance, unverified, parts_missing, ...rest } = state.pilot;
    void unverified;
    void parts_missing;
    pilot = rest;
    if (includeBalance && uec_balance !== undefined) {
      balance = {
        uec: uec_balance,
        delta: snapshot?.uec_session?.delta ?? null,
        since: snapshot?.uec_session?.since ?? null,
      };
    }
  }
  return {
    v: 1,
    at: nowMs,
    enabled: true,
    state: status.state,
    cause: status.cause,
    frame_age_ms: snapshot ? snapshot.frame_age_ms : null,
    received_at: snapshot ? snapshot.received_at : null,
    ship: state?.ship ? publicShip(state.ship) : null,
    pilot,
    weapons: state?.weapons ?? null,
    derived: state ? { ...state.derived } : null,
    not_available: unavailable,
    events: input.events.map(publicEvent),
    last_seq: input.lastSeq,
    session: summarizeSession(
      input.sessionEvents,
      input.session,
      nowMs,
      state?.ship?.landed === false,
    ),
    ...(balance ? { balance } : {}),
    ...(input.specs && state?.ship ? { specs: input.specs } : {}),
    not_in_stream: status.not_in_stream,
  };
}
