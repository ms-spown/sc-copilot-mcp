import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardService } from "../../dashboard/service.js";
import { GameLog } from "../gamelog/reader.js";
import { createTelemetry } from "../telemetry/index.js";
import type { Telemetry } from "../telemetry/index.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../telemetry/service.js";
import { REGISTERED_LINE } from "../telemetry/gamelogHint.js";
import { startFakeGame } from "../telemetry/testing/fakeServer.js";
import { createGameRunning, SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import type { TripInput } from "./types.js";
import { waitFor } from "../../testing/waitFor.js";

// Every change to the session file is a real write with fsync (the store's promise: a power cut keeps the old file or
// the new one), and these tests make dozens of them. An idle disk takes a few ms each; a disk shared with other
// work can stall for seconds. A timeout here only detects a hang.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature (audit): nothing connects or is written when it should not; the last trip is not lost; a write that fails is
 * said, not hidden; the old flight-counter markers do not touch the saved session.
 */

const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;

let dir: string;
let file: string;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-audit-"));
  file = path.join(dir, "data", "sessions.json");
});
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Feature: with telemetry on, the server connects only when the game is there with its setting", () => {
  async function rig(
    hint: (() => Promise<{ running: boolean; telemetryRegistered: boolean } | null>) | undefined,
  ) {
    const game = await startFakeGame();
    cleanup.push(() => game.close());
    const telemetry = createTelemetry({
      enabled: true,
      options: {
        endpointForTests: { host: "127.0.0.1", port: game.port },
        reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
      },
    });
    cleanup.push(() => telemetry.stop());
    const clock = { t: T0 };
    const manager = new SessionManager({
      telemetry,
      store: new SessionStore(file, { now: () => clock.t }),
      config: { enabled: true, file, gapMs: 3 * 60 * MIN },
      ...(hint ? { gameHint: hint } : {}),
      now: () => clock.t,
    });
    const tickFor = async (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.t += 5000;
        await manager.tick();
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    return { game, manager, tickFor };
  }

  it("Given telemetry on, no tool call, no Game.log, Then there is no connection and no file", async () => {
    const { game, manager, tickFor } = await rig(undefined);
    manager.start();
    await tickFor(6);
    expect(game.connections()).toBe(0);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    await manager.close();
  });

  it("Given the game runs but its log has no telemetry registration (no GRPC_CLIENT_SERVER_ENABLED), Then the reader is never started", async () => {
    const { game, tickFor } = await rig(async () => ({
      running: true,
      telemetryRegistered: false,
    }));
    await tickFor(6);
    expect(game.connections()).toBe(0);
  });

  it("Given the game runs with the registration line (control), Then the reader connects", async () => {
    const { game, tickFor } = await rig(async () => ({ running: true, telemetryRegistered: true }));
    await tickFor(4);
    // The connection is made by the reader on its own timers and a real socket: wait for it, do not guess how long.
    await waitFor(() => game.connections() > 0, "the reader connects");
    expect(game.connections()).toBeGreaterThan(0);
  });
});

describe("Feature: the running-game detector asks the log for the telemetry registration", () => {
  it("Given a fresh log without the registration line, Then it says not registered; with the line, registered (and the head is not read again)", async () => {
    const logFile = path.join(dir, "Game.log");
    fs.writeFileSync(logFile, "<2026-11-04T18:00:00.000Z> [Notice] <Something> hello\n");
    const now = Date.now();
    const running = createGameRunning(new GameLog({ logPath: logFile }), () => now);
    expect(await running()).toEqual({ running: true, telemetryRegistered: false });
    fs.writeFileSync(
      logFile,
      `<2026-11-04T18:00:00.000Z> [Notice] <Something> hello\n<2026-11-04T18:00:01.000Z> [Notice] <Reg> ${REGISTERED_LINE}\n`,
    );
    // The negative answer is kept for 30 s: still "not registered" at once, registered once it is asked again.
    expect((await running())?.telemetryRegistered).toBe(false);
    const later = createGameRunning(new GameLog({ logPath: logFile }), () => now);
    expect(await later()).toEqual({ running: true, telemetryRegistered: true });
  });
});

