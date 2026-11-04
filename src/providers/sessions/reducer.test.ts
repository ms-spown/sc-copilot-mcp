import { describe, expect, it } from "vitest";
import {
  endCurrent,
  HEARTBEAT_MS,
  isEmpty,
  isLeftover,
  isUntouched,
  manageSession,
  latest,
  needsTidy,
  observe,
  startNew,
  tidy,
  type Observation,
  type ReduceConfig,
} from "./reducer.js";
import { session as makeSession } from "./fixtures.testing.js";
import { emptyState, type TripInput } from "./types.js";

/** Feature: the life of a session (start, resume, end) is decided by pure functions over the file's state. */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
let seq = 0;
const cfg: ReduceConfig = { gapMs: 3 * HOUR, newId: () => `s_test_${++seq}` };

const obs = (over: Partial<Observation> & { now: number }): Observation => ({
  running: true,
  balance: null,
  freshStart: false,
  connection: null,
  game: null,
  trips: [],
  context: null,
  ...over,
});

const trip = (n: number, endMs: number, net: number | null = 1000): TripInput => ({
  key: `abcdef${n.toString(16).padStart(6, "0")}`,
  kind: "hauling",
  source: "contract_ledger",
  started_at: new Date(endMs - 10 * MIN).toISOString(),
  ended_at: new Date(endMs).toISOString(),
  label: `Trip ${n}`,
  commodity: "Quantanium",
  buy_terminal: "A",
  sell_terminal: "B",
  net_auec: net,
  net_kind: net === null ? null : "balance_delta",
});

describe("Feature: a session starts when the game is seen running", () => {
  it("Given no session, When the game is seen, Then session 1 is created with the balance seen as its start", () => {
    const s = emptyState();
    const r = observe(s, obs({ now: T0, balance: 500_000, freshStart: true }), cfg);
    expect(r.action).toBe("created");
    const cur = latest(s)!;
    expect(cur.number).toBe(1);
    expect(cur.start_balance).toBe(500_000);
    expect(cur.start_balance_quality).toBe("game_start");
    expect(cur.ended_at).toBeNull();
  });

  it("Given the server started watching late, Then the start balance is 'first_seen', and 'late' when adopted long after", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 100 }), cfg);
    expect(latest(s)!.start_balance_quality).toBe("first_seen");

    const t = emptyState();
    observe(t, obs({ now: T0, balance: null }), cfg);
    observe(t, obs({ now: T0 + 15_000, balance: null }), cfg); // seen playing, but no balance yet
    observe(t, obs({ now: T0 + 20 * MIN, balance: 777 }), cfg);
    expect(latest(t)!.start_balance).toBe(777);
    expect(latest(t)!.start_balance_quality).toBe("late");
  });

  it("Given the game is not running, Then nothing is created", () => {
    const s = emptyState();
    const r = observe(s, obs({ now: T0, running: false }), cfg);
    expect(r.changed).toBe(false);
    expect(s.sessions).toHaveLength(0);
  });
});

describe("Feature: the last session is resumed unless there was a long break", () => {
  it("Given a gap of 20 minutes without an end marker, Then the same session resumes and the gap is marked unclean", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000, freshStart: true }), cfg);
    const id = latest(s)!.id;
    const r = observe(s, obs({ now: T0 + 20 * MIN, balance: 1000 }), cfg);
    expect(r.action).toBe("resumed");
    expect(latest(s)!.id).toBe(id);
    expect(s.sessions).toHaveLength(1);
    expect(latest(s)!.interruptions).toEqual([
      {
        from: new Date(T0).toISOString(),
        to: new Date(T0 + 20 * MIN).toISOString(),
        kind: "unclean",
      },
    ]);
    // The gap is not played time.
    expect(latest(s)!.active_ms).toBe(0);
    expect(latest(s)!.start_balance).toBe(1000);
  });

  it("Given the game wrote its quit line, Then the break is 'game_closed'", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    const quit = new Date(T0 + 2 * MIN).toISOString();
    observe(
      s,
      obs({ now: T0 + 2 * MIN, running: false, connection: { state: "closed", since: quit } }),
      cfg,
    );
    expect(latest(s)!.quit_at).toBe(quit);
    observe(s, obs({ now: T0 + 40 * MIN, balance: 1 }), cfg);
    expect(latest(s)!.interruptions[0].kind).toBe("game_closed");
    expect(latest(s)!.quit_at).toBeNull();
  });

  it("Given a break longer than the gap, Then the old session is closed at its last sighting and a new one starts", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1, freshStart: true }), cfg);
    observe(s, obs({ now: T0 + HOUR / 2, balance: 5 }), cfg);
    const lastSeen = latest(s)!.last_activity_at;
    observe(s, obs({ now: T0 + 5 * HOUR, balance: 9, freshStart: true }), cfg);
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0].ended_at).toBe(lastSeen);
    expect(s.sessions[0].end_reason).toBe("gap");
    expect(latest(s)!.number).toBe(2);
    expect(latest(s)!.start_balance).toBe(9);
  });

  it("Given the gap is exactly the threshold, Then the session is still resumed (the threshold is the limit, not past it)", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    observe(s, obs({ now: T0 + 3 * HOUR, balance: 1 }), cfg);
    expect(s.sessions).toHaveLength(1);
    observe(s, obs({ now: T0 + 6 * HOUR + 1, balance: 1 }), cfg);
    expect(s.sessions).toHaveLength(2);
  });
});

