import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../gamelog/reader.js";
import { createGameRunning, GAME_RUNNING_WINDOW_MS } from "./manager.js";

/** Feature: "the game is running" is one stat of Game.log, never a read of its content. */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-running-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Feature: detecting the running game cheaply", () => {
  it("Given a log written a minute ago, Then the game is running; given one written an hour ago, Then not", async () => {
    const file = path.join(dir, "Game.log");
    fs.writeFileSync(file, "x");
    const now = Date.now();
    const running = createGameRunning(new GameLog({ logPath: file }), () => now);
    fs.utimesSync(file, new Date(now - 60_000), new Date(now - 60_000));
    expect((await running())?.running).toBe(true);
    fs.utimesSync(
      file,
      new Date(now - GAME_RUNNING_WINDOW_MS - 1000),
      new Date(now - GAME_RUNNING_WINDOW_MS - 1000),
    );
    expect((await running())?.running).toBe(false);
  });

  it("Given no configured log, or a missing file, Then it says nothing (null)", async () => {
    expect(await createGameRunning(new GameLog({}))()).toBeNull();
    expect(
      await createGameRunning(new GameLog({ logPath: path.join(dir, "none.log") }))(),
    ).toBeNull();
  });
});
