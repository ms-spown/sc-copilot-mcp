import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLogFile } from "./openLog.js";
import { GameLog, GameLogError } from "./reader.js";

/**
 * Feature: a link is followed only to a file that is itself a .log.
 *
 * The server reads "a .log file" and nothing else. A symbolic link (or junction) named Game.log that points at some other
 * file would turn that into "read any file the link names". Setting it up needs write access to the log's folder, so this
 * is a narrow door, but it costs one check to close it.
 */

const LINE = "<2026-11-02T20:06:15.200Z> Log started on Mon Nov  2 21:06:15 2026\n";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-openlog-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A link, or null when this machine does not let the test make one (Windows without developer mode). */
function link(target: string, name: string): string | null {
  const at = path.join(dir, name);
  try {
    fs.symlinkSync(target, at, "file");
    return at;
  } catch {
    return null;
  }
}

describe("Feature: openLogFile", () => {
  it("Given a regular .log, Then it opens", async () => {
    const file = path.join(dir, "Game.log");
    fs.writeFileSync(file, LINE);
    const handle = await openLogFile(file);
    expect((await handle.stat()).size).toBe(LINE.length);
    await handle.close();
  });

  it("Given a link named Game.log to a file that is not a .log, Then it is refused and nothing is read", async () => {
    const secret = path.join(dir, "secret.txt");
    fs.writeFileSync(secret, "nothing to do with the game");
    const at = link(secret, "Game.log");
    if (!at) return;
    await expect(openLogFile(at)).rejects.toThrow(GameLogError);
    await expect(openLogFile(at)).rejects.toThrow(/link to a file that is not a \.log/);
  });

  it("Given a link to another .log, Then it opens (a log moved to another drive is legitimate)", async () => {
    const real = path.join(dir, "real.log");
    fs.writeFileSync(real, LINE);
    const at = link(real, "Game.log");
    if (!at) return;
    const handle = await openLogFile(at);
    expect((await handle.stat()).size).toBe(LINE.length);
    await handle.close();
  });

  it("Given a missing file, Then the error keeps its code (the callers tell 'not there' from 'cannot read')", async () => {
    await expect(openLogFile(path.join(dir, "nope.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Feature: the same rule, whatever the machine lets a test create", () => {
  // Making a link needs a privilege on Windows: here the system answers "this name resolves to that file" instead.
  it("Given a name that resolves to a file that is not a .log, Then it is refused before anything is opened", async () => {
    const file = path.join(dir, "Game.log");
    fs.writeFileSync(file, LINE);
    const spy = vi.spyOn(fsPromises, "realpath").mockResolvedValue(path.join(dir, "passwords.txt"));
    const open = vi.spyOn(fsPromises, "open");
    try {
      await expect(openLogFile(file)).rejects.toThrow(/link to a file that is not a \.log/);
      expect(open).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      open.mockRestore();
    }
  });

  it("Given a name that resolves to another .log (any case), Then that file is the one opened", async () => {
    const real = path.join(dir, "Real.LOG");
    fs.writeFileSync(real, LINE);
    const spy = vi.spyOn(fsPromises, "realpath").mockResolvedValue(real);
    try {
      const handle = await openLogFile(path.join(dir, "Game.log"));
      expect((await handle.stat()).size).toBe(LINE.length);
      await handle.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("Given a name that resolves to a non-log, Then GameLog.read refuses with the same words and never reads it", async () => {
    const file = path.join(dir, "Game.log");
    fs.writeFileSync(file, LINE);
    const spy = vi.spyOn(fsPromises, "realpath").mockResolvedValue(path.join(dir, "passwords.txt"));
    try {
      const error = await new GameLog({ logPath: file }).read().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(GameLogError);
      expect(error?.message).toMatch(/not a \.log/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Feature: the readers use it", () => {
  it("Given a link to a non-log, When GameLog reads, Then it says so and returns no text of the target", async () => {
    const secret = path.join(dir, "passwords.txt");
    fs.writeFileSync(secret, "hunter2-SENTINEL");
    const at = link(secret, "Game.log");
    if (!at) return;
    const error = await new GameLog({ logPath: at }).read().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(GameLogError);
    expect(error?.message).toMatch(/not a \.log/);
    expect(error?.message).not.toContain("hunter2");
  });
});
