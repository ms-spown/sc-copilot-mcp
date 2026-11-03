import fs from "node:fs/promises";
import path from "node:path";
import { userDataDir } from "../../core/paths.js";

export const SNAPSHOT_DIR = process.env.SCMCP_SNAPSHOT_DIR || path.join(userDataDir(), "snapshots");

export function snapshotPath(dataset: string, label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(SNAPSHOT_DIR, `${dataset}__${safeLabel}.json`);
}

/** Reduce a full record to the identifying + stat fields worth diffing across patches. */
export function snapshotFields(entry: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "name",
    "uuid",
    "class_name",
    "type",
    "grade",
    "size",
    "mass",
    "health",
    "shield_hp",
    "cargo_capacity",
    "speed",
    "crew",
    "weaponry",
    "msrp",
    "version",
    "game_version",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (key in entry) out[key] = entry[key];
  }
  return out;
}

export async function loadSnapshot(dataset: string, label: string) {
  const raw = await fs.readFile(snapshotPath(dataset, label), "utf-8");
  return JSON.parse(raw) as {
    dataset: string;
    label: string;
    game_version?: string;
    captured_at: string;
    entries: Record<string, Record<string, unknown>>;
  };
}

/** Shallow-compare two snapshot entry maps keyed by name. */
export function diffEntries(
  before: Record<string, Record<string, unknown>>,
  after: Record<string, Record<string, unknown>>,
) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed: Record<string, Record<string, { from: unknown; to: unknown }>> = {};

  for (const key of Object.keys(after)) {
    if (!(key in before)) continue;
    const fieldDiffs: Record<string, { from: unknown; to: unknown }> = {};
    const fields = new Set([...Object.keys(before[key]), ...Object.keys(after[key])]);

    for (const field of fields) {
      // game_version stamps every record and would flag everything as changed.
      if (field === "version" || field === "game_version") continue;
      const prev = JSON.stringify(before[key][field]);
      const next = JSON.stringify(after[key][field]);
      if (prev !== next) {
        fieldDiffs[field] = { from: before[key][field], to: after[key][field] };
      }
    }

    if (Object.keys(fieldDiffs).length > 0) changed[key] = fieldDiffs;
  }

  return { added, removed, changed };
}
