import { randomBytes } from "node:crypto";
import {
  MAX_INTERRUPTIONS,
  MAX_TRIPS,
  NOTE_MAX,
  TripSchema,
  cleanText,
  type Session,
  type StoreState,
  type Trip,
  type TripInput,
} from "./types.js";

/**
 * The lifecycle of a session, as PURE functions over the file's state (no clock of their own, no I/O, no network).
 * The store applies them under its lock on the freshest content, so two server processes that watch the same game
 * agree, and every function is safe to apply twice: it only adds what is not there yet.
 *
 * When a session starts, resumes and ends:
 *  - It STARTS when the game is seen running and there is no session, or the last one has been quiet for longer than
 *    `gapMs` (default 3 hours), or the player pressed "Nouvelle session" (`startNew`), or the dashboard was opened after
 *    such a break (`ensureCurrent`: the empty session waits for the game).
 *  - It RESUMES when the game is seen again within `gapMs` of the last sighting, whether the game was closed cleanly or
 *    not (crash, reboot, server not running). The break is written in `interruptions`: `game_closed` if the game wrote
 *    its quit line, `unclean` if there was no end marker. Nothing is invented about what happened during it.
 *  - It ENDS when the player ends it (`endCurrent`: it is then not resumed; the next play period starts a new one once
 *    the game is seen starting afresh), when a new one starts, or when the gap is exceeded (closed at its last sighting).
 *
 * `active_ms` counts only the time the game was seen running, in steps of at most ACTIVE_CAP_MS: a gap adds nothing.
 */

/** Activity is written to the file at most this often (events are written at once). */
export const HEARTBEAT_MS = 15_000;
/** A heartbeat counts at most this much time, so a stalled server never credits a long gap. */
export const ACTIVE_CAP_MS = 60_000;
/** A silence longer than this between two sightings is recorded as an interruption. */
export const RESUME_GAP_MS = 90_000;
/** A start balance adopted later than this after the session began is marked `late`. */
export const LATE_BALANCE_MS = 5 * 60_000;
/** A session is "empty" when the game was never seen during it. */
export const isEmpty = (s: Session): boolean =>
  s.trips.length === 0 && s.start_balance === null && s.active_ms === 0;

export interface Observation {
  now: number;
  /** The game is believed to be running (Game.log fresh, or the stream live). */
  running: boolean;
  balance: number | null;
  /** The first balance appeared while the server was already watching: the start balance is the real one. */
  freshStart: boolean;
  connection: { state: string; since: string | null } | null;
  game: { version: string | null; channel: "live" | "ptu" | "unknown" } | null;
  trips: readonly TripInput[];
  context: { location: string | null; commodity: string | null; at: string | null } | null;
}

export interface ReduceConfig {
  gapMs: number;
  newId?: () => string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null): number => (s === null ? NaN : Date.parse(s));

export const defaultId = (now: number): string =>
  `s_${now.toString(36)}_${randomBytes(3).toString("hex")}`;

export const latest = (state: StoreState): Session | undefined =>
  state.sessions[state.sessions.length - 1];

/** The instant the quiet time is counted from: the last sighting, or the end if that is later. */
const quietSince = (s: Session): number => Math.max(ms(s.last_activity_at), ms(s.ended_at) || 0);

function create(
  state: StoreState,
  now: number,
  cfg: ReduceConfig,
  balance: number | null,
  quality: Session["start_balance_quality"],
): Session {
  const stamp = iso(now);
  const session: Session = {
    id: (cfg.newId ?? (() => defaultId(now)))(),
    number: state.next_number,
    started_at: stamp,
    ended_at: null,
    end_reason: null,
    last_activity_at: stamp,
    quit_at: null,
    start_balance: balance,
    start_balance_at: balance === null ? null : stamp,
    start_balance_quality: balance === null ? null : quality,
    last_balance: balance,
    last_balance_at: balance === null ? null : stamp,
    game_version: null,
    game_channel: null,
    active_ms: 0,
    interruptions: [],
    trips: [],
    trips_dropped: 0,
    last_location: null,
    last_commodity: null,
    last_context_at: null,
    note: "",
    updated_at: stamp,
  };
  state.next_number += 1;
  state.sessions.push(session);
  return session;
}

/** Drops an empty last session (its number is given back) or closes a used one at `endMs`. */
function retire(
  state: StoreState,
  cur: Session,
  endMs: number,
  reason: "gap" | "new_session" | "manual",
) {
  if (isEmpty(cur) && cur.ended_at === null) {
    state.sessions.pop();
    state.next_number = cur.number;
    return;
  }
  if (cur.ended_at !== null) return;
  cur.ended_at = iso(Math.max(ms(cur.started_at), endMs));
  cur.end_reason = reason;
  cur.updated_at = iso(endMs);
}

