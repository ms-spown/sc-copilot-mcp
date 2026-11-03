import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { LEDGER_LOOKBEHIND_BYTES, LedgerService, ledgerLogFrom } from "./ledgerService.js";

/**
 * Reading the log by what was added to it. Made-up log lines in a temporary folder; the service is driven by a
 * virtual clock and the file's date is moved by hand.
 */

const M1 = "aaaaaaaa-1111-2222-3333-444444444444";
const M2 = "bbbbbbbb-1111-2222-3333-444444444444";
const at = (s: number) =>
  `<2026-11-03T18:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z>`;
const HEADER = `${at(0)} Log started on Tue Nov  3 18:00:00 2026\n${at(0)} FileVersion: 9.9.1.2222\n`;
const quoted = (s: number, text: string) => `${at(s)}    "${text}" [9]\n`;
const added = (s: number, text: string, id: string) =>
  `${at(s)} [Notice] <SHUDEvent_OnNotification> Added notification "${text}" [9] to queue. New queue size: 1, MissionId: [${id}], ObjectiveId: [] [Team_X]\n`;
const pick = (s: number, id: string, place: string) =>
  `${at(s)} [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Ore, missionId: ${id}, locationName: Unknown [${place}], locationHash: 1\n`;
const drop = (s: number, id: string, place: string) =>
  `${at(s)} [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: HaulCargo_Test_Ore, missionId: ${id}, locationName: Unknown [${place}], locationHash: 2\n`;
const junk = (n: number) =>
  Array.from({ length: n }, (_, i) => `${at(1)} [Info] filler line ${i} ${"x".repeat(80)}\n`).join(
    "",
  );

let dir: string;
let file: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-inc-"));
  file = path.join(dir, "Game.log");
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Writes (or appends) and moves the date forward, as the game writing would. */
function write(text: string, mode: "set" | "append" = "append") {
  if (mode === "set") fs.writeFileSync(file, text);
  else fs.appendFileSync(file, text);
  tick += 1;
  const d = new Date(Date.UTC(2026, 10, 3, 18, 10, 0) + tick * 1000);
  fs.utimesSync(file, d, d);
}

function setup() {
  const clock = { now: 0 };
  const service = new LedgerService(ledgerLogFrom(new GameLog({ logPath: file })), () => clock.now);
  const refresh = async () => {
    clock.now += 5000;
    service.state();
    await service.settled();
    return service.state();
  };
  return { service, refresh };
}

describe("Feature: after the first read, only what the game added is parsed", () => {
  it("Given a large log and a few new lines, Then the second read is incremental and parses far less than the file", async () => {
    write(
      HEADER +
        junk(4000) +
        quoted(5, "Contract Accepted:  Job One: ") +
        added(5, "Contract Accepted:  Job One: ", M1) +
        pick(6, M1, "Place_A") +
        drop(7, M1, "Place_B"),
      "set",
    );
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(300_000);
    const { service, refresh } = setup();
    const first = await refresh();
    expect(first.contracts.map((c) => [c.title, c.stepsTotal])).toEqual([["Job One", 2]]);
    expect([service.fullReads, service.incrementalReads]).toEqual([1, 0]);

    const addition =
      quoted(30, "Objective Complete: Collect: ") +
      added(30, "Objective Complete: Collect: ", M1) +
      "\n";
    write(addition);
    const second = await refresh();
    expect([service.fullReads, service.incrementalReads]).toEqual([1, 1]);
    expect(second.contracts[0]!.objectivesDone).toBe(1);
    // Look-behind plus the addition, not the 300 kB of the file.
    expect(service.bytesParsed).toBeLessThanOrEqual(LEDGER_LOOKBEHIND_BYTES + addition.length);
    expect(service.bytesParsed).toBeLessThan(size / 10);
  });

  it("Given the same pickup line repeated in later reads, Then the step is counted once", async () => {
    write(
      HEADER +
        quoted(5, "Contract Accepted:  Job One: ") +
        added(5, "Contract Accepted:  Job One: ", M1) +
        pick(6, M1, "Place_A") +
        drop(7, M1, "Place_B"),
      "set",
    );
    const { service, refresh } = setup();
    await refresh();
    for (let i = 0; i < 3; i++)
      write(
        pick(10 + i, M1, "Place_A") + pick(20 + i, M1, "Place_A") + drop(30 + i, M1, "Place_B"),
      );
    const state = await refresh();
    expect(service.incrementalReads).toBeGreaterThan(0);
    expect(state.contracts[0]!.stepsTotal).toBe(2);
    expect(state.contracts[0]!.steps).toHaveLength(2);
  });

  it("Given a line cut in two by the game's own write, Then it is parsed when it is complete, never before and never twice", async () => {
    write(HEADER + junk(50), "set");
    const { refresh } = setup();
    await refresh();
    const line =
      quoted(40, "Contract Accepted:  Cut Job: ") + added(40, "Contract Accepted:  Cut Job: ", M2);
    const cut = Math.floor(quoted(40, "Contract Accepted:  Cut Job: ").length * 0.6);
    write(line.slice(0, cut));
    expect((await refresh()).contracts).toHaveLength(0); // half a line: nothing
    write(line.slice(cut));
    const done = await refresh();
    expect(done.contracts.map((c) => [c.title, c.id])).toEqual([["Cut Job", "bbbbbbbb"]]);
    write(junk(3));
    expect((await refresh()).contracts).toHaveLength(1);
  });

  it("Given the title line and its mission line in two different reads, Then the contract still gets its mission id", async () => {
    write(HEADER + junk(50), "set");
    const { refresh } = setup();
    await refresh();
    write(quoted(40, "Contract Accepted:  Split Job: "));
    expect((await refresh()).contracts.map((c) => c.id)).toEqual([null]);
    write(added(40, "Contract Accepted:  Split Job: ", M2) + pick(41, M2, "Place_A"));
    const state = await refresh();
    expect(state.contracts).toHaveLength(1); // the two announcements are one contract
    expect(state.contracts[0]).toMatchObject({ id: "bbbbbbbb", title: "Split Job", stepsTotal: 1 });
  });
});

