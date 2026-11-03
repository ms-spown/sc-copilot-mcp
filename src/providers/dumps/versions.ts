/**
 * Historical game data across patches.
 *
 * A data repo commits one dump of `game-*.json` per game build and tags that
 * commit with the build string, so the tag list *is* the patch history. Both
 * the wiki API and UEX only ever expose whatever build they are currently
 * synced to, which makes this the only source that can answer a question about
 * a *past* patch.
 *
 * The dumps come from the same extract + parse pipeline as the local
 * `SCMCP_GAME_DATA_DIR` files, so a domain readable offline is diffable here
 * with the same field names. Point SCMCP_DATA_REPO at a fork to use another.
 */

import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { ALLOWED_HOSTS, createGuardedClient } from "../../core/http.js";
import { userCacheDir } from "../../core/paths.js";
import { isRepoName } from "../../core/validate.js";
import { USER_AGENT } from "../../core/useragent.js";
import { cleanLabel, remoteText } from "../../core/untrusted.js";

const REPO = process.env.SCMCP_DATA_REPO || "voidput/sc-gamedata-dumps";
const DATA_PATH = process.env.SCMCP_DATA_REPO_PATH || "data";
const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";

// Both values end up inside request URLs, so only plain owner/name and path segments pass.
if (!isRepoName(REPO)) {
  throw new Error(`SCMCP_DATA_REPO must look like "owner/name", got "${REPO}".`);
}
if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(DATA_PATH) || DATA_PATH.includes("..")) {
  throw new Error(`SCMCP_DATA_REPO_PATH must be a relative path without "..", got "${DATA_PATH}".`);
}

/**
 * Every dump is an envelope of named collections rather than a bare array, so
 * each dataset declares the collection to diff by default. The `by*` keys in
 * these files are derived indexes over the same records — diffing one would
 * double-count — so a default always points at the collection of record.
 */
export const DATASETS = {
  ships: { file: "game-ships.json", collection: "vehicles" },
  "ship-components": { file: "game-ship-components.json", collection: "weapons" },
  "fps-weapons": { file: "game-fps-weapons.json", collection: "weapons" },
  ammo: { file: "game-ammo.json", collection: "ammo" },
  mining: { file: "game-mining.json", collection: "mineableElements" },
  "mining-spawns": { file: "game-mining-spawns.json", collection: "locations" },
  blueprints: { file: "game-blueprints.json", collection: "blueprints" },
  missions: { file: "game-missions.json", collection: "missions" },
  reputation: { file: "game-reputation.json", collection: "standings" },
  containers: { file: "game-containers.json", collection: "containers" },
  starmap: { file: "game-starmap.json", collection: "locations" },
  manufacturers: { file: "game-manufacturers.json", collection: "manufacturers" },
  "wikelo-trades": { file: "game-wikelo-trades.json", collection: "trades" },
  strings: { file: "game-strings-english.json", collection: "strings" },
} as const;

export type DatasetName = keyof typeof DATASETS;

/** Keys the parser adds for provenance rather than as game content. */
const META_KEYS = new Set(["_source", "_extracted", "_build", "_extraction-validation", "summary"]);

/** Dumps are megabytes each and immutable per tag, so they are cached on disk. */
const CACHE_DIR = process.env.SCMCP_BUILD_CACHE_DIR || path.join(userCacheDir(), "builds");

// The GitHub token (optional, only raises the rate limit) goes to api.github.com and nowhere else.
const ghClient = createGuardedClient({
  baseURL: GITHUB_API,
  allowedHosts: ALLOWED_HOSTS.githubApi,
  userAgent: USER_AGENT,
  headers: { Accept: "application/vnd.github+json" },
  // Dedicated variable on purpose: an ambient GITHUB_TOKEN often has far wider scopes than needed.
  token: process.env.SCMCP_GITHUB_TOKEN,
});

// Raw dump downloads are public, so this client never carries a token.
const rawClient = createGuardedClient({
  baseURL: RAW_BASE,
  allowedHosts: ALLOWED_HOSTS.githubRaw,
  userAgent: USER_AGENT,
  timeoutMs: 120_000,
});

