import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache, fetchWithCache } from "./cache.js";
import type { HttpClient } from "./http.js";

/**
 * Feature: identical questions asked at the same time share one download, and the memory cache is
 * bounded, so requests keyed on a user's numbers (a budget) cannot grow it without end.
 */

let counter = 0;
function slowClient(delayMs = 20) {
  const get = vi.fn(async (url: string, config?: { params?: unknown }) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return { data: { url, params: config?.params ?? null } };
  });
  return {
    client: {
      defaults: { baseURL: `https://inflight-${++counter}.test` },
      get,
    } as unknown as HttpClient,
    get,
  };
}

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: one download for simultaneous identical requests", () => {
  it("Given two simultaneous calls for the same URL, Then the client is asked once and both get the data", async () => {
    const { client, get } = slowClient();
    const [a, b] = await Promise.all([
      fetchWithCache(client, "/commodities_prices_all"),
      fetchWithCache(client, "/commodities_prices_all"),
    ]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(a.data).toEqual(b.data);
    expect(a.fetchedAt).toBe(b.fetchedAt);
    expect(b.cache).toBe("network");
  });

  it("Given different parameters, Then each is its own request", async () => {
    const { client, get } = slowClient();
    await Promise.all([
      fetchWithCache(client, "/x", { params: { a: 1 } }),
      fetchWithCache(client, "/x", { params: { a: 2 } }),
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("Given the shared request fails, Then both callers see the failure and a later call tries again", async () => {
    let fail = true;
    const get = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      if (fail) throw new Error("bad request");
      return { data: { ok: true } };
    });
    const client = {
      defaults: { baseURL: `https://inflight-${++counter}.test` },
      get,
    } as unknown as HttpClient;
    const results = await Promise.allSettled([
      fetchWithCache(client, "/y"),
      fetchWithCache(client, "/y"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(get).toHaveBeenCalledTimes(1);
    fail = false;
    expect((await fetchWithCache(client, "/y")).data).toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("Feature: the memory cache is bounded", () => {
  it("Given thousands of distinct requests, Then the oldest are forgotten and the newest are still served from memory", async () => {
    const { client, get } = slowClient(0);
    for (let i = 0; i < 320; i++) {
      await fetchWithCache(client, "/budget", { params: { investment: i } });
    }
    expect(get).toHaveBeenCalledTimes(320);
    // The newest is still in memory; the oldest was dropped and is fetched again.
    await fetchWithCache(client, "/budget", { params: { investment: 319 } });
    expect(get).toHaveBeenCalledTimes(320);
    await fetchWithCache(client, "/budget", { params: { investment: 0 } });
    expect(get).toHaveBeenCalledTimes(321);
  });
});
