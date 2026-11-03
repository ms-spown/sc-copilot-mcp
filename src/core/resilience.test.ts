import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuardedClient } from "./http.js";
import { createRateLimiter, isRetriableStatus, retryDelay } from "./resilience.js";

/** Feature: a flaky upstream does not spoil a question, and a request the server refused is not repeated. */

let server: http.Server;
let port: number;
let hits: string[];
/** What the next requests to each path answer, in order; the last entry repeats. */
let script: Record<string, { status: number; headers?: Record<string, string> }[]>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const steps = script[path] ?? [{ status: 200 }];
    const step = steps[Math.min(hits.filter((h) => h === path).length - 1, steps.length - 1)];
    res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
    res.end(JSON.stringify({ path, status: step.status }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
beforeEach(() => {
  hits = [];
  script = {};
});

const waits: number[] = [];
const client = (options: { retries?: number; ratePerMinute?: number; now?: () => number } = {}) =>
  createGuardedClient({
    baseURL: `http://127.0.0.1:${port}`,
    allowedHosts: ["127.0.0.1"],
    allowInsecureHttp: true,
    userAgent: "test",
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });

describe("Feature: retrying what is worth retrying", () => {
  beforeEach(() => {
    waits.length = 0;
  });

  describe("Scenario: the upstream hiccups", () => {
    it("Given two 503s then success, When I ask, Then I get the answer after two short waits", async () => {
      script["/x"] = [{ status: 503 }, { status: 503 }, { status: 200 }];
      const r = await client().get("/x");
      expect(r.status).toBe(200);
      expect(hits).toEqual(["/x", "/x", "/x"]);
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeLessThan(waits[1]);
    });

    it("Given it keeps failing, Then it gives up after the configured tries with the upstream's own error", async () => {
      script["/x"] = [{ status: 502 }];
      await expect(client({ retries: 2 }).get("/x")).rejects.toMatchObject({
        response: { status: 502 },
      });
      expect(hits).toHaveLength(3); // the first try plus two retries
    });

    it("Given retries are off, Then there is exactly one request", async () => {
      script["/x"] = [{ status: 503 }];
      await expect(client({ retries: 0 }).get("/x")).rejects.toBeTruthy();
      expect(hits).toHaveLength(1);
    });
  });

  describe("Scenario: the upstream refused the request", () => {
    it.each([400, 401, 403, 404])(
      "Given HTTP %i, Then it is not repeated: the answer will not change",
      async (status) => {
        script["/x"] = [{ status }];
        await expect(client().get("/x")).rejects.toMatchObject({ response: { status } });
        expect(hits).toHaveLength(1);
        expect(waits).toEqual([]);
      },
    );
  });

  describe("Scenario: I am rate limited", () => {
    it("Given a short Retry-After, Then it waits exactly that long and tries again", async () => {
      script["/x"] = [{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }];
      const r = await client().get("/x");
      expect(r.status).toBe(200);
      expect(waits).toEqual([2000]);
    });

    it("Given a long Retry-After, Then it does not make the question wait, and says what happened", async () => {
      script["/x"] = [{ status: 429, headers: { "retry-after": "120" } }];
      await expect(client().get("/x")).rejects.toMatchObject({ response: { status: 429 } });
      expect(hits).toHaveLength(1);
    });
  });

  describe("Scenario: nobody answers", () => {
    it("Given the server is down, Then it retries and then fails with a network error", async () => {
      const dead = createGuardedClient({
        baseURL: "http://127.0.0.1:1",
        allowedHosts: ["127.0.0.1"],
        allowInsecureHttp: true,
        userAgent: "test",
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      await expect(dead.get("/x")).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(waits).toHaveLength(2);
    });
  });
});

describe("Feature: staying under an upstream's request limit", () => {
  it("Given a limit of 3 a minute, When 4 requests are made, Then the fourth waits for a slot", async () => {
    let t = 0;
    const slept: number[] = [];
    const take = createRateLimiter(3, {
      maxWaitMs: 120_000,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    await take();
    await take();
    await take();
    expect(slept).toEqual([]);
    await take();
    expect(slept).toEqual([60_000]);
  });

  it("Given the wait would be long, Then it fails with a clear message instead of hanging", async () => {
    const take = createRateLimiter(1, { now: () => 0, sleep: async () => {} });
    await take();
    await expect(take()).rejects.toThrow(
      /Local rate limit reached \(1 requests per minute.*Try again in 60 s/,
    );
  });

  it("Given old requests have left the window, Then new ones go straight through", async () => {
    let t = 0;
    const take = createRateLimiter(2, { now: () => t, sleep: async () => {} });
    await take();
    await take();
    t = 61_000;
    await expect(take()).resolves.toBeUndefined();
  });

  it("Given a client with a limit, Then requests beyond it are delayed rather than sent", async () => {
    let t = 0;
    waits.length = 0;
    const limited = createGuardedClient({
      baseURL: `http://127.0.0.1:${port}`,
      allowedHosts: ["127.0.0.1"],
      allowInsecureHttp: true,
      userAgent: "test",
      ratePerMinute: 2,
      maxRateWaitMs: 120_000,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await limited.get("/a");
    await limited.get("/b");
    await limited.get("/c");
    expect(waits).toEqual([60_000]);
    expect(hits).toEqual(["/a", "/b", "/c"]);
  });
});

describe("retry helpers", () => {
  it("knows which statuses say 'try again'", () => {
    expect([undefined, 429, 502, 503, 504].every(isRetriableStatus)).toBe(true);
    expect([200, 400, 401, 403, 404, 500].some(isRetriableStatus)).toBe(false);
  });

  it("backs off, honours a short Retry-After and refuses a long one", () => {
    expect(retryDelay(1, undefined, 5000, () => 0)).toBe(400);
    expect(retryDelay(2, undefined, 5000, () => 0)).toBe(1200);
    expect(retryDelay(5, undefined, 5000, () => 0)).toBe(5000);
    expect(retryDelay(1, "3")).toBe(3000);
    expect(retryDelay(1, "999")).toBeNull();
  });
});