/**
 * Turn a failed dump fetch into something a user can act on.
 *
 * The data repo is a fan project that can be taken down, renamed, or made
 * private, and SCMCP is configured to read it by default. When that happens
 * every patch-history tool must say so plainly — the alternative is a bare
 * axios 404 surfacing as if SCMCP itself were broken. Every other tool in this
 * server keeps working; only the cross-patch ones depend on this repo.
 */
export function describeFetchFailure(status: number | undefined, what: string): string {
  if (status === 404) {
    return `Patch history is unavailable: ${what} was not found in ${REPO}. That repo publishes the per-build dumps SCMCP compares; if it has moved, point SCMCP_DATA_REPO at another. Every non-historical tool is unaffected.`;
  }
  if (status === 403 || status === 429) {
    return `GitHub rate-limited the request for ${what}. Set SCMCP_GITHUB_TOKEN to raise the limit.`;
  }
  return `Could not read ${what} from ${REPO}${status ? ` (HTTP ${status})` : ""}.`;
}

export interface Build {
  version: string;
  sha: string;
  date: string;
}

/** A collection entry, keyed by its own object key or its array index. */
export type Entry = [key: string, record: unknown];

/**
 * List the game builds that have a tagged dump, newest first.
 *
 * Tags carry no date of their own, so one extra commits call maps sha -> date;
 * builds older than that page keep the order GitHub returned them in.
 */
