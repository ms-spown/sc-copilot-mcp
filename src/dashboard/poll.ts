import type { TelemetryEvent } from "../providers/telemetry/events.js";
import type { Condition } from "../providers/telemetry/handler.js";
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

export type SectionName = "ship" | "pilot" | "weapons" | "specs";
export const SECTION_NAMES: readonly SectionName[] = ["ship", "pilot", "weapons", "specs"];
export type SectionHashes = Record<SectionName, string>;

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
  /**
   * The wiki sheet of the flown ship (specs.ts): a fourth section of the delta protocol. Present only while a ship is
   * flown; third-party figures, bounded. It does not change from one poll to the next (its age is worked out by the
   * View from `fetched_at`), so once held it is left out of the answers (`unchanged`).
   */
  specs?: ShipSpecs;
  derived: Record<string, boolean | string> | null;
  /**
   * What is true now (from the smoothed state, not from the history), most urgent first. Empty when nothing needs
   * attention AND when the stream is not live: a stale state is never presented as current.
   */
  conditions: Condition[];
  /**
   * Present in the stream but never verified live (field test): the View labels each one "non vérifié". Only values
   * the game really sent (a default value of a field that is never filled is left out).
   */
  unverified: {
    ship?: Record<string, unknown>;
    pilot?: Record<string, unknown>;
    weapons?: Record<string, unknown>;
  };
  not_available: string[];
  events: PublicEvent[];
  last_seq: number;
  session: SessionSummary;
  /** Present only when the View asked for it (after the player clicked "show balance"). */
  balance?: { uec: number | string; delta: number | null; since: string | null };
  /** What the stream never contains. Sent once (see PollRequest.includeStatic), not at every poll. */
  not_in_stream?: readonly string[];
  /** A short hash of each section, so the View can say which ones it already holds (see tailorPoll). */
  hash?: SectionHashes;
  /** Sections left out of THIS answer because the View already has them unchanged (see PollRequest.have). */
  unchanged?: SectionName[];
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
    conditions: [],
    unverified: {},
    not_available: [],
    events: [],
    last_seq: 0,
    session: summarizeSession([], session, nowMs, false),
    hash: hashSections({ ship: null, pilot: null, weapons: null }),
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

/** Conditions are only offered while the last frame is at most this old (the stream's own "live" window). */
const LIVE_CONDITIONS_MS = 5000;

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

/** The weapons without the `unverified` part (it travels under the answer's own `unverified`). */
function publicWeapons(weapons: Weapons): Weapons {
  const { unverified, ...rest } = weapons;
  void unverified;
  return rest;
}

/** The unverified values the stream carried, without the defaults of fields the game never fills. */
function publicUnverified(state: TelemetrySnapshot["state"] | null): PollResult["unverified"] {
  const out: PollResult["unverified"] = {};
  if (state?.ship && Object.keys(state.ship.unverified).length > 0)
    out.ship = { ...state.ship.unverified };
  if (state?.weapons?.unverified && Object.keys(state.weapons.unverified).length > 0) {
    out.weapons = { ...state.weapons.unverified };
  }
  if (state?.pilot) {
    const pilot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state.pilot.unverified)) {
      if (
        (key === "intoxication_level" || key === "ambient_radiation_rate") &&
        !(Number(value) > 0)
      )
        continue;
      pilot[key] = value;
    }
    if (Object.keys(pilot).length > 0) out.pilot = pilot;
  }
  return out;
}

export function buildPoll(input: PollInput): PollResult {
  const answer = buildAnswer(input);
  return { ...answer, hash: hashSections(answer) };
}

function buildAnswer(input: PollInput): PollResult {
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
    weapons: state?.weapons ? publicWeapons(state.weapons) : null,
    ...(input.specs && state?.ship ? { specs: input.specs } : {}),
    derived: state ? { ...state.derived } : null,
    conditions:
      snapshot && state && status.state === "live" && snapshot.frame_age_ms <= LIVE_CONDITIONS_MS
        ? state.conditions
        : [],
    unverified: publicUnverified(state),
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
    not_in_stream: status.not_in_stream,
  };
}

/** A 53-bit string hash (cyrb53), as 14 hex digits. Not a security measure: it only detects "same as before". */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function hashSections(
  answer: Pick<PollResult, "ship" | "pilot" | "weapons"> & { specs?: ShipSpecs },
): SectionHashes {
  return {
    ship: hashText(JSON.stringify(answer.ship)),
    pilot: hashText(JSON.stringify(answer.pilot)),
    weapons: hashText(JSON.stringify(answer.weapons)),
    specs: hashText(JSON.stringify(answer.specs ?? null)),
  };
}

/** What a View says about itself with each poll. Every part is optional: a View that sends none gets the full answer. */
export interface PollRequest {
  includeBalance: boolean;
  /** Ask for `not_in_stream` (the View does it once). */
  includeStatic?: boolean;
  /** The newest event number the View holds: only newer events come back. */
  sinceSeq?: number;
  /** The hashes of the sections the View holds: a section with the same hash is left out. */
  have?: Partial<Record<SectionName, string>>;
}

/**
 * The shared (cached) answer, cut to what ONE View still needs: the same events only once, the static list only when
 * asked, the sections it already holds only if they changed. The work of reading the stream is shared between all
 * Views; this is cheap and per request. A View that sends nothing gets everything, as before.
 */
export function tailorPoll(full: PollResult, request: PollRequest): PollResult {
  const out: PollResult = { ...full };
  if (!request.includeStatic) delete out.not_in_stream;
  if (typeof request.sinceSeq === "number") {
    // A server that restarted numbers its events again: a cursor ahead of it means "from the start".
    const after = request.sinceSeq > full.last_seq ? 0 : request.sinceSeq;
    out.events = full.events.filter((e) => e.seq > after);
  }
  const unchanged: SectionName[] = [];
  const hashes = full.hash;
  for (const name of SECTION_NAMES) {
    const have = request.have?.[name];
    const held = full[name] !== null && full[name] !== undefined;
    if (hashes && held && typeof have === "string" && have === hashes[name]) {
      unchanged.push(name);
      delete (out as unknown as Record<string, unknown>)[name];
    }
  }
  if (unchanged.length > 0) out.unchanged = unchanged;
  return out;
}
