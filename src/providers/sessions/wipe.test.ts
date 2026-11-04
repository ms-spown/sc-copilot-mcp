import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionsFilePath } from "./config.js";
import { applyWipe, describeWipe, planWipe } from "./wipe.js";

/**
 * Feature: `npm run sessions -- wipe` deletes the saved sessions and every copy of them, and nothing else.
 *
 * The session file keeps balances and results, and its copies (.v1.bak, .bak-<time>, .corrupt-<time>) hold the same
 * figures. A dry run lists what would go, by name, never by content; --apply removes exactly those files, in the
 * sessions folder only.
 */

const SECRET = "BALANCE-7654321-SENTINEL";
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-wipe-"));
  file = path.join(dir, "sessions.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const doc = JSON.stringify({ version: 2, revision: 3, sessions: [], note: SECRET });
const write = (name: string, text = doc) => fs.writeFileSync(path.join(dir, name), text);
const left = () => fs.readdirSync(dir).sort();
/** The lock file of a server that stopped long ago (a fresh one means a write in progress, which is refused). */
const staleLock = () => {
  const old = (Date.now() - 10 * 60_000) / 1000;
  fs.utimesSync(path.join(dir, "sessions.json.lock"), old, old);
};

const OURS = [
  "sessions.json",
  "sessions.json.v1.bak",
  "sessions.json.bak-2026-11-04T08-00-00-000Z",
  "sessions.json.bak-2026-11-03T08-00-00-000Z",
  "sessions.json.corrupt-2026-11-02T08-00-00-000Z",
  "sessions.json.lock",
  "sessions.json.4242.9f3a1c2b.tmp",
];
const NOT_OURS = [
  "notes.txt",
  "sessions.json.bak-x.txt",
  "sessions.jsonx",
  "my-sessions.json",
  "other.json",
  "sessions.json.backup",
  "fleet.json",
  // Not the stamps the store writes (an ISO time with ":" and "." turned into "-"): somebody else's names.
  "sessions.json.bak-final",
  "sessions.json.bak-2026",
  "sessions.json.corrupt-old",
  "sessions.json.bak-2026-11-04T08-00-00-000Z.txt",
  "sessions.json.v1.bak.old",
  "sessions.json.12.tmp.keep",
];

describe("Feature: planWipe lists what belongs to the session file", () => {
  it("Given the file and all its copies, Then each is listed, and no other file", async () => {
    for (const n of [...OURS, ...NOT_OURS]) write(n);
    staleLock();
    const plan = await planWipe(file);
    expect(plan.refused).toBeUndefined();
    expect(plan.files.map((f) => f.name).sort()).toEqual([...OURS].sort());
  });

  it("Given a sub-folder with the same names, Then it is not entered", async () => {
    write("sessions.json");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "sessions.json.v1.bak"), doc);
    const plan = await planWipe(file);
    expect(plan.files.map((f) => f.name)).toEqual(["sessions.json"]);
  });

  it("Given nothing at all, Then the plan is empty and says so", async () => {
    const plan = await planWipe(file);
    expect(plan.files).toEqual([]);
    expect(describeWipe(plan, false)).toMatch(/nothing to delete/i);
  });
});

describe("Feature: the dry run deletes nothing and shows names only", () => {
  it("Given the files, When I preview, Then every file is still there and no content is printed", async () => {
    for (const n of OURS) write(n);
    staleLock();
    const text = describeWipe(await planWipe(file), false);
    expect(left()).toEqual([...OURS].sort());
    for (const n of OURS) expect(text).toContain(n);
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/dry run/i);
    expect(text).toContain("--apply");
  });
});

describe("Feature: --apply deletes the file and its copies, nothing else", () => {
  it("Given ours and others, When I apply, Then only ours go", async () => {
    for (const n of [...OURS, ...NOT_OURS]) write(n);
    staleLock();
    const result = await applyWipe(await planWipe(file));
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual([...OURS].sort());
    expect(left()).toEqual([...NOT_OURS].sort());
  });

  it("Given a second run, Then nothing is left to delete", async () => {
    write("sessions.json");
    await applyWipe(await planWipe(file));
    expect((await planWipe(file)).files).toEqual([]);
  });

  it("Given the cache folder next to it, Then it is not touched", async () => {
    write("sessions.json");
    fs.mkdirSync(path.join(dir, "cache"));
    fs.writeFileSync(path.join(dir, "cache", "a.json"), "{}");
    await applyWipe(await planWipe(file));
    expect(fs.existsSync(path.join(dir, "cache", "a.json"))).toBe(true);
  });

  it("Given a symbolic link with one of our names, Then the link is not followed and not removed", async () => {
    const target = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(target, "keep me");
    try {
      fs.symlinkSync(target, path.join(dir, "sessions.json.v1.bak"));
    } catch {
      return; // no permission to make a link on this machine: nothing to check
    }
    write("sessions.json");
    const plan = await planWipe(file);
    expect(plan.files.map((f) => f.name)).toEqual(["sessions.json"]);
    await applyWipe(plan);
    expect(fs.readFileSync(target, "utf8")).toBe("keep me");
  });
});

