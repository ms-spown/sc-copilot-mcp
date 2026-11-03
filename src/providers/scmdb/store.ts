import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchWithCache, isOutage } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { recordFetch, setChannel, setGameVersion } from "../../core/provenance.js";
import { isRepoName } from "../../core/validate.js";

/**
 * SCMDB data (github.com/KrovaxCode/SCMDB_DATA, a mirror with no licence we could find).
 *
 * Nothing here redistributes it: files are read on demand into the user's own cache and
 * answered from in small pieces. `data/latest.json` says which file holds what for LIVE and
 * PTU. Files are fetched at a commit SHA (the `main` branch moves, tags and files get
 * republished) and cached under that SHA, so a republish is picked up, not silently mixed.
 * Every file is checked for the few collections we read before anything uses it.
 */

export type Channel = "live" | "ptu";

const Manifest = z
  .object({
    schema: z.number(),
    generated_at: z.string(),
    channels: z.record(
      z.string(),
      z.object({
        version: z.string(),
        generated_at: z.string(),
        files: z.record(z.string(), z.string()),
      }),
    ),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

const rec = z.record(z.string(), z.unknown());
const named = z.object({ name: z.string() }).passthrough();

/** What each file must contain for the queries to work; anything more is allowed. */
const SHAPES = {
  merged: z
    .object({
      contracts: z.array(z.object({ id: z.string(), title: z.string() }).passthrough()),
      locationPools: z.record(z.string(), named),
      blueprintPools: z.record(z.string(), named),
    })
    .passthrough(),
  crafting_blueprints: z
    .object({ blueprints: z.array(z.object({ guid: z.string() }).passthrough()) })
    .passthrough(),
  mining_data: z
    .object({
      mineableElements: z.record(z.string(), named),
      compositions: rec,
      locations: z.array(z.object({ locationName: z.string() }).passthrough()),
    })
    .passthrough(),
  mining_equipment: z.object({ lasers: z.array(named), modules: z.array(named) }).passthrough(),
  deltas: z
    .object({ pairs: z.array(z.object({ from: z.string(), to: z.string() }).passthrough()) })
    .passthrough(),
  changelog: z.array(z.object({ version: z.string() }).passthrough()),
} as const;
export type FileKind = keyof typeof SHAPES;

export interface Loaded<T = unknown> {
  data: T;
  /** Epoch ms: when this copy was downloaded. */
  fetchedAt: number;
  version: string;
  stale?: string;
}

export interface ScmdbDeps {
  /** raw.githubusercontent.com client */
  raw: HttpClient;
  /** api.github.com client, used only to learn the current commit SHA */
  api: HttpClient;
  repo: string;
  cacheDir: () => string;
  now?: () => number;
}

const REF_TTL_MS = 10 * 60 * 1000;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export class Scmdb {
  private parsed = new Map<string, unknown>();
  private ref: { value: string; at: number } | null = null;

  constructor(private deps: ScmdbDeps) {
    if (!isRepoName(deps.repo)) {
      throw new Error(`SCMCP_SCMDB_REPO must look like "owner/name", got "${deps.repo}".`);
    }
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** The newest commit SHA, or null when GitHub's API cannot be asked (rate limit, outage). */
  private async commitSha(): Promise<string | null> {
    if (this.ref && this.now() - this.ref.at < REF_TTL_MS) return this.ref.value;
    try {
      const r = await this.deps.api.get(`/repos/${this.deps.repo}/commits/main`, {
        headers: { Accept: "application/vnd.github.sha" },
        responseType: "text",
      });
      const sha = String(r.data).trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) return null;
      this.ref = { value: sha, at: this.now() };
      return sha;
    } catch {
      return null;
    }
  }

  async manifest(): Promise<{ manifest: Manifest; fetchedAt: number; stale?: string }> {
    const r = await fetchWithCache(this.deps.raw, `/${this.deps.repo}/main/data/latest.json`);
    const parsed = Manifest.safeParse(r.data);
    if (!parsed.success) {
      throw new Error("SCMDB latest.json has an unexpected shape; the format may have changed.");
    }
    if (parsed.data.schema !== 2) {
      throw new Error(
        `SCMDB latest.json is schema ${parsed.data.schema}; only schema 2 is supported.`,
      );
    }
    return {
      manifest: parsed.data,
      fetchedAt: r.fetchedAt,
      ...(r.cache === "stale-disk" ? { stale: r.staleReason } : {}),
    };
  }

  /** Version and file name for a channel; PTU may be absent when no PTU build is up. */
  async channelInfo(channel: Channel) {
    const { manifest, fetchedAt, stale } = await this.manifest();
    const info = manifest.channels[channel];
    if (!info) throw new Error(`SCMDB has no ${channel.toUpperCase()} build right now.`);
    return { info, fetchedAt, stale };
  }

  /** A data file of a channel, by the kind of content it holds. */
  async file(channel: Channel, kind: Exclude<FileKind, "deltas" | "changelog">): Promise<Loaded> {
    const { info } = await this.channelInfo(channel);
    const name = info.files[kind];
    if (!name) throw new Error(`SCMDB lists no "${kind}" file for ${channel.toUpperCase()}.`);
    return this.load(name, kind, info.version, channel, info.generated_at);
  }

  async deltas(channel: Channel): Promise<Loaded> {
    const { info } = await this.channelInfo(channel);
    return this.load(`deltas-${channel}.json`, "deltas", info.version, channel, info.generated_at);
  }

  async changelog(): Promise<Loaded> {
    return this.load("changelog.json", "changelog", "n/a", undefined, "");
  }

  private async load(
    name: string,
    kind: FileKind,
    version: string,
    channel: Channel | undefined,
    generatedAt: string,
  ): Promise<Loaded> {
    if (!SAFE_NAME.test(name)) throw new Error(`SCMDB gave a file name we will not use: ${name}`);
    if (channel) {
      setChannel(channel);
      setGameVersion(version);
    }

    const sha = await this.commitSha();
    // Without a SHA, fall back to the branch and key the cache on the manifest's own timestamp.
    const ref = sha ?? "main";
    const key = sha ? sha.slice(0, 12) : `main-${generatedAt.replace(/\D/g, "") || "x"}`;
    const memoryKey = `${key}|${name}`;
    const file = path.join(this.deps.cacheDir(), "scmdb", `${key}__${name}`);

    const memo = this.parsed.get(memoryKey) as Loaded | undefined;
    if (memo) {
      recordFetch({ fetchedAt: memo.fetchedAt, cache: "memory" });
      return memo;
    }

    const finish = (
      data: unknown,
      fetchedAt: number,
      cache: "network" | "memory",
      stale?: string,
    ) => {
      const checked = SHAPES[kind].safeParse(data);
      if (!checked.success) {
        const where = checked.error.issues[0]?.path.join(".") || "(root)";
        throw new Error(
          `SCMDB file ${name} has an unexpected shape at "${where}"; the format may have changed.`,
        );
      }
      const loaded: Loaded = { data, fetchedAt, version, ...(stale ? { stale } : {}) };
      if (!stale) this.parsed.set(memoryKey, loaded);
      recordFetch({
        fetchedAt,
        cache: stale ? "stale-disk" : cache,
        ...(stale ? { staleReason: stale } : {}),
      });
      return loaded;
    };

    try {
      // One handle for the size/time and the content, so the file cannot change in between.
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        return finish(JSON.parse(await handle.readFile("utf8")), stat.mtimeMs, "memory");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SCMDB")) throw error;
      // Not cached under this SHA (or unreadable): download it.
    }

    try {
      const response = await this.deps.raw.get(`/${this.deps.repo}/${ref}/data/${name}`, {
        responseType: "json",
        timeout: 120_000,
        maxContentLength: 60 * 1024 * 1024,
      } as never);
      const result = finish(response.data, this.now(), "network");
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(response.data));
        await fs.rename(tmp, file);
      } catch {
        // A read-only cache folder only costs a re-download next time.
      }
      return result;
    } catch (error) {
      if (!isOutage(error)) throw error;
      const older = await this.newestCopy(name);
      if (!older) throw error;
      return finish(
        JSON.parse(await fs.readFile(older.file, "utf8")),
        older.mtime,
        "memory",
        "the live download failed; serving the last copy kept on disk",
      );
    }
  }

  private async newestCopy(name: string): Promise<{ file: string; mtime: number } | null> {
    const dir = path.join(this.deps.cacheDir(), "scmdb");
    try {
      const matches = (await fs.readdir(dir)).filter((n) => n.endsWith(`__${name}`));
      const stats = await Promise.all(
        matches.map(async (n) => ({
          file: path.join(dir, n),
          mtime: (await fs.stat(path.join(dir, n))).mtimeMs,
        })),
      );
      return stats.sort((a, b) => b.mtime - a.mtime)[0] ?? null;
    } catch {
      return null;
    }
  }
}