describe("Feature: active time counts only what was seen", () => {
  it("Given calls closer than the heartbeat, Then nothing changes; at the heartbeat, the time is added once", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    expect(observe(s, obs({ now: T0 + 5000, balance: 1 }), cfg).changed).toBe(false);
    expect(observe(s, obs({ now: T0 + HEARTBEAT_MS, balance: 1 }), cfg).changed).toBe(true);
    expect(latest(s)!.active_ms).toBe(HEARTBEAT_MS);
  });

  it("Given a stalled server (60 s hole), Then at most 60 s is credited", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    observe(s, obs({ now: T0 + 80_000, balance: 1 }), cfg);
    expect(latest(s)!.active_ms).toBe(60_000);
    expect(latest(s)!.interruptions).toHaveLength(0);
  });
});

describe("Feature: the player can end a session and start another", () => {
  it("Given an ended session, When the game keeps running, Then it is not reopened or recorded", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000, freshStart: true }), cfg);
    observe(s, obs({ now: T0 + MIN, balance: 1500 }), cfg);
    const e = endCurrent(s, T0 + 2 * MIN);
    expect(e.ended).toBe(true);
    expect(latest(s)!.end_reason).toBe("manual");
    const r = observe(s, obs({ now: T0 + 3 * MIN, balance: 2000 }), cfg);
    expect(r.action).toBe("held");
    expect(s.sessions).toHaveLength(1);
    expect(latest(s)!.last_balance).toBe(1500);
  });

  it("Given an ended session, When a new play period begins (fresh start), Then a new session starts", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    endCurrent(s, T0 + MIN);
    observe(s, obs({ now: T0 + 30 * MIN, balance: 1500, freshStart: true }), cfg);
    expect(s.sessions).toHaveLength(2);
  });

  it("Given an ended session, When the log shows a server join after the end, Then a new session starts", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000 }), cfg);
    endCurrent(s, T0 + MIN);
    const since = new Date(T0 + 10 * MIN).toISOString();
    observe(
      s,
      obs({ now: T0 + 11 * MIN, balance: 1, connection: { state: "online", since } }),
      cfg,
    );
    expect(s.sessions).toHaveLength(2);
  });

  it("Given 'Nouvelle session' with a known balance, Then the old one is closed and the new one starts from that balance", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 100, freshStart: true }), cfg);
    observe(s, obs({ now: T0 + MIN, balance: 150 }), cfg);
    startNew(s, T0 + 2 * MIN, cfg, 150, "  second   run ");
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0].end_reason).toBe("new_session");
    expect(s.sessions[0].ended_at).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(latest(s)!.start_balance).toBe(150);
    expect(latest(s)!.start_balance_quality).toBe("new_session");
    expect(latest(s)!.note).toBe("second run");
  });

  it("Given 'Nouvelle session' twice in a row, Then the empty one is renewed (no pile of empty sessions)", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 100 }), cfg);
    startNew(s, T0 + MIN, cfg, null);
    startNew(s, T0 + 2 * MIN, cfg, null);
    startNew(s, T0 + 3 * MIN, cfg, null);
    expect(s.sessions).toHaveLength(2);
    expect(latest(s)!.number).toBe(2);
  });

  it("Given no open session, When ending, Then it says nothing was ended", () => {
    const s = emptyState();
    expect(endCurrent(s, T0).ended).toBe(false);
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    endCurrent(s, T0 + MIN);
    expect(endCurrent(s, T0 + 2 * MIN).ended).toBe(false);
  });

  it("Given a clock that went backwards, Then a manual end (or a new session) never ends the session before its last sighting", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    observe(s, obs({ now: T0 + HEARTBEAT_MS, balance: 1 }), cfg);
    const last = latest(s)!.last_activity_at;
    endCurrent(s, T0 - HOUR);
    expect(latest(s)!.ended_at).toBe(last);
    const t = emptyState();
    observe(t, obs({ now: T0, balance: 1 }), cfg);
    observe(t, obs({ now: T0 + HEARTBEAT_MS, balance: 1 }), cfg);
    startNew(t, T0 - HOUR, cfg, null);
    expect(t.sessions[0].ended_at).toBe(t.sessions[0].last_activity_at);
  });

  it("Given a session left for an hour and closed by hand, Then it ends at its last sighting, not at the click", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    endCurrent(s, T0 + 2 * HOUR);
    expect(latest(s)!.ended_at).toBe(new Date(T0).toISOString());
  });
});

