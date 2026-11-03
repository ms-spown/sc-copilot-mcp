import { AxiosError } from "axios";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache, fetchWithCache } from "./cache.js";
import type { HttpClient } from "./http.js";
import { runWithProvenance } from "./provenance.js";

let dir: string;
let counter = 0;

function client(behaviour: () => Promise<{ data: unknown }>) {
  const get = vi.fn(behaviour);
  return {
    c: { defaults: { baseURL: `https://cache-${++counter}.test` }, get } as unknown as HttpClient,
    get,
  };
}

const httpError = (status: number) =>
  new AxiosError(`status ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    data: {},
    statusText: "",
    headers: {},
    config: {} as never,
  });
const networkError = () => new AxiosError("Network Error", "ERR_NETWORK");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-cache-"));
  configureDiskCache(dir);
  clearCache();
});
afterEach(() => {
  configureDiskCache(null);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("fetchWithCache", () => {
  it("keeps the real fetch time on a memory hit, so the reported age is true", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
    const { c } = client(async () => ({ data: { n: 1 } }));
    const first = await fetchWithCache(c, "/x");
    vi.setSystemTime(new Date("2026-11-03T10:03:00Z"));
    const second = await fetchWithCache(c, "/x");
    expect(second.cache).toBe("memory");
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("goes back to the network after the memory TTL", async () => {
    vi.useFakeTimers();
    const { c, get } = client(async () => ({ data: 1 }));
    await fetchWithCache(c, "/x");
    vi.advanceTimersByTime(6 * 60 * 1000);
    await fetchWithCache(c, "/x");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a network error", networkError],
    ["an HTTP 503", () => httpError(503)],
    ["an HTTP 429", () => httpError(429)],
  ])("serves the last good copy, flagged stale, after %s", async (_label, makeError) => {
    let fail = false;
    const { c } = client(async () => {
      if (fail) throw makeError();
      return { data: { price: 42 } };
    });
    const good = await fetchWithCache(c, "/x");
    clearCache(); // a new process: only the disk copy is left
    fail = true;
    const stale = await fetchWithCache(c, "/x");
    expect(stale.data).toEqual({ price: 42 });
    expect(stale.cache).toBe("stale-disk");
    expect(stale.fetchedAt).toBe(good.fetchedAt);
    expect(stale.staleReason).toMatch(/live request failed/);
  });

  it.each([400, 401, 403, 404])(
    "never hides an HTTP %i behind cached data: a bad token must look like one",
    async (status) => {
      let fail = false;
      const { c } = client(async () => {
        if (fail) throw httpError(status);
        return { data: 1 };
      });
      await fetchWithCache(c, "/x");
      clearCache();
      fail = true;
      await expect(fetchWithCache(c, "/x")).rejects.toThrow(`status ${status}`);
    },
  );

  it("raises the original error when an outage hits and nothing was ever cached", async () => {
    const { c } = client(async () => {
      throw networkError();
    });
    await expect(fetchWithCache(c, "/x")).rejects.toThrow("Network Error");
  });

  it("gives up on a copy that is a week old", async () => {
    vi.useFakeTimers();
    let fail = false;
    const { c } = client(async () => {
      if (fail) throw networkError();
      return { data: 1 };
    });
    await fetchWithCache(c, "/x");
    clearCache();
    vi.advanceTimersByTime(8 * 24 * 3600 * 1000);
    fail = true;
    await expect(fetchWithCache(c, "/x")).rejects.toThrow("Network Error");
  });

  it("records the fetch for the provenance of the running tool call", async () => {
    const { c } = client(async () => ({ data: 1 }));
    const records = await runWithProvenance(async (ctx) => {
      await fetchWithCache(c, "/x");
      await fetchWithCache(c, "/x", undefined, { record: false });
      return ctx.fetches;
    });
    expect(records).toHaveLength(1);
    expect(records[0].cache).toBe("network");
  });

  it("logs the path but never the query parameters, which can hold a player's name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { c } = client(async () => ({ data: 1 }));
    await fetchWithCache(c, "/marketplace_listings", { params: { username: "SecretPilot" } });
    const logged = log.mock.calls.flat().join(" ");
    log.mockRestore();
    expect(logged).toContain("/marketplace_listings");
    expect(logged).not.toContain("SecretPilot");
  });

  it("still answers when the cache directory cannot be written", async () => {
    configureDiskCache(path.join(dir, "file-not-dir", "x"));
    fs.writeFileSync(path.join(dir, "file-not-dir"), "blocker");
    const { c } = client(async () => ({ data: 7 }));
    expect((await fetchWithCache(c, "/x")).data).toBe(7);
  });
});