export async function listBuilds(limit = 40): Promise<Build[]> {
  const perPage = Math.min(Math.max(limit, 1), 100);
  let tagsResponse, commitsResponse;
  try {
    [tagsResponse, commitsResponse] = await Promise.all([
      ghClient.get(`/repos/${REPO}/tags`, { params: { per_page: perPage } }),
      ghClient.get(`/repos/${REPO}/commits`, { params: { per_page: 100 } }),
    ]);
  } catch (error) {
    throw new Error(
      describeFetchFailure(
        axios.isAxiosError(error) ? error.response?.status : undefined,
        "the build list",
      ),
      { cause: error },
    );
  }

  const dates = new Map<string, string>();
  for (const commit of commitsResponse.data ?? []) {
    dates.set(commit.sha, cleanLabel(commit.commit?.author?.date)?.slice(0, 10) ?? "");
  }

  const builds: Build[] = [];
  const seen = new Set<string>();

  for (const tag of tagsResponse.data ?? []) {
    // A tag name is third-party text (the repository is configurable): cleaned and bounded where it enters.
    const version: string = cleanLabel(tag.name) ?? "";
    const sha: string | undefined = tag.commit?.sha;
    // Anything that is not a build string (a "v1.0.0" release tag, say) is not
    // a patch and must not show up as one.
    // The sha ends up in a cache file name and a URL: only a full hex commit id is accepted, so a
    // malformed or hostile API answer cannot steer either.
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    // A build string has no spaces: a "tag" that carries a sentence is not a patch.
    if (!/^\d+\.\d+[A-Za-z0-9._+-]*$/.test(version) || seen.has(version)) continue;
    seen.add(version);
    builds.push({ version, sha, date: dates.get(sha) ?? "" });
  }

  if (builds.length === 0) {
    throw new Error(
      `${REPO} has no build tags yet, so there is no patch history to compare. Publish a dump, or point SCMCP_DATA_REPO elsewhere.`,
    );
  }

  // Undated builds are older than the commits page, so an empty date sorts last.
  return builds.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

/**
 * Resolve a user-supplied version to a build. Accepts an exact build string, a
 * prefix such as "4.9", or a commit sha.
 */
export async function resolveBuild(version: string): Promise<Build> {
  const builds = await listBuilds(100);
  const needle = version.trim().toLowerCase();

  const exact = builds.find((b) => b.version.toLowerCase() === needle);
  if (exact) return exact;

  const bySha = builds.find((b) => b.sha.startsWith(needle));
  if (bySha) return bySha;

  // Prefix match: "4.9" should find the newest 4.9.x build, not 4.9 vs 4.10 ambiguously.
  const prefixed = builds.filter(
    (b) =>
      b.version.toLowerCase().startsWith(needle + ".") ||
      b.version.toLowerCase().startsWith(needle + "-"),
  );
  if (prefixed.length > 0) return prefixed[0];

  throw new Error(
    `No build matching "${version}". Available: ${builds
      .slice(0, 12)
      .map((b) => b.version)
      .join(", ")}`,
  );
}

/** Normalise a collection to [key, record] pairs, for arrays and objects alike. */
function entriesOf(collection: unknown): Entry[] {
  if (Array.isArray(collection)) return collection.map((v, i) => [String(i), v]);
  if (collection && typeof collection === "object") {
    return Object.entries(collection as Record<string, unknown>);
  }
  return [];
}

/** A collection name goes into a cache file name: plain characters only, nothing that climbs a path. */
export function isSafeCollectionName(name: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes("..");
}

/** The cache file of one collection at one build. Throws when the name could leave the cache folder. */
export function cachePathFor(dataset: string, wanted: string, sha: string): string {
  if (!isSafeCollectionName(wanted)) {
    throw new Error(
      `Invalid collection name: use letters, digits, "_", "-" and "." only (no "..", no path).`,
    );
  }
  const root = path.resolve(CACHE_DIR);
  const target = path.resolve(root, `${dataset}__${wanted}__${sha.slice(0, 10)}.json`);
  if (path.dirname(target) !== root) {
    throw new Error("Invalid collection name: the cache path leaves the cache folder.");
  }
  return target;
}

/**
 * Fetch one collection of a dataset at a build, caching it on disk since a
 * tagged dump never changes.
 */
export async function fetchDataset(
  dataset: DatasetName,
  build: Build,
  collection?: string,
): Promise<Entry[]> {
  const { file, collection: defaultCollection } = DATASETS[dataset];
  const wanted = collection ?? defaultCollection;
  const cachePath = cachePathFor(dataset, wanted, build.sha);

  try {
    return JSON.parse(await fs.readFile(cachePath, "utf-8"));
  } catch {
    // Not cached yet.
  }

  const url = `/${REPO}/${build.sha}/${DATA_PATH}/${file}`;
  let response;
  try {
    response = await rawClient.get(url, {
      responseType: "json",
      maxContentLength: 200 * 1024 * 1024,
      maxBodyLength: 200 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      describeFetchFailure(
        axios.isAxiosError(error) ? error.response?.status : undefined,
        `${file} at build ${build.version}`,
      ),
      { cause: error },
    );
  }

  const dump = response.data;
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) {
    throw new Error(`Unexpected shape for ${file} at ${build.version}: expected an object.`);
  }
  if (!Object.hasOwn(dump, wanted)) {
    const available = Object.keys(dump).filter((k) => !META_KEYS.has(k));
    throw new Error(
      `Dataset "${dataset}" has no collection "${wanted}" at ${build.version}. Available: ${remoteText(available.join(", "), "sc-gamedata-dumps")}`,
    );
  }

  const entries = entriesOf((dump as Record<string, unknown>)[wanted]);

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(entries));
  return entries;
}

/**
 * Identity for a record. A class or record name is stable across patches where
 * a display name is not; a collection keyed by id already carries identity in
 * its own key, which is why this may return nothing.
 */
function keyOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, unknown>;
  for (const field of ["className", "ClassName", "recordName", "reference", "id", "name"]) {
    if (typeof e[field] === "string" && e[field]) return e[field] as string;
  }
  return undefined;
}

function indexBy(entries: Entry[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, record] of entries) {
    map.set(keyOf(record) ?? key, record);
  }
  return map;
}