/** The states a player can find the card in, built by the same functions the server uses (plus the legacy file). */
const STATES = {
  /** No session at all. */
  none: () => emptyState(),
  /** A chronometer the player started: empty, timed from the click, the game never seen. */
  timing: () => {
    const s = emptyState();
    startNew(s, T0, cfg, null);
    return s;
  },
  /** An empty session an older server made when the dashboard opened (no `started_by`): the 16:03 ghost. */
  ghost: () => {
    const s = emptyState();
    s.sessions.push(
      makeSession(1, {
        start_balance: null,
        start_balance_at: null,
        start_balance_quality: null,
        last_balance: null,
        last_balance_at: null,
        started_at: new Date(T0).toISOString(),
        last_activity_at: new Date(T0).toISOString(),
      }),
    );
    s.next_number = 2;
    return s;
  },
  /** Started by the game (seen running), with a trip and a balance. */
  active: () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1000, freshStart: true, trips: [trip(1, T0 + MIN)] }), cfg);
    observe(s, obs({ now: T0 + HEARTBEAT_MS, balance: 1200 }), cfg);
    return s;
  },
  ended: () => {
    const s = STATES.active();
    endCurrent(s, T0 + 2 * MIN);
    return s;
  },
};
const summary = (s: ReturnType<typeof emptyState>) =>
  s.sessions.map((x) => `${x.number}:${x.ended_at === null ? "open" : (x.end_reason ?? "ended")}`);

describe("Feature: opening the dashboard never makes a session", () => {
  it("Given no session, When the dashboard is polled at any time, Then nothing is made", () => {
    const s = STATES.none();
    for (const wait of [0, MIN, 4 * HOUR, 100 * HOUR]) {
      expect(needsTidy(s, T0 + wait, cfg)).toBe(false);
      expect(tidy(s, T0 + wait, cfg).changed).toBe(false);
    }
    expect(s.sessions).toEqual([]);
  });

  it("Given the ghost of an older server (empty, nobody asked for it), Then it is deleted, its number given back, and nothing is archived", () => {
    const s = STATES.ghost();
    expect(isLeftover(latest(s)!)).toBe(true);
    expect(needsTidy(s, T0 + MIN, cfg)).toBe(true);
    const r = tidy(s, T0 + MIN, cfg);
    expect([r.changed, r.action]).toEqual([true, "discarded"]);
    expect(s.sessions).toEqual([]);
    expect(s.next_number).toBe(1);
    expect(tidy(s, T0 + 2 * MIN, cfg).changed).toBe(false);
  });

  it("Given the ghost, When the game is seen (or any look), Then it is deleted first and the game starts a real session of its own", () => {
    const s = STATES.ghost();
    const r = observe(s, obs({ now: T0 + 10 * MIN, balance: 4000, freshStart: true }), cfg);
    expect(r.action).toBe("created");
    expect(summary(s)).toEqual(["1:open"]);
    expect(latest(s)!.started_by).toBe("game");
    expect(latest(s)!.started_at).toBe(new Date(T0 + 10 * MIN).toISOString());
    const t = STATES.ghost();
    expect(observe(t, obs({ now: T0 + MIN, running: false }), cfg).action).toBe("discarded");
    expect(t.sessions).toEqual([]);
  });

  it("Given sessions that hold something, Then no look ever drops them, whatever the wait", () => {
    const s = STATES.active();
    const before = JSON.stringify(s.sessions[0].trips);
    tidy(s, T0 + 50 * HOUR, cfg); // closed as a gap, kept
    expect(summary(s)).toEqual(["1:gap"]);
    expect(JSON.stringify(s.sessions[0].trips)).toBe(before);
    const g = STATES.ended();
    expect(tidy(g, T0 + 500 * HOUR, cfg).changed).toBe(false);
    expect(summary(g)).toEqual(["1:manual"]);
    // A session the game started with nothing in it yet (a first look, before the first heartbeat) is not a ghost.
    const fresh = emptyState();
    observe(fresh, obs({ now: T0, balance: null }), cfg);
    expect(isEmpty(latest(fresh)!)).toBe(false);
    expect(needsTidy(fresh, T0 + 5_000, cfg)).toBe(false);
  });
});