describe("Feature: it refuses a path that does not look like the sessions file", () => {
  it("Given the path is a folder, Then it is refused and nothing is touched", async () => {
    fs.mkdirSync(path.join(dir, "folder.json"));
    const plan = await planWipe(path.join(dir, "folder.json"));
    expect(plan.refused).toMatch(/not a file/i);
    expect(plan.files).toEqual([]);
  });

  it("Given a name that is not .json, Then it is refused", async () => {
    write("report.txt", "hello");
    const plan = await planWipe(path.join(dir, "report.txt"));
    expect(plan.refused).toMatch(/\.json/);
    expect(left()).toEqual(["report.txt"]);
  });

  it("Given a custom .json that holds something else, Then it is refused", async () => {
    write("report.json", JSON.stringify({ title: "my report", rows: [1, 2, 3] }));
    const plan = await planWipe(path.join(dir, "report.json"));
    expect(plan.refused).toMatch(/does not look like/i);
    expect(plan.files).toEqual([]);
  });

  it("Given a custom name that holds a sessions document, Then it is wiped with its copies", async () => {
    write("mine.json");
    write("mine.json.v1.bak");
    write("sessions.json"); // the default name is a different file: not ours here
    const plan = await planWipe(path.join(dir, "mine.json"));
    expect(plan.refused).toBeUndefined();
    expect(plan.files.map((f) => f.name).sort()).toEqual(["mine.json", "mine.json.v1.bak"]);
  });

  it("Given a custom name whose main file is gone, Then it is refused (nothing shows the name is a sessions file)", async () => {
    write("report.json.bak-final");
    write("report.json.v1.bak");
    const plan = await planWipe(path.join(dir, "report.json"));
    expect(plan.refused).toMatch(/not there|no such|cannot be recognised|does not exist/i);
    expect(plan.files).toEqual([]);
    expect(left()).toEqual(["report.json.bak-final", "report.json.v1.bak"]);
  });

  it("Given the default name and only copies left, Then the copies are wiped", async () => {
    write("sessions.json.v1.bak");
    write("sessions.json.bak-2026-11-04T08-00-00-000Z");
    const plan = await planWipe(file);
    expect(plan.refused).toBeUndefined();
    expect(plan.files).toHaveLength(2);
  });

  it("Given the default name with damaged content, Then it is still wiped (a corrupt copy is the case for wiping)", async () => {
    write("sessions.json", "{ not json");
    const plan = await planWipe(file);
    expect(plan.refused).toBeUndefined();
    expect(plan.files.map((f) => f.name)).toEqual(["sessions.json"]);
  });
});

describe("Feature: a write in progress is not interrupted", () => {
  it("Given a fresh lock file, When I apply, Then it is refused until the lock is gone", async () => {
    write("sessions.json");
    write("sessions.json.lock", "");
    const plan = await planWipe(file, { now: () => Date.now() });
    expect(plan.refused).toMatch(/in use|being written|lock/i);
  });

  it("Given a stale lock file, Then it is wiped with the rest", async () => {
    write("sessions.json");
    write("sessions.json.lock", "");
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(path.join(dir, "sessions.json.lock"), old, old);
    const plan = await planWipe(file);
    expect(plan.refused).toBeUndefined();
    expect(plan.files.map((f) => f.name)).toContain("sessions.json.lock");
  });
});

describe("Feature: it follows SCMCP_SESSIONS_FILE", () => {
  it("Given the variable, Then the plan is about that file and its folder", async () => {
    const custom = path.join(dir, "elsewhere.json");
    write("elsewhere.json");
    write("sessions.json");
    const resolved = sessionsFilePath({ SCMCP_SESSIONS_FILE: custom } as NodeJS.ProcessEnv);
    const plan = await planWipe(resolved);
    expect(plan.files.map((f) => f.name)).toEqual(["elsewhere.json"]);
  });
});
