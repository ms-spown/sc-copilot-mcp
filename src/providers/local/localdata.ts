/**
 * Game data the user already has on disk, as `game-*.json` files.
 *
 * This module only READS files that are already there, from the folder named by
 * SCMCP_GAME_DATA_DIR. It does not extract anything from the game and does not say how to:
 * whether extracting game files is safe for an account is unverified (see SECURITY.md).
 * Every tool degrades to a clear message when the folder is unset or missing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { shortPath } from "../../core/paths.js";

export const GAME_DATA_DIR = process.env.SCMCP_GAME_DATA_DIR;

/** Keys the parser adds for provenance rather than as game content. */
const META_KEYS = new Set(["_source", "_extracted", "_build", "_extraction-validation"]);

export interface DatasetSummary {
  dataset: string;
  collections: { name: string; count: number }[];
}

function assertConfigured(): string {
  if (!GAME_DATA_DIR) {
    throw new Error(
      "Local game data is not configured. Set SCMCP_GAME_DATA_DIR to the directory containing game-*.json files you already have.",
    );
  }
  return GAME_DATA_DIR;
}

/** Reject anything that would escape the configured directory. */
function resolveDataset(dir: string, dataset: string): string {
  const file = dataset.endsWith(".json") ? dataset : `${dataset}.json`;
  // ":" covers Windows drive-relative names (C:x.json) and NTFS alternate data streams (x.json:s).
  if (file.includes("/") || file.includes("\\") || file.includes("..") || file.includes(":")) {
    throw new Error(`Invalid dataset name: ${dataset}`);
  }
  return path.join(dir, file);
}

export async function listDatasets(): Promise<{
  directory: string;
  build_version?: unknown;
  datasets: DatasetSummary[];
}> {
  const dir = assertConfigured();

  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.startsWith("game-") && f.endsWith(".json"));
  } catch {
    throw new Error(
      `SCMCP_GAME_DATA_DIR is set to "${shortPath(dir)}" but that directory cannot be read.`,
    );
  }

  const datasets: DatasetSummary[] = [];
  let buildVersion: unknown;

  for (const file of files.sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, file), "utf-8"));
    } catch {
      continue;
    }

    if (file === "game-build-version.json") {
      buildVersion = parsed;
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    const collections = Object.entries(parsed as Record<string, unknown>)
      .filter(([k, v]) => !META_KEYS.has(k) && (Array.isArray(v) || (v && typeof v === "object")))
      .map(([name, v]) => ({
        name,
        count: Array.isArray(v) ? v.length : Object.keys(v as object).length,
      }))
      .sort((a, b) => b.count - a.count);

    datasets.push({ dataset: file.replace(/\.json$/, ""), collections });
  }

  return { directory: shortPath(dir), build_version: buildVersion, datasets };
}

/** Entries of a collection, normalised to [key, value] pairs for arrays and objects. */
function entriesOf(collection: unknown): [string, unknown][] {
  if (Array.isArray(collection)) return collection.map((v, i) => [String(i), v]);
  if (collection && typeof collection === "object") {
    return Object.entries(collection as Record<string, unknown>);
  }
  return [];
}

function labelFor(key: string, value: unknown): string {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const field of ["name", "displayName", "debugName", "title", "id"]) {
      if (typeof v[field] === "string" && v[field]) return v[field] as string;
    }
  }
  return key;
}

/**
 * Distinct human-readable labels across every local dataset - or one dataset if named.
 *
 * Built for STT vocabulary biasing: local data covers domains no public API exposes
 * (ore signatures, blueprint names, mission brokers, Wikelo trades), and those are
 * exactly the invented, game-specific words a speech recognizer has never seen. Numeric
 * and single-character keys are dropped since they are usually IDs, not spoken words.
 */