describe("Feature: the player starts a session at ANY time", () => {
  it("Given no session, Then 'Démarrer' makes a timed session from the click, even with the game closed", () => {
    const s = STATES.none();
    const r = startNew(s, T0, cfg, null);
    expect([r.changed, r.action]).toEqual([true, "created"]);
    const cur = latest(s)!;
    expect([cur.number, cur.started_by, cur.started_at]).toEqual([
      1,
      "player",
      new Date(T0).toISOString(),
    ]);
    expect(isEmpty(cur)).toBe(true);
    expect(isLeftover(cur)).toBe(false);
  });

  it("Given a chronometer that holds nothing, Then 'Redémarrer le chrono' puts its start at now: same session, same number, nothing closed", () => {
    const s = STATES.timing();
    const id = latest(s)!.id;
    const r = startNew(s, T0 + 7 * MIN, cfg, null, " for the evening ");
    expect([r.changed, r.action]).toEqual([true, "restarted"]);
    expect(latest(s)!.id).toBe(id);
    expect(latest(s)!.started_at).toBe(new Date(T0 + 7 * MIN).toISOString());
    expect(latest(s)!.note).toBe("for the evening");
    expect(summary(s)).toEqual(["1:open"]);
  });

  it("Given a session in progress, Then 'Nouvelle session' closes it into the history and starts a timed one; an ended session is not closed twice", () => {
    const a = STATES.active();
    startNew(a, T0 + 5 * MIN, cfg, 1300);
    expect(summary(a)).toEqual(["1:new_session", "2:open"]);
    expect(latest(a)!.started_by).toBe("player");
    expect(latest(a)!.start_balance).toBe(1300);
    const e = STATES.ended();
    const endedAt = latest(e)!.ended_at;
    startNew(e, T0 + 30 * MIN, cfg, null);
    expect(summary(e)).toEqual(["1:manual", "2:open"]);
    expect(e.sessions[0].ended_at).toBe(endedAt);
  });

  it("Given a ghost, Then 'Démarrer' replaces it by a session of the player's, number 1 again", () => {
    const s = STATES.ghost();
    startNew(s, T0 + MIN, cfg, null);
    expect(summary(s)).toEqual(["1:open"]);
    expect(latest(s)!.started_by).toBe("player");
  });

  it("Given a chronometer, When the game starts later, Then the timer is NOT reset, the wait is no interruption, and the balance is adopted", () => {
    const s = STATES.timing();
    const r = observe(s, obs({ now: T0 + 40 * MIN, balance: 9000, freshStart: true }), cfg);
    expect(r.action).toBe("started");
    const cur = latest(s)!;
    expect(cur.started_at).toBe(new Date(T0).toISOString());
    expect(cur.interruptions).toEqual([]);
    expect(cur.start_balance).toBe(9000);
    expect(cur.start_balance_quality).toBe("game_start");
    expect(cur.started_by).toBe("player");
    expect(summary(s)).toEqual(["1:open"]);
    // A chronometer the game never filled is not closed by the 3 hour gap: only the player ends it, or 24 h without activity.
    const t = STATES.timing();
    expect(tidy(t, T0 + 20 * HOUR, cfg).changed).toBe(false);
    expect(needsTidy(t, T0 + 20 * HOUR, cfg)).toBe(false);
    observe(t, obs({ now: T0 + 20 * HOUR, balance: 5, freshStart: true }), cfg);
    expect(t.sessions[0].started_at).toBe(new Date(T0).toISOString());
    expect(summary(t)).toEqual(["1:open"]);
  });

  it("Given a chronometer untouched for 24 hours, Then tidy deletes it; and the game first seen after that long starts it at now, not at the old click", () => {
    const s = STATES.timing();
    expect(needsTidy(s, T0 + 24 * HOUR - MIN, cfg)).toBe(false);
    expect(needsTidy(s, T0 + 24 * HOUR + MIN, cfg)).toBe(true);
    expect(tidy(s, T0 + 24 * HOUR + MIN, cfg).action).toBe("discarded");
    expect(s.sessions).toEqual([]);
    const t = STATES.timing();
    const late = T0 + 30 * HOUR;
    const r = observe(t, obs({ now: late, balance: 70, freshStart: true }), cfg);
    expect(r.action).toBe("restarted");
    expect(summary(t)).toEqual(["1:open"]);
    expect(latest(t)!.started_at).toBe(new Date(late).toISOString());
    expect(latest(t)!.start_balance).toBe(70);
    expect(latest(t)!.start_balance_quality).not.toBe("late");
    // A chronometer whose game played (not untouched) is a real session: no expiry.
    const played = STATES.timing();
    latest(played)!.active_ms = 5 * MIN; // the game was played for a while
    expect(needsTidy(played, T0 + 20 * HOUR, cfg)).toBe(true); // closed by the gap as any session, not deleted
    tidy(played, T0 + 20 * HOUR, cfg);
    expect(summary(played)).toEqual(["1:gap"]);
  });
});

