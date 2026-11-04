import fs from "node:fs/promises";
import path from "node:path";

/**
 * Housekeeping for the cache folders that only ever grew (SCMDB files per commit, dump collections per build).
 * It removes files this server wrote, oldest first, and nothing else: `accept` / `groupOf` say what looks like ours.
 * A failure here is ignored; pruning must never break the request that triggered it.
 */

interface Entry {
  name: string;
  bytes: number;
  mtime: number;
}

async function list(dir: string, accept: (name: string) => boolean): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const name of await fs.readdir(dir)) {
    if (!accept(name)) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      if (stat.isFile()) out.push({ name, bytes: stat.size, mtime: stat.mtimeMs });
    } catch {
      // Gone in the meantime.
    }
  }
  return out;
}

async function remove(dir: string, names: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const name of names) {
    try {
      await fs.rm(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // Locked or read-only: the next pruning tries again.
    }
  }
  return removed;
}

export interface PruneOldestOptions {
  maxFiles: number;
  maxBytes: number;
  /** Only files for which this is true are counted and may be removed (default: all). */
  accept?: (name: string) => boolean;
  /** Names never removed, whatever their age (the file just written). */
  keep?: readonly string[];
}

/** Remove the oldest accepted files until there are at most `maxFiles` of them and `maxBytes` in all. */
export async function pruneOldest(dir: string, options: PruneOldestOptions): Promise<string[]> {
  try {
    const entries = (await list(dir, options.accept ?? (() => true))).sort(
      (a, b) => a.mtime - b.mtime,
    );
    let count = entries.length;
    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    const doomed: string[] = [];
    for (const entry of entries) {
      if (count <= options.maxFiles && bytes <= options.maxBytes) break;
      if (options.keep?.includes(entry.name)) continue;
      doomed.push(entry.name);
      count -= 1;
      bytes -= entry.bytes;
    }
    return await remove(dir, doomed);
  } catch {
    return [];
  }
}

/**
 * Files are grouped (by the commit they belong to); keep the files of the `keepGroups` groups whose newest file is the
 * most recent, remove the others. A file with no group is not ours and is left alone. The group named `always` is
 * counted first and never removed (the one just written: file times can tie on a coarse clock).
 */
export async function pruneGroups(
  dir: string,
  groupOf: (name: string) => string | null,
  keepGroups: number,
  always?: string,
): Promise<string[]> {
  try {
    const groups = new Map<string, { newest: number; names: string[] }>();
    for (const entry of await list(dir, (n) => groupOf(n) !== null)) {
      const group = groupOf(entry.name) as string;
      const found = groups.get(group) ?? { newest: 0, names: [] };
      found.newest = Math.max(found.newest, entry.mtime);
      found.names.push(entry.name);
      groups.set(group, found);
    }
    const rank = (name: string, g: { newest: number }) => (name === always ? Infinity : g.newest);
    const oldest = [...groups.entries()]
      .sort(([an, a], [bn, b]) => rank(bn, b) - rank(an, a))
      .slice(keepGroups)
      .map(([, g]) => g);
    return await remove(
      dir,
      oldest.flatMap((g) => g.names),
    );
  } catch {
    return [];
  }
}
