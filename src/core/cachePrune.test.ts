import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneGroups, pruneOldest } from "./cachePrune.js";

/**
 * Feature: the cache folders that grew without end are pruned, and only the files this server wrote.
 * A user may point a cache folder at a shared place (SCMCP_BUILD_CACHE_DIR): files that do not look like ours are
 * never touched.
 */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-prune-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A file of `bytes` bytes whose modification time is `age` seconds ago. */
function put(name: string, bytes: number, age: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x".repeat(bytes));
  const t = (Date.now() - age * 1000) / 1000;
  fs.utimesSync(file, t, t);
}
const names = () => fs.readdirSync(dir).sort();

describe("Feature: pruneOldest removes the oldest files past a count or a size", () => {
  it("Given more files than allowed, Then the oldest go first", async () => {
    for (let i = 0; i < 6; i++) put(`a${i}.json`, 10, 100 - i); // a0 is the oldest
    const removed = await pruneOldest(dir, { maxFiles: 4, maxBytes: 1e9 });
    expect(removed.sort()).toEqual(["a0.json", "a1.json"]);
    expect(names()).toEqual(["a2.json", "a3.json", "a4.json", "a5.json"]);
  });

  it("Given more bytes than allowed, Then the oldest go until it fits", async () => {
    for (let i = 0; i < 5; i++) put(`b${i}.json`, 100, 100 - i);
    await pruneOldest(dir, { maxFiles: 100, maxBytes: 250 });
    expect(names()).toEqual(["b3.json", "b4.json"]);
  });

  it("Given a file that does not look like ours, Then it is never removed, whatever its age", async () => {
    put("notes.txt", 10, 10_000);
    put("c0.json", 10, 100);
    put("c1.json", 10, 50);
    await pruneOldest(dir, { maxFiles: 1, maxBytes: 1e9, accept: (n) => n.endsWith(".json") });
    expect(names()).toEqual(["c1.json", "notes.txt"]);
  });

  it("Given a file to keep, Then it stays even when it is the oldest", async () => {
    put("d0.json", 10, 1000);
    put("d1.json", 10, 10);
    put("d2.json", 10, 5);
    await pruneOldest(dir, { maxFiles: 1, maxBytes: 1e9, keep: ["d0.json"] });
    expect(names()).toContain("d0.json");
  });

  it("Given a missing folder, Then nothing happens and nothing throws", async () => {
    await expect(
      pruneOldest(path.join(dir, "nope"), { maxFiles: 1, maxBytes: 1 }),
    ).resolves.toEqual([]);
  });
});

describe("Feature: pruneGroups keeps the newest groups of files", () => {
  const groupOf = (n: string) => /^([0-9a-f]{12})__/.exec(n)?.[1] ?? null;

  it("Given files of five commits, Then only the files of the newest three remain", async () => {
    for (let c = 0; c < 5; c++) {
      const sha = String(c).repeat(12);
      put(`${sha}__merged.json`, 10, 1000 - c * 100);
      put(`${sha}__deltas.json`, 10, 1000 - c * 100 + 1);
    }
    const removed = await pruneGroups(dir, groupOf, 3);
    expect(removed).toHaveLength(4);
    expect(names().every((n) => /^[234]{12}__/.test(n))).toBe(true);
    expect(names()).toHaveLength(6);
  });

  it("Given a file with no group, Then it is left alone", async () => {
    put("readme.txt", 10, 99_999);
    for (let c = 0; c < 4; c++) put(`${String(c).repeat(12)}__x.json`, 10, 500 - c * 10);
    await pruneGroups(dir, groupOf, 1);
    expect(names()).toContain("readme.txt");
    expect(names()).toHaveLength(2);
  });
});
