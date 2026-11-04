import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionInfo } from "../gamelog/connectionState.js";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import { sessionsConfig } from "./config.js";
import { SessionManager, type ManagerDeps } from "./manager.js";
import { SessionStore } from "./store.js";
import type { TripCollection } from "./trips.js";
import type { TripInput } from "./types.js";

/**
 * Feature: the manager turns what the server sees into the session file. A fake telemetry, a fake clock and a
 * temporary folder: no game, no network, no real Game.log.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-mgr-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A telemetry stand-in the test drives, which counts what is asked of it. */
function fakeTelemetry(enabled = true) {
  const s = { state: "waiting" as TelemetryStatusReport["state"], balance: null as number | null };
  const calls = { status: 0, snapshot: 0, started: 0, stop: 0 };
  const telemetry: Telemetry = {
    enabled,
    status: async (start) => {
      calls.status += 1;
      if (start) calls.started += 1;
      return { state: s.state } as TelemetryStatusReport;
    },
    snapshot: async () => {
      calls.snapshot += 1;
      return s.balance === null
        ? null
        : ({ state: { pilot: { uec_balance: s.balance } } } as unknown as TelemetrySnapshot);
    },
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => {
      calls.stop += 1;
    },
  };
  return { telemetry, s, calls };
}

interface Rig {
  clock: { t: number };
  tel: ReturnType<typeof fakeTelemetry>;
  log: { running: boolean };
  conn: { info: ConnectionInfo };
  trips: { list: TripInput[] };
  manager: SessionManager;
  store: SessionStore;
}

function rig(over: Partial<ManagerDeps> = {}, enabled = true): Rig {
  const clock = { t: T0 };
  const tel = fakeTelemetry();
  const log = { running: false };
  const conn = {
    info: { state: "unknown", since: null, code: null, reason: null } as ConnectionInfo,
  };
  const trips = { list: [] as TripInput[] };
  const store = over.store ?? new SessionStore(file, { now: () => clock.t });
  let n = 0;
  const manager = new SessionManager({
    telemetry: tel.telemetry,
    store,
    config: { enabled, file, gapMs: 3 * HOUR },
    gameHint: async () => ({ running: log.running, telemetryRegistered: true }),
    connection: { current: async () => conn.info },
    trips: {
      collect: async (): Promise<TripCollection> => ({ trips: trips.list, context: null }),
    },
    now: () => clock.t,
    newId: () => `s_mgr_${++n}_${clock.t}`,
    ...over,
  });
  return { clock, tel, log, conn, trips, manager, store };
}

const stored = async (rig: Rig) => (await new SessionStore(rig.store.file).read()).sessions;

const playMinutes = async (r: Rig, minutes: number, balance: (m: number) => number) => {
  for (let m = 0; m < minutes; m++) {
    r.clock.t += MIN;
    r.tel.s.state = "live";
    r.tel.s.balance = balance(m);
    await r.manager.tick();
  }
};

