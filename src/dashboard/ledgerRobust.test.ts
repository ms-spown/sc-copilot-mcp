import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { parseLog, type LogEvent } from "../providers/gamelog/parser.js";
import {
  LEDGER_MAX_INCREMENTAL_BYTES,
  LedgerService,
  ledgerLogFrom,
  type LedgerLogSource,
} from "./ledgerService.js";

/**
 * What keeps the ledger's reading honest over a long session: repeated game lines do not pile up, a huge jump of the
 * file is not read in one go, and a busy file does not make the contracts disappear.
 */

const M1 = "aaaaaaaa-1111-2222-3333-444444444444";
const at = (s: number) =>
  `<2026-11-03T${String(18 + Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z>`;
const HEADER = `${at(0)} Log started on Tue Nov  3 18:00:00 2026\n`;
const accepted = (s: number) =>
  `${at(s)}    "Contract Accepted:  Long Job: " [9]\n${at(s)} [Notice] <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Long Job: " [9] to queue. New queue size: 1, MissionId: [${M1}], ObjectiveId: [] [Team_X]\n`;
const pick = (s: number) =>
  `${at(s)} [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Ore, missionId: ${M1}, locationName: Unknown [Place_A], locationHash: 1\n`;
const drop = (s: number) =>
  `${at(s)} [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: HaulCargo_Test_Ore, missionId: ${M1}, locationName: Unknown [Place_B], locationHash: 2\n`;

let dir: string;
let file: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-robust-"));
  file = path.join(dir, "Game.log");
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function write(text: string, mode: "set" | "append" = "append") {
  if (mode === "set") fs.writeFileSync(file, text);
  else fs.appendFileSync(file, text);
  tick += 1;
  const d = new Date(Date.UTC(2026, 10, 3, 20, 0, 0) + tick * 1000);
  fs.utimesSync(file, d, d);
}

describe("Feature: a line the game repeats does not pile up in memory", () => {
  it("Given a pickup repeated for hours, Then the events kept stay few and the contract stays (it is never evicted)", async () => {
    write(HEADER + accepted(5) + pick(6) + drop(7), "set");
    const clock = { now: 0 };
    const service = new LedgerService(
      ledgerLogFrom(new GameLog({ logPath: file })),
      () => clock.now,
    );
    const refresh = async () => {
      clock.now += 5000;
      service.state();
      await service.settled();
      return service.state();
    };
    await refresh();
    const after = service.eventCount;
    // Three hours of the same pickup and drop-off lines, a new time every time, one read per 5 seconds.
    for (let i = 0; i < 400; i++) {
      write(pick(10 + i * 27) + drop(11 + i * 27));
      await refresh();
    }
    expect(service.incrementalReads).toBeGreaterThan(300);
    expect(service.eventCount).toBe(after); // not one event more: the first occurrence of a step is the one kept
    const state = service.state();
    expect(state.contracts).toHaveLength(1);
    expect(state.contracts[0]).toMatchObject({ title: "Long Job", stepsTotal: 2 });
  });
});

describe("Feature: a jump of the file is not read in one go", () => {
  /** A source over a made-up file size: counts what is asked of it. */
  function memory() {
    const text = HEADER + accepted(5) + pick(6) + drop(7);
    const state = { size: text.length, mtimeMs: 1, reads: 0, ranges: [] as [number, number][] };
    const events: LogEvent[] = parseLog(text).events;
    const source: LedgerLogSource = {
      configured: true,
      stat: async () => ({ mtimeMs: state.mtimeMs, size: state.size }),
      read: async () => {
        state.reads += 1;
        return { events, truncated: false, modifiedAt: state.mtimeMs };
      },
      head: async () => Buffer.from(HEADER),
      bytes: async (start, end) => {
        state.ranges.push([start, end]);
        return Buffer.from("\n");
      },
    };
    return { source, state };
  }

  it("Given the file grew by more than the incremental limit, Then the end of the log is read in full instead", async () => {
    const { source, state } = memory();
    const clock = { now: 0 };
    const service = new LedgerService(source, () => clock.now);
    service.state();
    await service.settled();
    expect(service.fullReads).toBe(1);
    // A small growth is read by range...
    clock.now = 5000;
    state.size += 100;
    state.mtimeMs = 2;
    service.state();
    await service.settled();
    expect(state.ranges).toHaveLength(1);
    // ... a huge one is not.
    clock.now = 10_000;
    state.size += LEDGER_MAX_INCREMENTAL_BYTES + 1;
    state.mtimeMs = 3;
    service.state();
    await service.settled();
    expect(state.ranges).toHaveLength(1); // no new range was asked for
    expect([service.fullReads, service.incrementalReads]).toEqual([2, 1]);
    expect(state.reads).toBe(2);
    expect(service.state().status).toBe("ok");
  });

  it("Given the real reader, Then it refuses to hand out a range larger than the limit", async () => {
    write(HEADER, "set");
    const source = ledgerLogFrom(new GameLog({ logPath: file }));
    await expect(source.bytes!(0, LEDGER_MAX_INCREMENTAL_BYTES + 1)).rejects.toThrow(/too large/);
    expect((await source.bytes!(0, 10)).length).toBe(10);
  });
});

describe("Feature: a busy file does not erase what is known", () => {
  function flaky() {
    const events = parseLog(HEADER + accepted(5) + pick(6)).events;
    const state = {
      mtimeMs: 1,
      statError: null as NodeJS.ErrnoException | null,
      readError: null as NodeJS.ErrnoException | null,
    };
    const source: LedgerLogSource = {
      configured: true,
      stat: async () => {
        if (state.statError) throw state.statError;
        return { mtimeMs: state.mtimeMs, size: 0 };
      },
      read: async () => {
        if (state.readError) throw state.readError;
        return { events, truncated: false, modifiedAt: state.mtimeMs };
      },
    };
    return { source, state };
  }
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("Given a transient error (EBUSY), Then the last contracts stay, and the next successful read refreshes them", async () => {
    const { source, state } = flaky();
    const clock = { now: 0 };
    const service = new LedgerService(source, () => clock.now);
    const look = async () => {
      clock.now += 5000;
      service.state();
      await service.settled();
      return service.state();
    };
    expect((await look()).contracts).toHaveLength(1);
    state.mtimeMs = 2;
    state.readError = errno("EBUSY");
    expect(await look()).toMatchObject({ status: "ok" });
    expect(service.state().contracts).toHaveLength(1);
    state.statError = errno("EPERM");
    expect((await look()).status).toBe("ok");
    state.statError = null;
    state.readError = null;
    const back = await look();
    expect(back.status).toBe("ok");
    expect(service.reads).toBe(2);
  });

  it("Given the file is gone (ENOENT) or the error is not transient, Then the ledger says it is unreadable", async () => {
    const { source, state } = flaky();
    const clock = { now: 0 };
    const service = new LedgerService(source, () => clock.now);
    service.state();
    await service.settled();
    clock.now = 5000;
    state.statError = errno("ENOENT");
    service.state();
    await service.settled();
    expect(service.state()).toMatchObject({ status: "unreadable", contracts: [] });
  });
});
