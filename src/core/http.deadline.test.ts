import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { clearCache, configureDiskCache, fetchWithCache } from "./cache.js";
import { DEFAULT_TIMEOUT_MS, createGuardedClient, totalDeadlineMs } from "./http.js";

/**
 * Feature: a request has a TOTAL deadline, not only an idle timeout.
 *
 * axios' `timeout` restarts at every byte, so an upstream that sends a byte now and then (a stuck or hostile one) keeps
 * a request, and every identical question waiting behind it, alive for as long as it likes. Here a loopback server
 * drips bytes forever; the guarded client must give up at its deadline whatever arrives.
 */

const DEADLINE_MS = 400;

let server: http.Server;
let port: number;
let mode: "drip" | "fast" = "drip";
let requests = 0;
const dripping = new Set<NodeJS.Timeout>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    if (mode === "fast") {
      res.end(JSON.stringify({ data: "fresh" }));
      return;
    }
    // One byte every 20 ms, for at most 8 s so that a missing deadline ends in a failed assertion, not in a hang.
    res.write("[");
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (sent > 400) {
        clearInterval(timer);
        dripping.delete(timer);
        res.end("1]");
      } else res.write("1,");
    }, 20);
    dripping.add(timer);
    req.on("close", () => {
      clearInterval(timer);
      dripping.delete(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const timer of dripping) clearInterval(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mode = "drip";
  requests = 0;
  clearCache();
  configureDiskCache(null);
});

function client(extra: { deadlineMs?: number; timeoutMs?: number; retries?: number } = {}) {
  return createGuardedClient({
    baseURL: `http://127.0.0.1:${port}`,
    allowedHosts: ["127.0.0.1"],
    allowInsecureHttp: true,
    userAgent: "test",
    retries: 0,
    deadlineMs: DEADLINE_MS,
    ...extra,
  });
}

describe("Feature: the guarded client ends a request at its total deadline", () => {
  it("Given a server that keeps sending, When the deadline passes, Then the request fails as a timeout", async () => {
    // The idle timeout (30 s) never fires: a byte arrives every 20 ms.
    const failure = await client({ timeoutMs: DEFAULT_TIMEOUT_MS })
      .get("/slow")
      .then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string; response?: unknown },
      );
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("ECONNABORTED");
    expect(failure?.message).toMatch(/deadline/i);
    expect(failure?.response).toBeUndefined(); // an outage, so the cached copy may stand in
  });

  it("Given a deadline, Then a failed request is not retried into a second wait", async () => {
    mode = "drip";
    await client({ retries: 2 })
      .get("/slow")
      .catch(() => undefined);
    expect(requests).toBe(1);
  });

  it("Given a fast server, Then the deadline changes nothing", async () => {
    mode = "fast";
    const response = await client().get("/ok");
    expect(response.data).toEqual({ data: "fresh" });
  });

  it("Given no option, Then the deadline is one and a half times the idle timeout", () => {
    expect(totalDeadlineMs({})).toBe(Math.round(DEFAULT_TIMEOUT_MS * 1.5));
    expect(totalDeadlineMs({ timeoutMs: 120_000 })).toBe(180_000);
    expect(totalDeadlineMs({ timeoutMs: 120_000, deadlineMs: 5_000 })).toBe(5_000);
  });
});

describe("Feature: a stuck request does not trap the questions behind it", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Given a hung request, When it times out, Then the next identical question makes a new request", async () => {
    const c = client();
    await expect(fetchWithCache(c, "/same")).rejects.toMatchObject({ code: "ECONNABORTED" });
    mode = "fast";
    const next = await fetchWithCache(c, "/same");
    expect(next.data).toEqual({ data: "fresh" });
    expect(next.cache).toBe("network");
    expect(requests).toBe(2);
  });

  it("Given two identical questions at once, When the upstream hangs, Then both end at the deadline", async () => {
    const c = client();
    const [a, b] = await Promise.allSettled([
      fetchWithCache(c, "/same"),
      fetchWithCache(c, "/same"),
    ]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(requests).toBe(1); // the second joined the first
    mode = "fast";
    expect((await fetchWithCache(c, "/same")).data).toEqual({ data: "fresh" });
  });

  it("Given a good copy on disk, When the upstream hangs, Then the copy is served as stale", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-deadline-"));
    configureDiskCache(dir);
    const c = client();
    mode = "fast";
    await fetchWithCache(c, "/kept");
    clearCache(); // memory empty, disk keeps the copy
    mode = "drip";
    const stale = await fetchWithCache(c, "/kept");
    expect(stale.cache).toBe("stale-disk");
    expect(stale.data).toEqual({ data: "fresh" });
  });
});