describe("Feature: nothing is watched or written when telemetry or sessions are off", () => {
  it("Given telemetry off, Then ticking, poking and asking touch nothing and no file or folder is created", async () => {
    const r = rig({}, true);
    const off = fakeTelemetry(false);
    const manager = new SessionManager({
      telemetry: off.telemetry,
      store: r.store,
      config: { enabled: true, file, gapMs: HOUR },
      gameHint: async () => ({ running: true, telemetryRegistered: true }),
      now: () => r.clock.t,
    });
    manager.start();
    manager.poke();
    await manager.tick();
    const bar = await manager.bar(true);
    expect(bar.status).toBe("off");
    expect(bar.current).toBeNull();
    expect(off.calls).toEqual({ status: 0, snapshot: 0, started: 0, stop: 0 });
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    await manager.close();
  });

  it("Given SC_SESSIONS=off with telemetry on, Then the configuration is disabled and the manager does nothing", async () => {
    const cfg = sessionsConfig({ SC_SESSIONS: "off", SCMCP_SESSIONS_FILE: file }, true);
    expect(cfg.enabled).toBe(false);
    expect(sessionsConfig({ SC_SESSIONS: "0" }, true).enabled).toBe(false);
    expect(sessionsConfig({ SC_SESSIONS: "no" }, true).enabled).toBe(false);
    expect(sessionsConfig({}, true).enabled).toBe(true);
    expect(sessionsConfig({}, false).enabled).toBe(false);
    const r = rig({ config: cfg });
    r.log.running = true;
    await r.manager.tick();
    r.manager.poke();
    expect((await r.manager.bar(true)).status).toBe("off");
    expect(r.tel.calls.snapshot).toBe(0);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("Given the gap setting, Then it is read in hours within bounds and the default is 3 hours", () => {
    const hours = (v?: string) =>
      sessionsConfig(v ? { SC_SESSION_GAP_HOURS: v } : {}, true).gapMs / HOUR;
    expect(hours()).toBe(3);
    expect(hours("6")).toBe(6);
    expect(hours("0,5")).toBe(0.5);
    expect(hours("0")).toBe(3);
    expect(hours("500")).toBe(3);
    expect(hours("abc")).toBe(3);
  });
});

describe("Feature: the server watches from the start of the game, thriftily", () => {
  it("Given the game is not running, Then the telemetry is not touched at all (no reader started, lazy as before)", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.clock.t += 20_000;
      await r.manager.tick();
    }
    expect(r.tel.calls).toEqual({ status: 0, snapshot: 0, started: 0, stop: 0 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("Given Game.log turns fresh, Then the reader is kept alive and the balance seen first is the start balance (game_start)", async () => {
    const r = rig();
    await r.manager.tick(); // watching, game not there yet
    r.log.running = true;
    r.conn.info = { state: "online", since: new Date(T0).toISOString(), code: null, reason: null };
    await playMinutes(r, 3, () => 250_000);
    const [s] = await stored(r);
    expect(s.start_balance).toBe(250_000);
    expect(s.start_balance_quality).toBe("game_start");
    expect(r.tel.calls.snapshot).toBeGreaterThan(0);
    expect(r.tel.calls.stop).toBe(0); // the manager never stops the reader
    expect(s.active_ms).toBeGreaterThan(0);
  });

  it("Given the server started after the game was already in flight, Then the start balance is 'first_seen'", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 1, () => 900);
    expect((await stored(r))[0].start_balance_quality).toBe("first_seen");
  });

  it("Given no Game.log and nobody looking, Then the manager does not probe the telemetry on a timer", async () => {
    const r = rig({ gameHint: async () => null });
    for (let i = 0; i < 10; i++) {
      r.clock.t += 20_000;
      await r.manager.tick();
    }
    expect(r.tel.calls.status + r.tel.calls.snapshot).toBe(0);
  });

  it("Given no Game.log but a dashboard poll, When the stream is live, Then the session is recorded", async () => {
    const r = rig({ gameHint: async () => null });
    r.tel.s.state = "live";
    r.tel.s.balance = 4242;
    r.manager.poke();
    await r.manager.tick();
    await r.manager.bar(false);
    expect((await stored(r))[0].start_balance).toBe(4242);
  });
});

describe("Feature: a crash or a reboot loses at most the last checkpoint", () => {
  it("Given a server killed in the middle of a session, Then a new process finds the session as of the last checkpoint", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 10, (m) => 1000 + m * 100);
    const beforeKill = (await stored(r))[0];
    expect(beforeKill.last_balance).toBe(1900);
    // The process dies here: no close(), no flush. Some more play happened in memory only (not applicable: every
    // change is written at once; only the heartbeat is throttled).
    const rebooted = rig({ store: new SessionStore(file) });
    rebooted.clock.t = r.clock.t + 5000;
    const bar = await rebooted.manager.bar(true);
    expect(bar.current?.number).toBe(1);
    expect(bar.current?.money).toMatchObject({ start_balance_auec: 1000, last_balance_auec: 1900 });
    // At most one heartbeat (15 s) of "last seen" can be missing.
    const lastSeen = Date.parse(beforeKill.last_activity_at);
    expect(r.clock.t - lastSeen).toBeLessThanOrEqual(15_000);
  });

  it("Given a reboot of the PC 40 minutes later, Then the same session resumes with the break marked as unclean", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 5, () => 5000);
    r.log.running = false;
    r.tel.s.state = "waiting";
    r.tel.s.balance = null;
    r.clock.t += 40 * MIN;
    const after = rig({ store: new SessionStore(file) });
    after.clock.t = r.clock.t;
    after.log.running = true;
    await playMinutes(after, 2, () => 5300);
    const all = await stored(after);
    expect(all).toHaveLength(1);
    expect(all[0].interruptions).toHaveLength(1);
    expect(all[0].interruptions[0].kind).toBe("unclean");
    expect(all[0].start_balance).toBe(5000);
    expect(all[0].last_balance).toBe(5300);
  });

  it("Given a reboot 5 hours later, Then a new session starts and the old one is closed at its last sighting", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 5, () => 5000);
    const lastSeen = (await stored(r))[0].last_activity_at;
    const after = rig({ store: new SessionStore(file) });
    after.clock.t = r.clock.t + 5 * HOUR;
    after.log.running = true;
    await playMinutes(after, 1, () => 5100);
    const all = await stored(after);
    expect(all.map((s) => s.number)).toEqual([1, 2]);
    expect(all[0].ended_at).toBe(lastSeen);
    expect(all[1].start_balance).toBe(5100);
  });

  it("Given the game quits cleanly and comes back within the gap, Then the session resumes and the break is 'game_closed'", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 4, () => 700);
    r.conn.info = {
      state: "closed",
      since: new Date(r.clock.t).toISOString(),
      code: null,
      reason: null,
    };
    r.log.running = true; // the log was just written (the quit line): the manager must not count that as running
    await r.manager.tick();
    expect((await stored(r))[0].quit_at).not.toBeNull();
    r.log.running = false;
    r.clock.t += 25 * MIN;
    r.conn.info = {
      state: "online",
      since: new Date(r.clock.t).toISOString(),
      code: null,
      reason: null,
    };
    r.log.running = true;
    await playMinutes(r, 1, () => 700);
    const [s] = await stored(r);
    expect(s.interruptions.map((i) => i.kind)).toEqual(["game_closed"]);
  });
});