/** Flatten nested objects to dotted paths so field-level changes are visible. */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export function diffEntry(before: unknown, after: unknown): FieldChange[] {
  const fa = flatten(before);
  const fb = flatten(after);
  const fields = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const changes: FieldChange[] = [];

  for (const field of fields) {
    if (JSON.stringify(fa[field]) !== JSON.stringify(fb[field])) {
      changes.push({ field, from: fa[field], to: fb[field] });
    }
  }

  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

/** Human-readable label for a record, for listing changed things by name. */
function labelOf(entry: unknown, key: string): string {
  if (!entry || typeof entry !== "object") return key;
  const e = entry as Record<string, unknown>;
  for (const field of ["name", "displayName", "title"]) {
    const value = e[field];
    if (typeof value === "string" && value && !value.includes("PLACEHOLDER")) {
      return value === key ? key : `${value} (${key})`;
    }
  }
  return key;
}

export interface DiffResult {
  dataset: string;
  from: Build;
  to: Build;
  summary: { added: number; removed: number; changed: number; unchanged: number };
  added?: string[];
  removed?: string[];
  changed?: { item: string; change_count: number; changes?: FieldChange[] }[];
  truncated?: string;
}

/**
 * Diff a dataset between two builds.
 *
 * With `itemQuery` this reports every changed field for the matching records.
 * Without it, it reports counts plus names, since a full field-level diff of a
 * whole dataset is thousands of entries and would be useless in a response.
 */
export function diffDatasets(
  dataset: string,
  from: Build,
  to: Build,
  beforeEntries: Entry[],
  afterEntries: Entry[],
  options: { itemQuery?: string; limit?: number } = {},
): DiffResult {
  const before = indexBy(beforeEntries);
  const after = indexBy(afterEntries);
  const limit = options.limit ?? 50;

  if (options.itemQuery) {
    const needle = options.itemQuery.toLowerCase();
    const matches = (key: string, entry?: unknown) =>
      key.toLowerCase().includes(needle) || labelOf(entry, key).toLowerCase().includes(needle);

    const keys = new Set<string>();
    for (const [k, v] of before) if (matches(k, v)) keys.add(k);
    for (const [k, v] of after) if (matches(k, v)) keys.add(k);

    if (keys.size === 0) {
      throw new Error(`No entry in ${dataset} matching "${options.itemQuery}" in either build.`);
    }

    const added: string[] = [];
    const removed: string[] = [];
    const changed: DiffResult["changed"] = [];

    for (const key of keys) {
      const b = before.get(key);
      const a = after.get(key);
      if (!b && a) added.push(labelOf(a, key));
      else if (b && !a) removed.push(labelOf(b, key));
      else if (b && a) {
        const changes = diffEntry(b, a);
        if (changes.length > 0) {
          changed.push({ item: labelOf(a, key), change_count: changes.length, changes });
        }
      }
    }

    return {
      dataset,
      from,
      to,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        unchanged: keys.size - added.length - removed.length - changed.length,
      },
      added: added.length ? added : undefined,
      removed: removed.length ? removed : undefined,
      changed: changed.length ? changed : undefined,
    };
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: { item: string; change_count: number }[] = [];
  let unchanged = 0;

  for (const [key, entry] of after) {
    if (!before.has(key)) added.push(labelOf(entry, key));
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push(labelOf(entry, key));
  }
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) continue;
    const count = diffEntry(b, a).length;
    if (count > 0) changed.push({ item: labelOf(a, key), change_count: count });
    else unchanged += 1;
  }

  changed.sort((x, y) => y.change_count - x.change_count);

  const notes: string[] = [];
  if (added.length > limit) notes.push(`added list capped at ${limit} of ${added.length}`);
  if (removed.length > limit) notes.push(`removed list capped at ${limit} of ${removed.length}`);
  if (changed.length > limit)
    notes.push(`changed list capped at ${limit} of ${changed.length}, largest first`);

  return {
    dataset,
    from,
    to,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
    added: added.slice(0, limit),
    removed: removed.slice(0, limit),
    changed: changed.slice(0, limit),
    truncated: notes.length
      ? `${notes.join("; ")}. Pass item_name to see field-level changes for one thing.`
      : undefined,
  };
}