describe("Feature: a session the player started while the game RUNS (it has a start balance)", () => {
  /** A session started by the click with a fresh balance: the player's, holding nothing, barely played. */
  const running = () => {
    const s = emptyState();
    startNew(s, T0, cfg, 5000);
    return s;
  };

  it("Given an untouched session with a balance, Then 'Nouvelle session' restarts it (new start, new balance): no junk sessions pile up", () => {
    const s = running();
    expect(isEmpty(latest(s)!)).toBe(false); // it has a balance, so it is not "never seen"...
    expect(isUntouched(latest(s)!)).toBe(true); // ...but it holds nothing: restartable
    for (let i = 1; i <= 4; i++) {
      const r = startNew(s, T0 + i * 20_000, cfg, 5000 + i);
      expect(r.action).toBe("restarted");
    }
    expect(summary(s)).toEqual(["1:open"]);
    expect(latest(s)!.started_at).toBe(new Date(T0 + 80_000).toISOString());
    expect(latest(s)!.start_balance).toBe(5004);
    expect(latest(s)!.active_ms).toBe(0);
  });

  it("Given an untouched session with a balance, Then 'Terminer' deletes it (the game closed)", () => {
    const s = running();
    const e = endCurrent(s, T0 + 20_000);
    expect([e.ended, e.reason]).toEqual([false, "discarded"]);
    expect(s.sessions).toEqual([]);
  });

  it("Given a session played for 2 minutes or holding a note, a trip, a loss or a refused price, Then it is a real session: 'Terminer' ends it by hand, 'Nouvelle' closes it", () => {
    const real: Array<[string, (x: ReturnType<typeof emptyState>) => void]> = [
      ["played", (x) => void (latest(x)!.active_ms = 2 * MIN)],
      ["note", (x) => void (latest(x)!.note = "for the crew")],
      ["refusal", (x) => void (latest(x)!.price_refusals = 1)],
      [
        "loss",
        (x) =>
          void latest(x)!.ship_losses.push({
            at: new Date(T0 + 10_000).toISOString(),
            ship_class: null,
            cause: "unknown",
            causer: "unknown",
            zone: null,
            cargo_scu: null,
            cargo_paid_auec: null,
          }),
      ],
    ];
    for (const [name, touch] of real) {
      const a = running();
      touch(a);
      expect(isUntouched(latest(a)!), name).toBe(false);
      expect(endCurrent(a, T0 + 3 * MIN).reason, name).toBe("ended");
      expect(summary(a), name).toEqual(["1:manual"]);
      const b = running();
      touch(b);
      startNew(b, T0 + 3 * MIN, cfg, 1);
      expect(summary(b), name).toEqual(["1:new_session", "2:open"]);
    }
    // A trip makes it real too.
    const t = running();
    observe(t, obs({ now: T0 + 30_000, balance: 5100, trips: [trip(1, T0 + 20_000)] }), cfg);
    expect(isUntouched(latest(t)!)).toBe(false);
    expect(endCurrent(t, T0 + MIN).reason).toBe("ended");
  });

  it("Given the game running and no earlier session ended by hand, Then 'Terminer' keeps the chronometer as ended (a deleted one would come back by itself); with one ended by hand it is deleted", () => {
    const first = running();
    const a = endCurrent(first, T0 + 20_000, undefined, { gameRunning: true });
    expect([a.ended, a.reason]).toEqual([true, "ended"]);
    expect(summary(first)).toEqual(["1:manual"]);
    // And it does not come back: the game is seen, the session ended by hand holds.
    expect(
      observe(first, obs({ now: T0 + 40_000, balance: 5, freshStart: false }), cfg).action,
    ).toBe("held");
    // An earlier session ended by gap (not by hand): the game would start another by itself.
    const gap = STATES.active();
    tidy(gap, T0 + 5 * HOUR, cfg);
    startNew(gap, T0 + 5 * HOUR + MIN, cfg, 9);
    endCurrent(gap, T0 + 5 * HOUR + 2 * MIN, undefined, { gameRunning: true });
    expect(summary(gap)).toEqual(["1:gap", "2:manual"]);
    // An earlier session ended by hand: deleting is safe, and it is deleted.
    const hand = STATES.ended();
    startNew(hand, T0 + HOUR, cfg, 9);
    const d = endCurrent(hand, T0 + HOUR + 20_000, undefined, { gameRunning: true });
    expect(d.reason).toBe("discarded");
    expect(summary(hand)).toEqual(["1:manual"]);
    // With the game closed, an empty chronometer is always deleted.
    const closed = STATES.timing();
    expect(endCurrent(closed, T0 + MIN, undefined, { gameRunning: false }).reason).toBe(
      "discarded",
    );
  });
});