describe("Feature: two server processes watching the same game agree", () => {
  it("Given two managers on one file ticking alternately, Then there is one session and the time is not counted twice", async () => {
    const clock = { t: T0 };
    const storeA = new SessionStore(file, { now: () => clock.t });
    const storeB = new SessionStore(file, { now: () => clock.t });
    const a = rig({ store: storeA });
    const b = rig({ store: storeB });
    for (const x of [a, b]) {
      x.log.running = true;
      x.tel.s.state = "live";
      x.tel.s.balance = 123;
    }
    for (let i = 0; i < 20; i++) {
      clock.t += 15_000;
      a.clock.t = b.clock.t = clock.t;
      await Promise.all([a.manager.tick(), b.manager.tick()]);
    }
    const all = await stored(a);
    expect(all).toHaveLength(1);
    // 20 ticks of 15 s = 5 minutes of play: never more than that, even with two processes.
    expect(all[0].active_ms).toBeLessThanOrEqual(5 * MIN);
    expect(all[0].active_ms).toBeGreaterThan(3 * MIN);
  });
});

describe("Feature: trips are recorded once with their result", () => {
  const trip = (n: number, endMs: number, net: number | null): TripInput => ({
    key: `00000000000000${n.toString(16).padStart(2, "0")}`,
    kind: "hauling",
    source: "contract_ledger",
    started_at: new Date(endMs - 8 * MIN).toISOString(),
    ended_at: new Date(endMs).toISOString(),
    label: `Run ${n}`,
    commodity: "Agricium",
    buy_terminal: "Area18",
    sell_terminal: "Port Olisar",
    net_auec: net,
    net_kind: net === null ? null : "balance_delta",
  });

  it("Given trips offered at every look, Then the file holds each once, and the plan marks the matching goods", async () => {
    const r = rig();
    r.log.running = true;
    r.manager.setPlan({ commodity: "agricium", expected_profit_auec: 20_000 });
    r.trips.list = [trip(1, T0 + 2 * MIN + 30_000, 18_000)];
    await playMinutes(r, 2, () => 100);
    r.trips.list = [...r.trips.list, trip(2, T0 + 3 * MIN, null)];
    await playMinutes(r, 2, () => 100);
    const [s] = await stored(r);
    expect(s.trips.map((t) => t.label)).toEqual(["Run 1", "Run 2"]);
    expect(s.trips[0].planned_profit_auec).toBe(20_000);
    expect(s.trips[1].net_auec).toBeNull();
    const out = await r.manager.session(undefined, true);
    expect(out?.session && out.session.trips).toBe(2);
    expect(out?.session && "money" in out.session && out.session.money).toMatchObject({
      net_auec: 18_000,
      net_source: "trips",
      net_complete: false,
    });
  });
});