/** When the player closes a session now: at the click if the game was just seen, else at the last sighting. */
const closeAt = (cur: Session, now: number): number =>
  now - ms(cur.last_activity_at) > 5 * 60_000 ? ms(cur.last_activity_at) : now;

/** Does this observation show a new play period after the instant `sinceMs`? */
function freshAfter(obs: Observation, sinceMs: number): boolean {
  if (obs.freshStart) return true;
  const c = obs.connection;
  const at = c?.since ? Date.parse(c.since) : NaN;
  return !!c && (c.state === "online" || c.state === "menu") && Number.isFinite(at) && at > sinceMs;
}

// ---------------------------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------------------------

const figures = (t: Trip) =>
  [
    t.ended_at,
    t.cost_auec,
    t.revenue_auec,
    t.fees_auec,
    t.gross_margin_auec,
    t.net_auec,
    t.scu,
  ].join("|");
const grew = (a: Trip, b: Trip) => figures(a) !== figures(b);

const MEASURES = [
  "cost_auec",
  "revenue_auec",
  "fees_auec",
  "gross_margin_auec",
  "net_auec",
] as const;
/** The offered trip no longer knows a figure that the stored one has. */
const lostFigure = (stored: Trip, offered: Trip) =>
  MEASURES.some((k) => stored[k] !== null && offered[k] === null);
/**
 * Should the offered version of a trade run replace the stored one? When the run GREW (its last line is later, a late
 * sale) its figures describe more than the stored ones: yes. When it ends at the same moment, the figures differ only
 * because of what the server could see: a result that was still settling and is known now replaces it, but a figure
 * that was measured must never be replaced by an unknown one. That is what a restarted server offers for every run it
 * did not watch: the log still holds the lines, the balance history of the run is gone (memory only), so its net and
 * its fees come out unknown. The stored trip is the frozen, measured one (trips.ts).
 */
const supersedes = (stored: Trip, offered: Trip) =>
  grew(stored, offered) &&
  (ms(offered.ended_at) > ms(stored.ended_at) || !lostFigure(stored, offered));

const CARRIED = [
  "net_auec",
  "net_kind",
  "fees_auec",
  "fees_method",
  "unexplained_auec",
  "net_doubtful",
] as const;

/**
 * The offered version of a run that GREW, with the figures the stored one measured and the offered one cannot (a restart
 * lost the balance history): a known figure is never replaced by an unknown one. Those figures describe the run as it was
 * measured, not its last lines, so the trip says so (`figures_from_before`) and its net is flagged doubtful: the
 * calibration and the efficiency against the plan leave it out, the session total keeps it (a raw measure of the balance).
 */
function carryMeasured(stored: Trip, offered: Trip): Trip {
  // A net measured again covers the whole run: nothing from before is mixed into it (old fees would not match it).
  if (offered.net_auec !== null) return offered;
  const lost = CARRIED.filter((k) => stored[k] !== null && offered[k] === null);
  if (lost.length === 0) return offered;
  const kept: Partial<Trip> = {};
  for (const k of lost) (kept as Record<string, unknown>)[k] = stored[k];
  return {
    ...offered,
    ...kept,
    ...(offered.net_auec === null && stored.net_auec !== null ? { net_doubtful: true } : {}),
    figures_from_before: true,
  };
}