export async function collectLabels(
  dataset?: string,
  options: { limit?: number } = {},
): Promise<{ directory: string; datasets_scanned: string[]; labels: string[] }> {
  const dir = assertConfigured();
  const limit = options.limit ?? 1000;

  let files: string[];
  if (dataset) {
    // Same check as the other readers: a name, never a path.
    files = [path.basename(resolveDataset(dir, dataset))];
  } else {
    try {
      files = (await fs.readdir(dir)).filter((f) => f.startsWith("game-") && f.endsWith(".json"));
    } catch {
      throw new Error(
        `SCMCP_GAME_DATA_DIR is set to "${shortPath(dir)}" but that directory cannot be read.`,
      );
    }
  }

  const labels = new Set<string>();
  const scanned: string[] = [];

  for (const file of files.sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    scanned.push(file.replace(/\.json$/, ""));

    for (const [collectionName, collection] of Object.entries(parsed as Record<string, unknown>)) {
      if (META_KEYS.has(collectionName)) continue;
      for (const [key, value] of entriesOf(collection)) {
        const label = labelFor(key, value);
        // A label that fell back to the raw key is usually an index or an internal id
        // (all-digit, or too short to be a spoken word) rather than something named.
        if (/^\d+$/.test(label) || label.length < 3) continue;
        labels.add(label);
        if (labels.size >= limit) {
          return {
            directory: shortPath(dir),
            datasets_scanned: scanned,
            labels: [...labels].sort(),
          };
        }
      }
    }
  }

  return { directory: shortPath(dir), datasets_scanned: scanned, labels: [...labels].sort() };
}

export interface SearchHit {
  collection: string;
  key: string;
  label: string;
  record: unknown;
}

/**
 * Search a dataset for records whose key, label, or serialised body contains the
 * query. Case-insensitive substring matching, which suits ore names, blueprint
 * names and location keys without needing a schema per file.
 */
export async function searchDataset(
  dataset: string,
  query: string,
  options: { collection?: string; limit?: number } = {},
): Promise<{ dataset: string; query: string; total_matches: number; hits: SearchHit[] }> {
  const dir = assertConfigured();
  const file = resolveDataset(dir, dataset);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    throw new Error(
      `Cannot read dataset "${dataset}". Use sc_local_datasets to see what is available.`,
    );
  }

  const needle = query.toLowerCase();
  const limit = options.limit ?? 20;
  const hits: SearchHit[] = [];
  let total = 0;

  for (const [collectionName, collection] of Object.entries(parsed)) {
    if (META_KEYS.has(collectionName)) continue;
    if (options.collection && collectionName !== options.collection) continue;

    for (const [key, value] of entriesOf(collection)) {
      const label = labelFor(key, value);
      const haystack =
        `${key} ${label} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`.toLowerCase();
      if (!haystack.includes(needle)) continue;

      total += 1;
      if (hits.length < limit) {
        hits.push({ collection: collectionName, key, label, record: value });
      }
    }
  }

  return { dataset, query, total_matches: total, hits };
}

/** Read one collection from a dataset, with paging, for bulk inspection. */
export async function readCollection(
  dataset: string,
  collection: string,
  options: { offset?: number; limit?: number } = {},
): Promise<{
  dataset: string;
  collection: string;
  total: number;
  offset: number;
  entries: { key: string; label: string; record: unknown }[];
}> {
  const dir = assertConfigured();
  const file = resolveDataset(dir, dataset);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    throw new Error(`Cannot read dataset "${dataset}".`);
  }

  if (!(collection in parsed)) {
    const available = Object.keys(parsed).filter((k) => !META_KEYS.has(k));
    throw new Error(
      `Dataset "${dataset}" has no collection "${collection}". Available: ${available.join(", ")}`,
    );
  }

  const all = entriesOf(parsed[collection]);
  const offset = Math.max(options.offset ?? 0, 0);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);

  return {
    dataset,
    collection,
    total: all.length,
    offset,
    entries: all.slice(offset, offset + limit).map(([key, record]) => ({
      key,
      label: labelFor(key, record),
      record,
    })),
  };
}
