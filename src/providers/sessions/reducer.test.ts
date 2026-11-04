import { describe, expect, it } from "vitest";
import {
  endCurrent,
  ensureCurrent,
  HEARTBEAT_MS,
  isEmpty,
  latest,
  observe,
  startNew,
  type Observation,
  type ReduceConfig,
} from "./reducer.js";
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

  it("Given the dashboard is opened after a long break with an empty session, Then it is renewed, not piled up", () => {
    const s = emptyState();
    ensureCurrent(s, T0, cfg);
    expect(isEmpty(latest(s)!)).toBe(true);
    const r = ensureCurrent(s, T0 + 10 * HOUR, cfg);
    expect(r.action).toBe("renewed");
    expect(s.sessions).toHaveLength(1);
    expect(latest(s)!.started_at).toBe(new Date(T0 + 10 * HOUR).toISOString());
  });

  it("Given the dashboard is opened (empty session) and the game is launched 10 minutes later, Then the wait is not an interruption and the balance is a start, not a late one", () => {
    const s = emptyState();
    ensureCurrent(s, T0, cfg);
    const r = observe(s, obs({ now: T0 + 10 * MIN, balance: 4000, freshStart: true }), cfg);
    expect(r.action).toBe("started");
    const cur = latest(s)!;
    expect(cur.interruptions).toEqual([]);
    expect(cur.started_at).toBe(new Date(T0 + 10 * MIN).toISOString());
    expect(cur.start_balance_quality).toBe("game_start");
    // Same without a fresh start: first seen, never late.
    const t = emptyState();
    startNew(t, T0, cfg, null);
    observe(t, obs({ now: T0 + 25 * MIN, balance: 9 }), cfg);
    expect(latest(t)!.interruptions).toEqual([]);
    expect(latest(t)!.start_balance_quality).toBe("first_seen");
  });

  it("Given the dashboard is opened soon after a session, Then it attaches to it; after a long break it makes a new one", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    expect(ensureCurrent(s, T0 + HOUR, cfg).action).toBe("kept");
    expect(ensureCurrent(s, T0 + 4 * HOUR, cfg).action).toBe("created");
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0].end_reason).toBe("gap");
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

  it("Given a session left for an hour and closed by hand, Then it ends at its last sighting, not at the click", () => {
    const s = emptyState();
    observe(s, obs({ now: T0, balance: 1 }), cfg);
    endCurrent(s, T0 + 2 * HOUR);
    expect(latest(s)!.ended_at).toBe(new Date(T0).toISOString());
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