describe("Feature: an older (2.7.0) file", () => {
  const legacyEmpty = (
    n: number,
    startedAt: number,
    over: Partial<Parameters<typeof makeSession>[1]> = {},
  ) =>
    makeSession(n, {
      start_balance: null,
      start_balance_at: null,
      start_balance_quality: null,
      last_balance: null,
      last_balance_at: null,
      started_at: new Date(startedAt).toISOString(),
      last_activity_at: new Date(startedAt).toISOString(),
      ...over,
    });

  it("Given an empty session with no started_by right after a session closed by 'new_session', Then it is the old 'Nouvelle session' click: adopted as the player's, not deleted", () => {
    const s = emptyState();
    const closedAt = T0 + 30 * MIN;
    s.sessions.push(
      makeSession(1, {
        ended_at: new Date(closedAt).toISOString(),
        end_reason: "new_session",
        active_ms: 5 * MIN,
      }),
      legacyEmpty(2, closedAt + 20_000),
    );
    s.next_number = 3;
    expect(needsTidy(s, closedAt + MIN, cfg)).toBe(true);
    const r = tidy(s, closedAt + MIN, cfg);
    expect(r.action).toBe("adopted");
    expect(latest(s)!.started_by).toBe("player");
    expect(summary(s)).toEqual(["1:new_session", "2:open"]);
    // Adopted once: the next look changes nothing.
    expect(tidy(s, closedAt + 2 * MIN, cfg).changed).toBe(false);
  });

  it("Given an empty session with no started_by that does NOT follow such a click (or follows it by far), Then it is a ghost and is deleted", () => {
    const a = emptyState();
    a.sessions.push(
      makeSession(1, { ended_at: new Date(T0).toISOString(), end_reason: "new_session" }),
      legacyEmpty(2, T0 + 10 * MIN),
    );
    expect(tidy(a, T0 + 11 * MIN, cfg).action).toBe("discarded");
    expect(summary(a)).toEqual(["1:new_session"]);
    const b = emptyState();
    b.sessions.push(
      makeSession(1, { ended_at: new Date(T0).toISOString(), end_reason: "gap" }),
      legacyEmpty(2, T0 + 20_000),
    );
    expect(tidy(b, T0 + MIN, cfg).action).toBe("discarded");
  });

  it("Given an empty session with no started_by and a note, Then it is never deleted (it holds a note: a real session)", () => {
    const s = emptyState();
    s.sessions.push(legacyEmpty(1, T0, { note: "my evening" }));
    s.next_number = 2;
    expect(needsTidy(s, T0 + MIN, cfg)).toBe(false);
    expect(tidy(s, T0 + MIN, cfg).changed).toBe(false);
    expect(observe(s, obs({ now: T0 + 2 * MIN, running: false }), cfg).changed).toBe(false);
    expect(latest(s)!.note).toBe("my evening");
  });
});

describe("Feature: ending", () => {
  it("Given no session, Then ending says there is none", () => {
    const s = STATES.none();
    const e = endCurrent(s, T0);
    expect([e.ended, e.reason, e.changed]).toEqual([false, "none", false]);
  });

  it("Given a chronometer that holds nothing, Then 'Terminer' deletes it (nothing to archive) and gives the number back", () => {
    const s = STATES.timing();
    const e = endCurrent(s, T0 + MIN);
    expect([e.ended, e.reason, e.changed]).toEqual([false, "discarded", true]);
    expect(s.sessions).toEqual([]);
    expect(s.next_number).toBe(1);
    // Deleting twice is not an error: there is simply none.
    expect(endCurrent(s, T0 + 2 * MIN).reason).toBe("none");
  });

  it("Given a session in progress, Then ending closes it by hand and keeps it", () => {
    const a = STATES.active();
    const e = endCurrent(a, T0 + 5 * MIN);
    expect([e.ended, e.reason, e.changed]).toEqual([true, "ended", true]);
    expect(summary(a)).toEqual(["1:manual"]);
  });

  it("Given an ended session, Then ending again says it was already ended and changes nothing", () => {
    const s = STATES.ended();
    const e = endCurrent(s, T0 + 10 * MIN);
    expect([e.ended, e.reason, e.changed]).toEqual([false, "already_ended", false]);
    expect(summary(s)).toEqual(["1:manual"]);
  });

  it("Given a session in progress quiet for longer than the gap, Then the look closes it as a gap and makes NO session", () => {
    const s = STATES.active();
    expect(needsTidy(s, T0 + 5 * HOUR, cfg)).toBe(true);
    const r = tidy(s, T0 + 5 * HOUR, cfg);
    expect(r.action).toBe("closed");
    expect(summary(s)).toEqual(["1:gap"]);
  });
});

