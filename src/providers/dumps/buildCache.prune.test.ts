import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_CACHE_LIMITS, pruneBuildCache } from "./versions.js";

/**
 * Feature: the folder of cached dump collections is pruned, and only files named like ours.
 * It can be moved with SCMCP_BUILD_CACHE_DIR, so it may be a folder the user also keeps other things in.
 */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-builds-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function put(name: string, bytes: number, ageSeconds: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "x".repeat(bytes));
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  fs.utimesSync(file, t, t);
}
const ours = (i: number) => `ships__vehicles__${i.toString(16).padStart(10, "0")}.json`;

describe("Feature: pruneBuildCache", () => {
  it("Given more collections than the limit, Then the oldest go and the one just written stays", async () => {
    const total = BUILD_CACHE_LIMITS.maxFiles + 10;
    for (let i = 0; i < total; i++) put(ours(i), 10, total - i);
    const removed = await pruneBuildCache(dir, ours(0)); // the oldest, but just written
    expect(removed).toHaveLength(10);
    const left = fs.readdirSync(dir);
    expect(left).toHaveLength(BUILD_CACHE_LIMITS.maxFiles);
    expect(left).toContain(ours(0));
    expect(left).not.toContain(ours(1));
  });

  it("Given other files in the folder, Then they are never removed", async () => {
    put("my-notes.txt", 10, 999_999);
    put("ships__vehicles__abc.json.tmp", 10, 999_999);
    put("backup.json", 10, 999_999);
    for (let i = 0; i < BUILD_CACHE_LIMITS.maxFiles + 5; i++) put(ours(i), 10, 1000 - i);
    await pruneBuildCache(dir);
    const left = fs.readdirSync(dir);
    for (const name of ["my-notes.txt", "ships__vehicles__abc.json.tmp", "backup.json"]) {
      expect(left).toContain(name);
    }
  });

  it("Given files that only look like ours, Then every one survives, even the oldest", async () => {
    const lookAlikes = [
      "keepme.json",
      "notes.txt",
      "ships__vehicles__0123456789.json.bak",
      "ships__vehicles__0123456789.JSON",
      "ships__vehicles__012345678.json", // 9 hex
      "ships__vehicles__0123456789a.json", // 11 hex
      "ships__vehicles__0123456789ABCDEF.json",
      "mydata__vehicles__0123456789.json", // a dataset this server does not have
      "ships__vehicles.json",
    ];
    for (const n of lookAlikes) put(n, 10, 9_999_999);
    for (let i = 0; i < BUILD_CACHE_LIMITS.maxFiles + 5; i++) put(ours(i), 10, 1000 - i);
    await pruneBuildCache(dir);
    for (const n of lookAlikes) expect(fs.readdirSync(dir), n).toContain(n);
  });

  it("Given a folder under the limits, Then nothing is removed", async () => {
    for (let i = 0; i < 5; i++) put(ours(i), 10, 100 - i);
    expect(await pruneBuildCache(dir)).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(5);
  });
});