function mergeTrips(state: StoreState, cur: Session, inputs: readonly TripInput[]): boolean {
  if (inputs.length === 0) return false;
  const known = new Set<string>();
  for (const s of state.sessions) for (const t of s.trips) known.add(t.key);
  const from = ms(cur.started_at) - 2000;
  const to = cur.ended_at === null ? Infinity : ms(cur.ended_at) + 60_000;
  let changed = false;
  for (const input of inputs) {
    const parsed = TripSchema.safeParse(input);
    if (!parsed.success) continue;
    if (known.has(parsed.data.key)) {
      // A trade run of THIS session that grew (a late sale line) replaces its stored trip: same key, new figures.
      // Contracts stay frozen. A run stored in an older session is left as it was.
      const at = cur.trips.findIndex((t) => t.key === parsed.data.key);
      if (
        at >= 0 &&
        parsed.data.source === "trade_journal" &&
        supersedes(cur.trips[at], parsed.data)
      ) {
        cur.trips[at] = {
          ...carryMeasured(cur.trips[at], parsed.data),
          planned_profit_auec: parsed.data.planned_profit_auec ?? cur.trips[at].planned_profit_auec,
          // What the plan said is kept too when the grown run no longer carries it.
          plan_link: parsed.data.plan_link ?? cur.trips[at].plan_link,
          planned_scu: parsed.data.planned_scu ?? cur.trips[at].planned_scu,
          plan_buy_terminal: parsed.data.plan_buy_terminal ?? cur.trips[at].plan_buy_terminal,
          plan_sell_terminal: parsed.data.plan_sell_terminal ?? cur.trips[at].plan_sell_terminal,
        };
        changed = true;
      }
      continue;
    }
    const end = ms(parsed.data.ended_at);
    if (end < from || end > to) continue;
    known.add(parsed.data.key);
    cur.trips.push(parsed.data);
    changed = true;
  }
  if (changed) {
    cur.trips.sort((a, b) => ms(a.ended_at) - ms(b.ended_at));
    if (cur.trips.length > MAX_TRIPS) {
      cur.trips_dropped += cur.trips.length - MAX_TRIPS;
      cur.trips = cur.trips.slice(cur.trips.length - MAX_TRIPS);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// One observation of the game
// ---------------------------------------------------------------------------------------------

export interface ReduceResult {
  changed: boolean;
  current: Session | undefined;
  /** "created" | "resumed" | "held" | ... : for tests and diagnostics. */
  action: string;
}

/**
 * Applies what the server saw to the state. Mutates `state`. Heartbeats are throttled here: a call that only moves the
 * "last seen" clock by less than HEARTBEAT_MS changes nothing.
 */
export function observe(state: StoreState, obs: Observation, cfg: ReduceConfig): ReduceResult {
  const { now } = obs;
  let changed = false;
  let action = "none";
  let cur = latest(state);

  if (obs.running) {
    if (!cur) {
      cur = create(state, now, cfg, obs.balance, obs.freshStart ? "game_start" : "first_seen");
      changed = true;
      action = "created";
    } else if (cur.ended_at !== null) {
      const manual = cur.end_reason === "manual";
      if (!manual || freshAfter(obs, ms(cur.ended_at))) {
        cur = create(state, now, cfg, obs.balance, obs.freshStart ? "game_start" : "first_seen");
        changed = true;
        action = "created";
      } else {
        // The player ended this session and nothing shows a new play period yet: do not reopen or record.
        return { changed: false, current: cur, action: "held" };
      }
    } else if (now - quietSince(cur) > cfg.gapMs) {
      retire(state, cur, ms(cur.last_activity_at), "gap");
      cur = create(state, now, cfg, obs.balance, obs.freshStart ? "game_start" : "first_seen");
      changed = true;
      action = "created";
    }
    const session = cur;
    const last = ms(session.last_activity_at);
    let dt = now - last;
    if (dt < 0) {
      // The clock went backwards (a correction, a resume from sleep): do not freeze the heartbeat or the active time.
      // The delta is clamped to nothing and the "last seen" clock is brought back to now.
      session.last_activity_at = iso(now);
      dt = 0;
      changed = true;
    }
    if (action !== "created") {
      if (isEmpty(session) && dt >= RESUME_GAP_MS) {
        // An empty session (made when the dashboard was opened, or by "Nouvelle session", before the game started)
        // begins now: the wait before the game came is not an interruption, and the balance is a start, not a late one.
        session.started_at = iso(now);
        session.last_activity_at = iso(now);
        changed = true;
        action = "started";
      } else if (dt >= RESUME_GAP_MS) {
        const cleanQuit = session.quit_at !== null && ms(session.quit_at) >= last - 5000;
        if (session.interruptions.length >= MAX_INTERRUPTIONS) session.interruptions.shift();
        session.interruptions.push({
          from: session.last_activity_at,
          to: iso(now),
          kind: cleanQuit ? "game_closed" : "unclean",
        });
        session.quit_at = null;
        session.last_activity_at = iso(now);
        changed = true;
        action = "resumed";
      } else if (dt >= HEARTBEAT_MS) {
        session.active_ms += Math.min(dt, ACTIVE_CAP_MS);
        session.last_activity_at = iso(now);
        changed = true;
        action = "heartbeat";
      }
    }
    if (obs.balance !== null) {
      if (session.start_balance === null) {
        session.start_balance = obs.balance;
        session.start_balance_at = iso(now);
        session.start_balance_quality = obs.freshStart
          ? "game_start"
          : now - ms(session.started_at) > LATE_BALANCE_MS
            ? "late"
            : "first_seen";
        changed = true;
      }
      if (session.last_balance !== obs.balance) {
        session.last_balance = obs.balance;
        session.last_balance_at = iso(now);
        changed = true;
      } else if (changed) {
        session.last_balance_at = iso(now);
      }
    }
  } else if (cur && cur.ended_at !== null) {
    return { changed: false, current: cur, action: "held" };
  }

  if (!cur || cur.ended_at !== null) return { changed, current: cur, action };

  if (obs.connection?.state === "closed" && obs.connection.since) {
    const quit = obs.connection.since;
    if (
      Number.isFinite(Date.parse(quit)) &&
      ms(quit) >= ms(cur.started_at) &&
      cur.quit_at !== quit
    ) {
      cur.quit_at = quit;
      changed = true;
    }
  }
  if (obs.game) {
    const version = obs.game.version ? cleanText(40).parse(obs.game.version) || null : null;
    if (
      (version !== null && version !== cur.game_version) ||
      (obs.game.channel !== "unknown" && obs.game.channel !== cur.game_channel)
    ) {
      if (version !== null) cur.game_version = version;
      if (obs.game.channel !== "unknown") cur.game_channel = obs.game.channel;
      changed = true;
    }
  }
  if (
    obs.context &&
    obs.context.at &&
    (cur.last_context_at === null || obs.context.at > cur.last_context_at)
  ) {
    const place = obs.context.location ? cleanText(60).parse(obs.context.location) || null : null;
    const goods = obs.context.commodity ? cleanText(60).parse(obs.context.commodity) || null : null;
    if (place !== cur.last_location || goods !== cur.last_commodity) {
      cur.last_location = place ?? cur.last_location;
      cur.last_commodity = goods ?? cur.last_commodity;
      cur.last_context_at = obs.context.at;
      changed = true;
    }
  }
  if (mergeTrips(state, cur, obs.trips)) {
    changed = true;
    if (action === "none") action = "trips";
  }
  if (changed) cur.updated_at = iso(now);
  return { changed, current: cur, action };
}

// ---------------------------------------------------------------------------------------------
// Opening the dashboard, and the player's two buttons
// ---------------------------------------------------------------------------------------------

/**
 * The dashboard (or a tool that attaches) was opened: keep the last session unless it has been quiet for longer than
 * the gap, in which case a fresh, empty one is made (an empty stale one is simply renewed). Never creates when the
 * player ended the last session a short time ago: the bar shows it with its "Nouvelle session" button.
 */
export function ensureCurrent(state: StoreState, now: number, cfg: ReduceConfig): ReduceResult {
  const cur = latest(state);
  if (!cur) {
    const made = create(state, now, cfg, null, null);
    return { changed: true, current: made, action: "created" };
  }
  if (now - quietSince(cur) <= cfg.gapMs) return { changed: false, current: cur, action: "kept" };
  if (isEmpty(cur) && cur.ended_at === null) {
    cur.started_at = iso(now);
    cur.last_activity_at = iso(now);
    cur.updated_at = iso(now);
    return { changed: true, current: cur, action: "renewed" };
  }
  retire(state, cur, ms(cur.last_activity_at), "gap");
  const made = create(state, now, cfg, null, null);
  return { changed: true, current: made, action: "created" };
}

/** "Nouvelle session": closes the open one (unless empty, then it is renewed) and starts another. */
export function startNew(
  state: StoreState,
  now: number,
  cfg: ReduceConfig,
  balance: number | null,
  note?: string,
): ReduceResult {
  const cur = latest(state);
  if (cur && cur.ended_at === null) {
    if (isEmpty(cur)) {
      state.sessions.pop();
      state.next_number = cur.number;
    } else {
      retire(state, cur, closeAt(cur, now), "new_session");
    }
  }
  const made = create(state, now, cfg, balance, "new_session");
  if (note) made.note = cleanText(NOTE_MAX).parse(note);
  return { changed: true, current: made, action: "created" };
}

/** "Terminer": ends the open session. False when none is open. */
export function endCurrent(
  state: StoreState,
  now: number,
  note?: string,
): ReduceResult & { ended: boolean } {
  const cur = latest(state);
  if (!cur || cur.ended_at !== null)
    return { changed: false, current: cur, action: "none", ended: false };
  retire(state, cur, closeAt(cur, now), "manual");
  const kept = state.sessions.includes(cur);
  if (kept && note) cur.note = cleanText(NOTE_MAX).parse(note);
  return { changed: true, current: kept ? cur : latest(state), action: "ended", ended: kept };
}

/** The player's note on a session. */
export function setNote(state: StoreState, id: string, note: string, now: number): boolean {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return false;
  s.note = cleanText(NOTE_MAX).parse(note);
  s.updated_at = iso(now);
  return true;
}

export type { Trip };

/** True when `ensureCurrent` would change something (no clone needed to know). */
export function needsEnsure(state: StoreState, now: number, cfg: ReduceConfig): boolean {
  const cur = latest(state);
  return !cur || now - quietSince(cur) > cfg.gapMs;
}

/**
 * A copy that is safe for the functions of this file to change: they only ever modify the LAST session and the list
 * itself (push, pop) and the counter, so the other sessions are shared, not copied. Cheap for a long history.
 */
export function cloneLight(state: StoreState): StoreState {
  const last = state.sessions[state.sessions.length - 1];
  return {
    ...state,
    sessions: last ? [...state.sessions.slice(0, -1), structuredClone(last)] : [],
  };
}