/** A telemetry stand-in that reports a balance. */
function fakeTelemetry(): Telemetry {
  return {
    enabled: true,
    status: async () => ({ state: "live" }) as TelemetryStatusReport,
    snapshot: async () =>
      ({ state: { pilot: { uec_balance: 5000 } } }) as unknown as TelemetrySnapshot,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
}

const lateTrip = (ended: number): TripInput => ({
  key: "00000000000000cc",
  kind: "hauling",
  source: "contract_ledger",
  ended_at: new Date(ended).toISOString(),
  label: "Last run",
  net_auec: null,
});

describe("Feature: the last trip is not lost when a session closes or the server stops", () => {
  function make() {
    const clock = { t: T0 };
    const state = { final: 0, refreshed: 0, ready: false };
    const manager = new SessionManager({
      telemetry: fakeTelemetry(),
      store: new SessionStore(file, { now: () => clock.t }),
      config: { enabled: true, file, gapMs: 3 * 60 * MIN },
      gameHint: async () => ({ running: true, telemetryRegistered: true }),
      ledger: {
        refreshNow: async () => {
          state.refreshed += 1;
          state.ready = true;
        },
      } as never,
      trips: {
        // The trip is only seen after the log is re-read now, and while its result still settles it is returned
        // only to a final collection.
        collect: async (_now, opts) => {
          if (opts?.final) state.final += 1;
          return {
            trips: state.ready && opts?.final ? [lateTrip(clock.t - 3000)] : [],
            context: null,
          };
        },
      },
      now: () => clock.t,
    });
    return { clock, manager, state };
  }

  it("Given a trip that only a fresh read shows, When the player starts a new session, Then it is in the session that closed", async () => {
    const { clock, manager, state } = make();
    for (let i = 0; i < 3; i++) {
      clock.t += 5000;
      await manager.tick();
    }
    clock.t += 5000;
    const made = await manager.newSession();
    expect(state.refreshed).toBe(1);
    expect(state.final).toBeGreaterThan(0);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.sessions).toHaveLength(2);
    expect(doc.sessions[0].trips.map((t: { label: string }) => t.label)).toEqual(["Last run"]);
    expect(doc.sessions[1].trips).toEqual([]);
    expect(made.saved).toBe(true);
  });

  it("Given a clean shutdown, Then one last look is saved", async () => {
    const { clock, manager } = make();
    for (let i = 0; i < 2; i++) {
      clock.t += 5000;
      await manager.tick();
    }
    clock.t += 5000;
    await manager.close();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.sessions[0].trips).toHaveLength(1);
  });
});

describe("Feature: a change that cannot be written is said, not hidden", () => {
  it("Given the disk refuses the write, When a session is started, Then the answer says it is not saved, and the session is still the current one", async () => {
    const clock = { t: T0 };
    let full = false;
    const store = new SessionStore(file, {
      now: () => clock.t,
      beforeRename: () => {
        if (full) throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    });
    const manager = new SessionManager({
      telemetry: fakeTelemetry(),
      store,
      config: { enabled: true, file, gapMs: 3 * 60 * MIN },
      gameHint: async () => ({ running: true, telemetryRegistered: true }),
      now: () => clock.t,
    });
    for (let i = 0; i < 3; i++) {
      clock.t += 5000;
      await manager.tick();
    }
    expect(manager.persistence.saved).toBe(true);
    full = true;
    clock.t += 5000;
    const made = await manager.newSession("after the disk filled");
    expect(made.saved).toBe(false);
    expect(manager.persistence.status).toMatch(/ENOSPC/);
    // The older file has one session; the process works on two (memory over the file).
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions).toHaveLength(1);
    const bar = await manager.bar(false);
    expect(bar.current?.number).toBe(2);
    full = false;
    clock.t += 5000;
    await manager.tick();
    await manager.endSession();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sessions).toHaveLength(2);
    expect(manager.persistence.saved).toBe(true);
  });
});

describe("Feature: the old flight-counter markers are not the saved session", () => {
  it("Given a session in play, When the View's start and end markers are used, Then the saved session is untouched", async () => {
    const clock = { t: T0 };
    const telemetry = fakeTelemetry();
    const manager = new SessionManager({
      telemetry,
      store: new SessionStore(file, { now: () => clock.t }),
      config: { enabled: true, file, gapMs: 3 * 60 * MIN },
      gameHint: async () => ({ running: true, telemetryRegistered: true }),
      now: () => clock.t,
    });
    for (let i = 0; i < 3; i++) {
      clock.t += 5000;
      await manager.tick();
    }
    const before = fs.readFileSync(file, "utf8");
    const service = new DashboardService(
      telemetry,
      () => clock.t,
      undefined,
      undefined,
      undefined,
      undefined,
      manager,
    );
    expect((await service.mark("start")).ok).toBe(true);
    expect((await service.mark("end")).ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect((await manager.bar(false)).current?.number).toBe(1);
  });
});
