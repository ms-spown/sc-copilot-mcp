import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sweepWithBalance, sweepWithoutBalance } from "../testing/replay/audit.js";
import { fillerLine } from "../testing/replay/lines.js";
import { PLAYER_RUN } from "../testing/replay/scripts.js";
import { useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: the replay harness itself. A scenario is only as good as the harness's promise that an event happens at the
 * instant it was scheduled for, on every part at once. These tests check that promise, so that a scenario that goes
 * wrong is never the harness's fault without anybody noticing.
 */

const rig = useWorld();

describe("Feature: the timeline is exact", () => {
  it("Given events and a grid, Then steps fall on the grid and on every event, and nowhere else", async () => {
    const w = await rig.start({ dt: 2 });
    w.at(3.3).change(100);
    w.at(7).change(100);
    await w.playTo(8);
    expect(w.steps).toEqual([2, 3.3, 5.3, 7, 8]);
    await w.playTo(8); // nothing to do: no step
    expect(w.steps).toHaveLength(5);
  });

  it("Given a balance change at 20.7 s, Then the telemetry stamps it at exactly that virtual time, and heartbeats extend the value", async () => {
    const w = await rig.start();
    w.at(20.7).change(-139_000);
    await w.playTo(30);
    const history = await w.telemetry.balanceHistory!();
    expect(history).toEqual([
      { at: w.ms(2), uec: PLAYER_RUN.start, until: w.ms(20) },
      { at: w.ms(20.7), uec: PLAYER_RUN.start - 139_000, until: w.ms(30) },
    ]);
  });

  it("Given a stream that is cut, Then no frame leaves and the telemetry says so when the frame is too old", async () => {
    const w = await rig.start();
    w.at(10).cut();
    w.at(20).resume();
    await w.playTo(16);
    const quiet = await w.poll(false);
    expect(quiet.state).toBe("connected"); // no frame for 6 s: not live
    expect(quiet.conditions).toEqual([]);
    await w.playTo(22);
    expect((await w.poll(false)).state).toBe("live");
    const history = await w.telemetry.balanceHistory!();
    expect(history).toEqual([{ at: w.ms(2), uec: PLAYER_RUN.start, until: w.ms(22) }]);
  });

  it("Given a second in the past, Then scheduling is refused, and a stopped server cannot be played with playTo's down twin", async () => {
    const w = await rig.start();
    await w.playTo(10);
    expect(() => w.at(5)).toThrow(/in the past/);
    await expect(w.playDownTo(20)).rejects.toThrow(/server is up/);
  });
});

describe("Feature: the log grows like the game's", () => {
  it("Given steps, Then every append moves the file's date forward (the ledger reads only a changed file) and a filler line is written", async () => {
    const w = await rig.start();
    const dates: number[] = [];
    for (let s = 1; s <= 3; s++) {
      await w.playTo(s * 0.1);
      dates.push(fs.statSync(w.logFile).mtimeMs);
    }
    expect(dates[1]).toBeGreaterThan(dates[0]!);
    expect(dates[2]).toBeGreaterThan(dates[1]!);
    const text = fs.readFileSync(w.logFile, "utf8");
    expect(text).toContain(fillerLine(w.ms(0.1)));
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("Feature: the sweeps are not vacuous", () => {
  it("Given a balance in play, Then the sweep with the balance finds it and the sweep without does not", async () => {
    const w = await rig.start();
    await w.playTo(10);
    expect((await sweepWithoutBalance(w)).all).not.toContain(String(PLAYER_RUN.start));
    expect(await sweepWithBalance(w)).toContain(String(PLAYER_RUN.start));
  });
});
