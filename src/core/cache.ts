import axios, { type AxiosRequestConfig } from "axios";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HttpClient } from "./http.js";
import { userCacheDir } from "./paths.js";
import { recordFetch, type CacheState } from "./provenance.js";

/**
 * GET with a two-level cache.
 *
 *  - Memory, 5 minutes: spares the upstreams on repeated questions. A hit keeps the time the
 *    data was really fetched, so its reported age is true.
 *  - Disk: every successful response is kept, and read back ONLY when the live request fails
 *    for a reason that says the upstream is unreachable (no response, timeout, HTTP 5xx or 429).
 *    The answer is then flagged stale. A 400, 401 or 404 is never papered over with old data:
 *    a rejected token served from cache is an outage that looks like a success.
 */

const MEMORY_TTL_MS = 5 * 60 * 1000;
const STALE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DISK_BYTES = 5 * 1024 * 1024;
const MAX_DISK_FILES = 400;
/** Entries kept in memory. Requests keyed on a user's numbers (a budget, a cargo size) would otherwise grow it without end. */
const MAX_MEMORY_ENTRIES = 300;

export interface Fetched {
  // Upstream JSON, indexed directly by the handlers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  /** When the data was fetched from the upstream, in epoch ms. */
  fetchedAt: number;
  cache: CacheState;
  staleReason?: string;
}

const memory = new Map<string, { data: unknown; fetchedAt: number }>();
/** Requests on their way: a second identical question (two tools, two clicks) waits for the first instead of downloading again. */
const inflight = new Map<string, Promise<{ data: unknown; fetchedAt: number }>>();
let diskDir: string | null | undefined; // undefined = default location, null = disabled
let pruned = false;

/** Point the disk cache elsewhere, or null to disable it. Tests use this; the server does not. */
export function configureDiskCache(dir: string | null | undefined): void {
  diskDir = dir;
  pruned = false;
}

function diskPath(key: string): string | null {
  const dir = diskDir === undefined ? path.join(userCacheDir(), "http") : diskDir;
  if (dir === null) return null;
  return path.join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

async function pruneDisk(dir: string): Promise<void> {
  if (pruned) return;
  pruned = true;
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
    if (names.length <= MAX_DISK_FILES) return;
    const stats = await Promise.all(
      names.map(async (n) => ({ n, t: (await fs.stat(path.join(dir, n))).mtimeMs })),
    );
    stats.sort((a, b) => a.t - b.t);
    for (const { n } of stats.slice(0, names.length - MAX_DISK_FILES + 50)) {
      await fs.rm(path.join(dir, n), { force: true });
    }
  } catch {
    // Pruning is housekeeping; never let it break a request.
  }
}

async function writeDisk(key: string, entry: { data: unknown; fetchedAt: number }): Promise<void> {
  const file = diskPath(key);
  if (!file) return;
  try {
    const body = JSON.stringify(entry);
    if (body.length > MAX_DISK_BYTES) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    await pruneDisk(path.dirname(file));
  } catch {
    // A full or read-only disk must not turn a good answer into a failure.
  }
}

async function readDisk(key: string): Promise<{ data: unknown; fetchedAt: number } | null> {
  const file = diskPath(key);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed?.fetchedAt === "number" && "data" in parsed) return parsed;
  } catch {
    // Missing or corrupt: no fallback available.
  }
  return null;
}

/** True when the failure says "the upstream is unreachable", the only case old data may stand in for. */
export function isOutage(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 429;
}

function describeOutage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return error.response ? `HTTP ${error.response.status}` : error.code || error.message;
  }
  return error instanceof Error ? error.message : "request failed";
}

export async function fetchWithCache(
  client: HttpClient,
  url: string,
  config?: AxiosRequestConfig,
  options: { record?: boolean } = {},
): Promise<Fetched> {
  const record = options.record !== false;
  const base = client.defaults?.baseURL || "";
  const key = base + url + JSON.stringify(config?.params || {});
  // Log the path only: query parameters can carry a player's name.
  const label = base + url;

  const finish = (fetched: Fetched): Fetched => {
    if (record) {
      recordFetch({
        fetchedAt: fetched.fetchedAt,
        cache: fetched.cache,
        staleReason: fetched.staleReason,
      });
    }
    return fetched;
  };

  const hit = memory.get(key);
  if (hit && Date.now() - hit.fetchedAt < MEMORY_TTL_MS) {
    console.error(`[Cache Hit] ${label}`);
    return finish({ data: hit.data, fetchedAt: hit.fetchedAt, cache: "memory" });
  }

  const pending = inflight.get(key);
  if (pending) {
    console.error(`[Cache Join] ${label}`);
    try {
      return finish({ ...(await pending), cache: "network" });
    } catch (error) {
      if (!isOutage(error)) throw error;
      // The shared request failed with an outage: fall through to the same stale-copy rule as the first caller.
      return serveStale(error);
    }
  }

  console.error(`[Cache Miss] ${label}`);
  try {
    const request = (async () => {
      const response = await client.get(url, config);
      const entry = { data: response.data, fetchedAt: Date.now() };
      remember(key, entry);
      await writeDisk(key, entry);
      return entry;
    })();
    inflight.set(key, request);
    request.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
    return finish({ ...(await request), cache: "network" });
  } catch (error) {
    if (!isOutage(error)) throw error;
    return serveStale(error);
  }

  async function serveStale(error: unknown): Promise<Fetched> {
    if (!isOutage(error)) throw error;
    const old =
      (await readDisk(key)) ?? (hit ? { data: hit.data, fetchedAt: hit.fetchedAt } : null);
    if (!old || Date.now() - old.fetchedAt > STALE_MAX_AGE_MS) throw error;
    console.error(`[Cache Stale] ${label} (${describeOutage(error)})`);
    return finish({
      data: old.data,
      fetchedAt: old.fetchedAt,
      cache: "stale-disk",
      staleReason: `live request failed (${describeOutage(error)}); serving the last good copy`,
    });
  }
}

/** Keep an answer in memory, dropping the oldest entries past the bound. */
function remember(key: string, entry: { data: unknown; fetchedAt: number }): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

/** Empty the memory cache. Used by tests; the server never needs it. */
export function clearCache(): void {
  memory.clear();
  inflight.clear();
}