describe("Feature: the game starts a session by itself, and an ended one stays ended", () => {
  it("Given no session, When the game is launched and connected, Then one starts with the game's balance, marked as the game's", () => {
    const s = STATES.none();
    observe(s, obs({ now: T0, balance: 500, freshStart: true }), cfg);
    expect(summary(s)).toEqual(["1:open"]);
    expect(latest(s)!.started_by).toBe("game");
    expect(latest(s)!.start_balance_quality).toBe("game_start");
  });

  it("Given a session ended by gap, When the game is seen, Then a new one starts by itself", () => {
    const s = STATES.active();
    tidy(s, T0 + 5 * HOUR, cfg);
    observe(s, obs({ now: T0 + 5 * HOUR + MIN, balance: 7 }), cfg);
    expect(summary(s)).toEqual(["1:gap", "2:open"]);
  });

  it("Given an ended session and the game still running, Then looks hold (nothing recorded) even when the balance reappears after a restart", () => {
    const s = STATES.ended();
    const ended = latest(s)!.ended_at!;
    const joined = new Date(Date.parse(ended) - HOUR).toISOString(); // the join that is already behind us
    for (const [at, freshStart] of [
      [T0 + 3 * MIN, false],
      [T0 + 4 * MIN, true], // a restarted server sees its first balance late: not a new play period
    ] as const) {
      const r = observe(
        s,
        obs({ now: at, balance: 5, freshStart, connection: { state: "online", since: joined } }),
        cfg,
      );
      expect(r.action).toBe("held");
    }
    expect(observe(s, obs({ now: T0 + HOUR, running: false }), cfg).action).toBe("held");
    expect(summary(s)).toEqual(["1:manual"]);
  });

  it("Given an ended session, When the game is started again, Then a new session starts (by the log, or by the balance when the log says nothing)", () => {
    const viaLog = STATES.ended();
    const since = new Date(T0 + 20 * MIN).toISOString();
    observe(
      viaLog,
      obs({ now: T0 + 21 * MIN, balance: 9, connection: { state: "menu", since } }),
      cfg,
    );
    expect(summary(viaLog)).toEqual(["1:manual", "2:open"]);
    const noLog = STATES.ended();
    observe(noLog, obs({ now: T0 + 21 * MIN, balance: 9, freshStart: true }), cfg);
    expect(summary(noLog)).toEqual(["1:manual", "2:open"]);
    const unknownLog = STATES.ended();
    observe(
      unknownLog,
      obs({
        now: T0 + 21 * MIN,
        balance: 9,
        freshStart: true,
        connection: { state: "unknown", since: null },
      }),
      cfg,
    );
    expect(summary(unknownLog)).toEqual(["1:manual", "2:open"]);
  });

  it("Given a chronometer the player started, When the game is launched, Then the player's session is kept (no second one)", () => {
    const s = STATES.timing();
    observe(
      s,
      obs({
        now: T0 + 3 * MIN,
        balance: 1,
        freshStart: true,
        connection: { state: "online", since: new Date(T0 + 2 * MIN).toISOString() },
      }),
      cfg,
    );
    expect(summary(s)).toEqual(["1:open"]);
  });

  it("Given a game that closes cleanly, Then the open session says so and resumes when the game is back", () => {
    const s = STATES.active();
    const quit = new Date(T0 + 5 * MIN).toISOString();
    observe(
      s,
      obs({ now: T0 + 5 * MIN, running: false, connection: { state: "closed", since: quit } }),
      cfg,
    );
    expect(latest(s)!.quit_at).toBe(quit);
    expect(latest(s)!.ended_at).toBeNull();
    observe(s, obs({ now: T0 + 40 * MIN, balance: 1300 }), cfg);
    expect(summary(s)).toEqual(["1:open"]);
    expect(latest(s)!.interruptions[0].kind).toBe("game_closed");
  });

  it("Given every state, Then a look 30 hours later and a repeated look change nothing more than the first one did", () => {
    for (const [name, make] of Object.entries(STATES)) {
      const s = make();
      tidy(s, T0 + 30 * HOUR, cfg);
      const once = JSON.stringify(s);
      const again = tidy(s, T0 + 30 * HOUR + MIN, cfg);
      expect(again.changed, name).toBe(false);
      expect(JSON.stringify(s), name).toBe(once);
    }
  });
});

