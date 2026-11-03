import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import type { LogEvent } from "../providers/gamelog/parser.js";
import { parseLog } from "../providers/gamelog/parser.js";
import { LedgerService, ledgerLogFrom, type LedgerLogSource } from "./ledgerService.js";
import { transportLogText } from "./testing/ledgerScenario.js";

/**
 * The reading side of the ledger. Fake sources and a temporary folder; a real Game.log is never opened.
 */

const EPOCH = Date.UTC(2026, 10, 3, 18, 0, 0);

/** A source that counts what is asked of it and lets the test move the file's date. */
function fakeSource(text: string) {
  let events: LogEvent[] = parseLog(text).events;
  const state = {
    mtimeMs: 1000,
    stats: 0,
    reads: 0,
    configured: true,
    failStat: false,
    failRead: false,
  };
  const source: LedgerLogSource = {
    get configured() {
      return state.configured;
    },
    stat: async () => {
      state.stats += 1;
      if (state.failStat) throw new Error("gone");
      return { mtimeMs: state.mtimeMs };
    },
    read: async () => {
      state.reads += 1;
      if (state.failRead) throw new Error("locked");
      return { events, truncated: false, modifiedAt: state.mtimeMs };
    },
  };
  return { source, state, setText: (t: string) => (events = parseLog(t).events) };
}

describe("Feature: the log is read thriftily and never in the way of the poll", () => {
  it("Given a first call, Then it answers 'loading' at once and the contracts arrive after the background read", async () => {
    const { source } = fakeSource(transportLogText(EPOCH));
    const service = new LedgerService(source, () => 0);
    expect(service.state().status).toBe("loading");
    await service.settled();
    const ready = service.state();
    expect(ready.status).toBe("ok");
    expect(ready.contracts.map((c) => c.title)).toEqual([
      "Urgent Parcel | Medium",
      "Waste Disposal | Easy",
      "Ore Delivery | Hard",
    ]);
  });

  it("Given calls within five seconds, Then the file is looked at once; later, it is read again only if its date changed", async () => {
    const { source, state } = fakeSource(transportLogText(EPOCH));
    let now = 0;
    const service = new LedgerService(source, () => now);
    service.state();
    await service.settled();
    expect([state.stats, state.reads]).toEqual([1, 1]);

    for (const t of [10, 1000, 4999]) {
      now = t;
      service.state();
      await service.settled();
    }
    expect([state.stats, state.reads]).toEqual([1, 1]); // not even a stat inside the window

    now = 5000;
    service.state();
    await service.settled();
    expect([state.stats, state.reads]).toEqual([2, 1]); // the date is the same: no read

    now = 10_000;
    state.mtimeMs = 2000; // the game wrote to the log
    service.state();
    await service.settled();
    expect([state.stats, state.reads]).toEqual([3, 2]);
    expect(service.reads).toBe(2);
  });

  it("Given a read that never ends, Then the poll still gets an answer, and no second read piles up", async () => {
    let started = 0;
    const source: LedgerLogSource = {
      configured: true,
      stat: async () => ({ mtimeMs: 1 }),
      read: () => {
        started += 1;
        return new Promise(() => undefined);
      },
    };
    let now = 0;
    const service = new LedgerService(source, () => now);
    expect(service.state().status).toBe("loading");
    for (now = 5000; now <= 60_000; now += 5000) {
      expect(service.state().status).toBe("loading");
      await Promise.resolve();
    }
    expect(started).toBe(1);
  });

  it("Given the log is not configured, Then the ledger is off, and nothing is ever looked at", async () => {
    const { source, state } = fakeSource(transportLogText(EPOCH));
    state.configured = false;
    const service = new LedgerService(source, () => 0);
    expect(service.state().status).toBe("off");
    await service.settled();
    expect([state.stats, state.reads]).toEqual([0, 0]);
    expect(new LedgerService(undefined).state().status).toBe("off");
    // The server's own GameLog with no path set is not configured either.
    expect(ledgerLogFrom(new GameLog({})).configured).toBe(false);
  });

  it("Given the file disappears or cannot be read, Then the status is 'unreadable', and it recovers when the file is back", async () => {
    const { source, state } = fakeSource(transportLogText(EPOCH));
    let now = 0;
    const service = new LedgerService(source, () => now);
    service.state();
    await service.settled();
    now = 5000;
    state.failStat = true;
    service.state();
    await service.settled();
    expect(service.state()).toMatchObject({ status: "unreadable", contracts: [] });
    now = 10_000;
    state.failStat = false;
    state.failRead = true;
    service.state();
    await service.settled();
    expect(service.state().status).toBe("unreadable");
    now = 15_000;
    state.failRead = false;
    service.state();
    await service.settled();
    expect(service.state().status).toBe("ok");
  });

  it("Given the game starts a new session and the log is replaced, Then the old contracts are gone", async () => {
    const { source, state, setText } = fakeSource(transportLogText(EPOCH));
    let now = 0;
    const service = new LedgerService(source, () => now);
    service.state();
    await service.settled();
    expect(service.state().contracts).toHaveLength(3);
    setText("<2026-11-04T09:00:00.000Z> Log started on Tue Nov  3 21:00:00 2026");
    state.mtimeMs = 5000;
    now = 5000;
    service.state();
    await service.settled();
    expect(service.state().contracts).toHaveLength(0);
  });
});

describe("Feature: with a real file, only a change of its date makes it read again", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("Given a made-up Game.log in a temporary folder, Then it is parsed once, re-parsed after a new date, and never written", async () => {
    const file = path.join(dir, "Game.log");
    fs.writeFileSync(file, transportLogText(EPOCH));
    const fixed = new Date("2026-11-03T18:05:00Z");
    fs.utimesSync(file, fixed, fixed);
    const before = fs.readFileSync(file);

    const log = new GameLog({ logPath: file });
    let now = 0;
    const service = new LedgerService(ledgerLogFrom(log), () => now);
    service.state();
    await service.settled();
    expect(service.state()).toMatchObject({ status: "ok" });
    expect(service.state().contracts).toHaveLength(3);
    expect(service.reads).toBe(1);

    now = 6000;
    service.state();
    await service.settled();
    expect(service.reads).toBe(1); // same date

    // The game writes one more line and the date moves on.
    fs.appendFileSync(file, `\n<2026-11-03T18:02:30.000Z>    "Contract Accepted:  Late Job: " [9]`);
    const later = new Date("2026-11-03T18:06:00Z");
    fs.utimesSync(file, later, later);
    now = 12_000;
    service.state();
    await service.settled();
    expect(service.reads).toBe(2);
    expect(service.state().contracts.map((c) => c.title)).toContain("Late Job");

    // Read-only: the service never changed the file's content.
    expect(fs.readFileSync(file).subarray(0, before.length).equals(before)).toBe(true);
  });

  it("Given a path that is not a log file, Then the status is 'unreadable' and nothing else is read", async () => {
    const other = path.join(dir, "secrets.txt");
    fs.writeFileSync(other, "not a log");
    const service = new LedgerService(ledgerLogFrom(new GameLog({ logPath: other })), () => 0);
    service.state();
    await service.settled();
    expect(service.state().status).toBe("unreadable");
    expect(service.reads).toBe(0);
  });
});
