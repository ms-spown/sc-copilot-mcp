import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheStats,
  clearCache,
  configureDiskCache,
  configureMemoryCache,
  fetchWithCache,
} from "./cache.js";
import type { HttpClient } from "./http.js";

/**
 * Feature: the memory cache is bounded by size as well as by count.
 * 300 entries of 25 MB (the response cap) would be 7.5 GB; the budget counts the JSON text of what it keeps.
 */

let counter = 0;
const client = (pad: number): HttpClient =>
  ({
    defaults: { baseURL: `https://bounds-${++counter}.test` },
    get: vi.fn(async (url: string) => ({ data: { url, pad: "x".repeat(pad) } })),
  }) as unknown as HttpClient;

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
  configureMemoryCache(undefined);
});

describe("Feature: the HTTP disk cache is pruned all along the life of the server, not once", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-diskprune-"));
    configureDiskCache(dir);
  });
  afterEach(() => {
    configureDiskCache(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Given 700 different questions in one run, Then the folder never holds much more than its limit of 400 files", async () => {
    const c = client(10);
    for (let i = 0; i < 700; i++) await fetchWithCache(c, `/question-${i}`);
    // Pruned every 50 writes down to 350: at most 400 + 50 files between two prunings.
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(450);
    expect(files.length).toBeGreaterThan(300); // not emptied either
  });
});

describe("Feature: pruning the HTTP disk cache touches only the files the cache wrote", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-diskprune-names-"));
    configureDiskCache(dir);
  });
  afterEach(() => {
    configureDiskCache(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Given files that only look like ours, When the folder is pruned, Then every one survives (even the oldest)", async () => {
    const hex = "0123456789abcdef".repeat(4); // 64
    const lookAlikes = [
      "keepme.json",
      "notes.txt",
      `${hex}.json.bak`,
      `${hex}.JSON`,
      `${hex.slice(1)}.json`, // 63
      `${hex}0.json`, // 65
      `${hex.toUpperCase()}.json`, // not the lower-case hex the cache writes
      `${hex}.json.tmp`,
    ];
    const old = (Date.now() - 365 * 86_400_000) / 1000;
    for (const n of lookAlikes) {
      fs.writeFileSync(path.join(dir, n), "mine");
      fs.utimesSync(path.join(dir, n), old, old);
    }
    const c = client(10);
    for (let i = 0; i < 700; i++) await fetchWithCache(c, `/question-${i}`);
    for (const n of lookAlikes) expect(fs.existsSync(path.join(dir, n)), n).toBe(true);
    // ... and the real ones were pruned all the same
    const ours = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
    expect(ours.length).toBeLessThanOrEqual(450);
  });
});

describe("Feature: a byte budget on the memory cache", () => {
  it("Given answers of 10 kB and a budget of 35 kB, When ten are fetched, Then at most three stay", async () => {
    configureMemoryCache({ maxBytes: 35_000 });
    const c = client(10_000);
    for (let i = 0; i < 10; i++) await fetchWithCache(c, `/n${i}`);
    const stats = cacheStats();
    expect(stats.entries).toBe(3);
    expect(stats.bytes).toBeLessThanOrEqual(35_000);
  });

  it("Given the budget, Then it is the OLDEST answers that go, the newest stays and is served from memory", async () => {
    configureMemoryCache({ maxBytes: 35_000 });
    const c = client(10_000);
    for (let i = 0; i < 6; i++) await fetchWithCache(c, `/n${i}`);
    expect((await fetchWithCache(c, "/n5")).cache).toBe("memory");
    expect((await fetchWithCache(c, "/n0")).cache).toBe("network");
  });

  it("Given one answer bigger than the whole budget, Then it is served but not kept in memory", async () => {
    configureMemoryCache({ maxBytes: 5_000 });
    const c = client(10_000);
    const first = await fetchWithCache(c, "/big");
    expect(first.data.pad).toHaveLength(10_000);
    expect(cacheStats().entries).toBe(0);
    expect((await fetchWithCache(c, "/big")).cache).toBe("network");
  });

  it("Given small answers, Then the count bound still applies", async () => {
    configureMemoryCache({ maxEntries: 5 });
    const c = client(10);
    for (let i = 0; i < 12; i++) await fetchWithCache(c, `/n${i}`);
    expect(cacheStats().entries).toBe(5);
  });

  it("Given the defaults, Then the budget is large enough for ordinary use and finite", async () => {
    const c = client(1_000);
    for (let i = 0; i < 20; i++) await fetchWithCache(c, `/n${i}`);
    expect(cacheStats().entries).toBe(20);
    expect(cacheStats().maxBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(Number.isFinite(cacheStats().maxBytes)).toBe(true);
  });
});