describe("Feature: archive, unarchive and delete of one ended session (the Sessions view)", () => {
  /** Three sessions: 1 and 2 ended (by new_session and by hand), 3 in progress. */
  const three = () => {
    const s = STATES.active();
    startNew(s, T0 + 5 * MIN, cfg, 1300);
    latest(s)!.active_ms = 10 * MIN;
    latest(s)!.note = "real";
    endCurrent(s, T0 + 20 * MIN);
    startNew(s, T0 + 30 * MIN, cfg, 1400);
    return s;
  };
  const ids = (s: ReturnType<typeof emptyState>) => s.sessions.map((x) => x.id);

  it("Given an ended session, Then archive and unarchive flip a flag and keep everything else; asking twice changes nothing", () => {
    const s = three();
    const [a] = ids(s);
    const before = JSON.stringify(s.sessions[0].trips);
    const r = manageSession(s, a!, "archive", T0 + HOUR);
    expect([r.changed, r.reason]).toEqual([true, "done"]);
    expect(s.sessions[0].archived).toBe(true);
    expect(JSON.stringify(s.sessions[0].trips)).toBe(before);
    expect(manageSession(s, a!, "archive", T0 + HOUR).reason).toBe("unchanged");
    expect(manageSession(s, a!, "unarchive", T0 + HOUR).changed).toBe(true);
    expect(s.sessions[0].archived).toBe(false);
    expect(manageSession(s, a!, "unarchive", T0 + HOUR).reason).toBe("unchanged");
    expect(s.sessions).toHaveLength(3);
  });

  it("Given 'delete', Then the session is removed from the list for good and the others and the counter stay", () => {
    const s = three();
    const [a, b, c] = ids(s);
    const next = s.next_number;
    const r = manageSession(s, b!, "delete", T0 + HOUR);
    expect([r.changed, r.reason, r.session?.id]).toEqual([true, "done", b]);
    expect(ids(s)).toEqual([a, c]);
    expect(s.next_number).toBe(next);
    expect(manageSession(s, b!, "delete", T0 + HOUR).reason).toBe("not_found");
  });

  it("Given the session in progress, Then nothing is done to it, whatever the action", () => {
    const s = three();
    const open = latest(s)!;
    const before = JSON.stringify(s);
    for (const action of ["archive", "unarchive", "delete"] as const) {
      const r = manageSession(s, open.id, action, T0 + HOUR);
      expect([r.changed, r.reason]).toEqual([false, "open_session"]);
    }
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("Feature: trips are stored once, in the right session", () => {
  it("Given the same trips offered on every look, Then each is stored once (idempotent)", () => {
    const s = emptyState();
    const trips = [trip(1, T0 + 5 * MIN), trip(2, T0 + 9 * MIN, null)];
    observe(s, obs({ now: T0, balance: 1, trips }), cfg);
    const again = observe(s, obs({ now: T0 + 5000, balance: 1, trips }), cfg);
    expect(again.changed).toBe(false);
    expect(latest(s)!.trips.map((t) => t.label)).toEqual(["Trip 1", "Trip 2"]);
    expect(latest(s)!.trips[1].net_auec).toBeNull();
  });

  it("Given a trip that ended before the session began, Then it is not counted; given one stored in an older session, not again", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1, trips: [trip(1, T0 - HOUR), trip(2, T0 + MIN)] }), cfg);
    expect(latest(s)!.trips.map((t) => t.label)).toEqual(["Trip 2"]);
    startNew(s, T0 + 2 * MIN, cfg, null);
    observe(
      s,
      obs({ now: T0 + 3 * MIN, balance: 1, trips: [trip(2, T0 + MIN), trip(3, T0 + 3 * MIN)] }),
      cfg,
    );
    expect(latest(s)!.trips.map((t) => t.label)).toEqual(["Trip 3"]);
    expect(s.sessions[0].trips.map((t) => t.label)).toEqual(["Trip 2"]);
  });

  it("Given a malformed trip, Then it is ignored and the others are kept", () => {
    const s = emptyState();
    const bad = {
      key: "nothex!",
      kind: "hauling",
      source: "contract_ledger",
      ended_at: "?",
    } as unknown as TripInput;
    observe(s, obs({ now: T0, balance: 1, trips: [bad, trip(1, T0 + MIN)] }), cfg);
    expect(latest(s)!.trips).toHaveLength(1);
  });

  it("Given more trips than the bound, Then the newest are kept and the others counted", () => {
    const s = emptyState();
    const many = Array.from({ length: 520 }, (_, i) => trip(i + 1, T0 + (i + 1) * 1000));
    observe(s, obs({ now: T0, balance: 1, trips: many }), cfg);
    expect(latest(s)!.trips).toHaveLength(500);
    expect(latest(s)!.trips_dropped).toBe(20);
    expect(latest(s)!.trips[499].label).toBe("Trip 520");
  });

  it("Given text from the game with control characters, Then it is stored clean and capped", () => {
    const s = emptyState();
    const dirty = { ...trip(1, T0 + MIN), label: `A\u202eb\u0000${"x".repeat(200)}` };
    observe(s, obs({ now: T0, balance: 1, trips: [dirty] }), cfg);
    const label = latest(s)!.trips[0].label!;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(/[\p{Cc}\p{Cf}]/u.test(label)).toBe(false);
  });
});

describe("Feature: what the log says about the game is kept, bounded", () => {
  it("Given a version, a channel and a last place, Then they are stored; an unknown channel never overwrites a known one", () => {
    const s = emptyState();
    observe(
      s,
      obs({
        now: T0,
        balance: 1,
        game: { version: "4.10.2 (build 12881860)", channel: "live" },
        context: {
          location: "Port Tressler",
          commodity: "Agricium",
          at: new Date(T0).toISOString(),
        },
      }),
      cfg,
    );
    observe(s, obs({ now: T0 + 5000, game: { version: null, channel: "unknown" } }), cfg);
    const cur = latest(s)!;
    expect(cur.game_version).toBe("4.10.2 (build 12881860)");
    expect(cur.game_channel).toBe("live");
    expect(cur.last_location).toBe("Port Tressler");
    expect(cur.last_commodity).toBe("Agricium");
  });
});

describe("Feature: a clock that goes backwards does not freeze the session", () => {
  it("Given the clock goes back an hour, Then the delta is clamped, the last-seen clock follows, and the next heartbeat counts again", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    observe(s, obs({ now: T0 + HEARTBEAT_MS, balance: 1 }), cfg);
    const before = latest(s)!.active_ms;
    const back = T0 - HOUR;
    observe(s, obs({ now: back, balance: 1 }), cfg);
    expect(latest(s)!.active_ms).toBe(before); // nothing added, nothing negative
    expect(latest(s)!.last_activity_at).toBe(new Date(back).toISOString());
    observe(s, obs({ now: back + HEARTBEAT_MS, balance: 1 }), cfg);
    expect(latest(s)!.active_ms).toBe(before + HEARTBEAT_MS);
    expect(latest(s)!.interruptions).toEqual([]);
    expect(s.sessions).toHaveLength(1);
  });
});
