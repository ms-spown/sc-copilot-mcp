import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { Scmdb, SCMDB_LIMITS } from "./store.js";

/**
 * Feature: what the SCMDB store keeps, in memory and on disk, has a bound.
 *
 * Every commit of the mirror is a new set of files (up to 60 MB each). Without a bound the parsed copies stay in memory
 * for as long as the server lives and the cache folder grows with every commit.
 */

let dir: string;
let t: number;
let sha: string;
let counter = 0;

const changelog = [{ version: "1.0.1", date: "2026-11-01", changes: [] }];

function makeScmdb(limits?: Partial<typeof SCMDB_LIMITS>, body: unknown = changelog): Scmdb {
  const raw = {
    defaults: { baseURL: `https://raw-bounds-${++counter}.test` },
    get: vi.fn(async () => ({ data: body })),
  } as unknown as HttpClient;
  const api = { defaults: {}, get: vi.fn(async () => ({ data: sha })) } as unknown as HttpClient;
  return new Scmdb({ raw, api, repo: "o/r", cacheDir: () => dir, now: () => t, limits });
}
/** A new commit: the cached SHA expires (10 minutes) and the API answers the next one. */
const newCommit = (n: number) => {
  sha = n.toString(16).padStart(2, "0").repeat(20);
  t += 11 * 60_000;
};
const cacheFiles = () => fs.readdirSync(path.join(dir, "scmdb")).sort();
/** Date the files of commit n in the order of the commits (file times tie on a fast loop). */
const age = (n: number) => {
  const prefix = n.toString(16).padStart(2, "0");
  const when = (Date.now() - (100 - n) * 60_000) / 1000;
  for (const f of cacheFiles()) {
    if (f.startsWith(prefix)) fs.utimesSync(path.join(dir, "scmdb", f), when, when);
  }
};
/** Read the changelog at each of commits 1..n, as a long-lived server would. */
async function readCommits(s: Scmdb, n: number) {
  for (let i = 1; i <= n; i++) {
    newCommit(i);
    await s.changelog();
    age(i);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmdb-bounds-"));
  configureDiskCache(null);
  clearCache();
  t = Date.UTC(2026, 10, 4);
  sha = "aa".repeat(20);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Feature: parsed files are kept for the newest only", () => {
  it("Given a hundred commits, When each is read, Then the parsed copies never exceed the limit", async () => {
    const s = makeScmdb();
    for (let i = 1; i <= 100; i++) {
      newCommit(i);
      await s.changelog();
      expect(s.parsedEntries).toBeLessThanOrEqual(SCMDB_LIMITS.maxParsedEntries);
    }
    expect(s.parsedEntries).toBe(SCMDB_LIMITS.maxParsedEntries);
  });

  it("Given a byte budget, When big files are read, Then the oldest parsed copy is dropped, the newest is kept", async () => {
    const big = [{ version: "1", pad: "x".repeat(10_000) }];
    const s = makeScmdb({ maxParsedBytes: 25_000 }, big);
    for (let i = 1; i <= 5; i++) {
      newCommit(i);
      await s.changelog();
    }
    expect(s.parsedEntries).toBe(2); // two copies of about 10 kB fit in 25 kB
    expect(s.parsedBytes).toBeLessThanOrEqual(25_000);
  });

  it("Given a single copy bigger than the budget, Then it is still served (and kept alone)", async () => {
    const big = [{ version: "1", pad: "x".repeat(10_000) }];
    const s = makeScmdb({ maxParsedBytes: 1_000 }, big);
    newCommit(1);
    expect(((await s.changelog()).data as unknown[]).length).toBe(1);
    expect(s.parsedEntries).toBe(1);
  });

  it("Given a file read again, Then it is served from memory without a new download", async () => {
    const s = makeScmdb();
    newCommit(1);
    const first = await s.changelog();
    expect(await s.changelog()).toBe(first);
  });
});

describe("Feature: the cache folder keeps the newest commits only", () => {
  it("Given six commits, Then only the files of the newest three remain on disk", async () => {
    const s = makeScmdb();
    await readCommits(s, 6);
    const kept = cacheFiles();
    expect(kept).toHaveLength(SCMDB_LIMITS.keepCommits);
    expect(kept.every((n) => /^(04|05|06)/.test(n))).toBe(true);
  });

  it("Given a foreign file in the folder, Then it is never removed", async () => {
    fs.mkdirSync(path.join(dir, "scmdb"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scmdb", "notes.txt"), "mine");
    const s = makeScmdb();
    await readCommits(s, 6);
    expect(cacheFiles()).toContain("notes.txt");
  });

  it("Given the newest copy, Then it is never the one removed", async () => {
    const s = makeScmdb();
    await readCommits(s, 8);
    expect(cacheFiles().some((n) => n.startsWith("08"))).toBe(true);
  });
});

describe("Feature: a file name from the manifest that is only dots is refused", () => {
  const manifest = (name: string) => ({
    schema: 2,
    generated_at: "2026-11-01T00:00:00Z",
    channels: {
      live: {
        version: "9.9.1",
        generated_at: "2026-11-01T00:00:00Z",
        files: { merged: name },
      },
    },
  });

  for (const name of [".", ".."]) {
    it(`Given the manifest names a file "${name}", Then nothing is requested or cached`, async () => {
      const get = vi.fn(async (url: string) => {
        if (url.endsWith("latest.json")) return { data: manifest(name) };
        throw new Error(`fake raw: unexpected ${url}`);
      });
      const raw = { defaults: { baseURL: `https://raw-dots-${++counter}.test` }, get };
      const api = { defaults: {}, get: async () => ({ data: sha }) };
      const s = new Scmdb({
        raw: raw as unknown as HttpClient,
        api: api as unknown as HttpClient,
        repo: "o/r",
        cacheDir: () => dir,
        now: () => t,
      });
      await expect(s.file("live", "merged")).rejects.toThrow(/file name we will not use/);
      expect(get.mock.calls.map((c) => c[0]).filter((u) => !u.endsWith("latest.json"))).toEqual([]);
      expect(fs.existsSync(path.join(dir, "scmdb"))).toBe(false);
    });
  }
});