describe("Feature: anything doubtful starts again with a full read", () => {
  it("Given the file is replaced by a shorter one, Then the old contracts are gone", async () => {
    write(
      HEADER +
        junk(300) +
        quoted(5, "Contract Accepted:  Old Job: ") +
        added(5, "Contract Accepted:  Old Job: ", M1),
      "set",
    );
    const { service, refresh } = setup();
    expect((await refresh()).contracts).toHaveLength(1);
    write(
      HEADER +
        quoted(6, "Contract Accepted:  New Job: ") +
        added(6, "Contract Accepted:  New Job: ", M2),
      "set",
    );
    const state = await refresh();
    expect(state.contracts.map((c) => c.title)).toEqual(["New Job"]);
    expect(service.fullReads).toBe(2);
  });

  it("Given a new game session whose log is already longer, Then the different beginning is noticed", async () => {
    write(
      `${at(0)} Log started on Tue Nov  3 18:00:00 2026\n` +
        quoted(5, "Contract Accepted:  Old Job: ") +
        added(5, "Contract Accepted:  Old Job: ", M1),
      "set",
    );
    const { service, refresh } = setup();
    await refresh();
    write(
      `${at(0)} Log started on Tue Nov  3 20:30:00 2026\n` +
        junk(500) +
        quoted(9, "Contract Accepted:  Other Job: ") +
        added(9, "Contract Accepted:  Other Job: ", M2),
      "set",
    );
    const state = await refresh();
    expect(state.contracts.map((c) => c.title)).toEqual(["Other Job"]);
    expect(service.fullReads).toBe(2);
  });

  it("Given a log in UTF-16, Then every read is a full one (it cannot be read from the middle)", async () => {
    const text =
      HEADER +
      quoted(5, "Contract Accepted:  Wide Job: ") +
      added(5, "Contract Accepted:  Wide Job: ", M1);
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    );
    const { service, refresh } = setup();
    expect((await refresh()).contracts.map((c) => c.title)).toEqual(["Wide Job"]);
    const more = Buffer.from(
      quoted(9, "Contract Accepted:  Wide Two: ") + added(9, "Contract Accepted:  Wide Two: ", M2),
      "utf16le",
    );
    fs.appendFileSync(file, more);
    const d = new Date(Date.UTC(2026, 10, 3, 19, 0, 0));
    fs.utimesSync(file, d, d);
    expect((await refresh()).contracts).toHaveLength(2);
    expect(service.incrementalReads).toBe(0);
    expect(service.fullReads).toBe(2);
  });
});