describe("Feature: 'Nouvelle session' and 'Terminer' from the View or a tool", () => {
  it("Given a running session, When a new one is started, Then it starts from the balance just seen and the old one is closed", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 3, (m) => 1000 + m);
    const made = await r.manager.newSession("second hauling run");
    expect(made.previous).toBe(1);
    expect(made.summary.number).toBe(2);
    const all = await stored(r);
    expect(all[0].end_reason).toBe("new_session");
    expect(all[1].start_balance).toBe(1002);
    expect(all[1].note).toBe("second hauling run");
    const ended = await r.manager.endSession();
    expect(ended.ended).toBe(true);
    expect((await r.manager.endSession()).ended).toBe(false);
  });

  it("Given a manual end and the game still running, Then the dashboard keeps showing the ended session", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 2, () => 10);
    await r.manager.endSession();
    await playMinutes(r, 2, () => 11);
    const bar = await r.manager.bar(true);
    expect(bar.current?.status).toBe("ended");
    expect(await stored(r)).toHaveLength(1);
  });
});

describe("Feature: opening the dashboard attaches to the last session, or starts a new one after a long break", () => {
  it("Given a session from 1 hour ago, Then it is attached; from 5 hours ago, Then a fresh one is made", async () => {
    const r = rig();
    r.log.running = true;
    await playMinutes(r, 3, () => 50);
    r.clock.t += HOUR;
    expect((await r.manager.bar(false)).current?.number).toBe(1);
    r.clock.t += 5 * HOUR;
    const bar = await r.manager.bar(false);
    expect(bar.current?.number).toBe(2);
    expect(bar.current?.trips).toBe(0);
    expect((await stored(r)).map((s) => s.number)).toEqual([1, 2]);
  });

  it("Given the dashboard polled every second, Then the file is not written at every poll", async () => {
    const r = rig();
    await r.manager.bar(false);
    const writes = r.store.writes;
    for (let i = 0; i < 20; i++) {
      r.clock.t += 1000;
      await r.manager.bar(false);
    }
    expect(r.store.writes).toBe(writes);
  });
});

describe("Feature: the balance does not leave without the player's choice", () => {
  const BALANCE = 123_456_789;

  it("Given include_balance=false, Then bar, session, list and stats hold no aUEC figure and not the balance digits", async () => {
    const r = rig();
    r.log.running = true;
    r.trips.list = [
      {
        key: "00000000000000aa",
        kind: "hauling",
        source: "contract_ledger",
        ended_at: new Date(T0 + 2 * MIN).toISOString(),
        label: "Run",
        commodity: "Gold",
        net_auec: 987_654,
        net_kind: "balance_delta",
        planned_profit_auec: 1_000_000,
      },
    ];
    await playMinutes(r, 15, (m) => BALANCE + m * 31_337);
    const bar = await r.manager.bar(false);
    const session = await r.manager.session(undefined, false);
    const list = await r.manager.list(10, false);
    const stats = await r.manager.stats(undefined, false);
    for (const out of [bar, session, list, stats]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(String(BALANCE));
      expect(text).not.toContain("987654");
      expect(text).not.toContain("1000000");
      expect(text).toContain("withheld");
    }
    // Counts and durations are still there.
    expect(bar.current?.trips).toBe(1);
    expect(bar.current?.active_ms).toBeGreaterThan(0);
    // With the balance, the figures are there.
    const rich = JSON.stringify(await r.manager.bar(true));
    expect(rich).toContain(String(BALANCE));
  });
});

describe("Feature: a file that cannot be written never breaks the server", () => {
  it("Given a busy lock, Then a tick reports nothing and the next one succeeds", async () => {
    const clock = { t: T0 };
    const store = new SessionStore(file, {
      now: () => clock.t,
      lockWaitMs: 50,
      lockStaleMs: 600_000,
    });
    const r = rig({ store });
    r.log.running = true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "1");
    await playMinutes(r, 1, () => 77);
    expect(r.manager.lastError).toMatch(/busy/);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(`${file}.lock`);
    await playMinutes(r, 1, () => 77);
    expect((await stored(r))[0].start_balance).toBe(77);
  });
});
