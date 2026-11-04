import fs from "node:fs/promises";
import path from "node:path";
import { shortPath } from "../../core/paths.js";

/**
 * Wipe the saved sessions: the file and every copy of it, in the sessions folder only.
 *
 * `sessions.json` keeps balances and results, and so do its copies: `.v<N>.bak` (kept once when the format changes),
 * `.bak-<time>` and `.corrupt-<time>` (a few of each are kept), plus the `.lock` and `.<pid>.<id>.tmp` files a crash can
 * leave. Deleting the main file alone leaves the figures in the others. The names are those the store writes
 * (providers/sessions/store.ts); a file that does not match one of them is never touched, and neither is a sub-folder,
 * a symbolic link, or the cache folder.
 *
 * Pure planning (`planWipe`), then `applyWipe` deletes exactly the planned names. The CLI is scripts/sessions.mjs.
 */

/** A lock younger than this means a server is writing right now: wiping under its feet is refused. */
const LOCK_IN_USE_MS = 30_000;

export type WipeKind = "sessions" | "format-backup" | "backup" | "corrupt" | "lock" | "tmp";

export interface WipeFile {
  name: string;
  bytes: number;
  kind: WipeKind;
}

export interface WipePlan {
  dir: string;
  /** The session file asked about (as resolved by sessionsFilePath). */
  file: string;
  files: WipeFile[];
  /** Why nothing will be deleted. */
  refused?: string;
}

/** The time the store puts in a copy's name: an ISO time with ":" and "." turned into "-" (2026-11-04T08-00-00-000Z). */
const STAMP = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";

/** Which kind of leftover `name` is for the session file called `base`, or null when it is none of them. */
function kindOf(name: string, base: string): WipeKind | null {
  if (name === base) return "sessions";
  if (!name.startsWith(`${base}.`)) return null;
  const rest = name.slice(base.length);
  if (/^\.v\d{1,3}\.bak$/.test(rest)) return "format-backup";
  if (new RegExp(`^\\.bak-${STAMP}$`).test(rest)) return "backup";
  if (new RegExp(`^\\.corrupt-${STAMP}$`).test(rest)) return "corrupt";
  if (rest === ".lock") return "lock";
  if (/^\.\d{1,10}(\.[0-9a-f]{8})?\.tmp$/.test(rest)) return "tmp";
  return null;
}

/** A document of the right shape: an object with an integer `version` and a `sessions` list. */
function looksLikeSessions(text: string): boolean {
  try {
    const doc: unknown = JSON.parse(text);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
    const d = doc as Record<string, unknown>;
    return Number.isInteger(d.version) && Array.isArray(d.sessions);
  } catch {
    return false;
  }
}

const DEFAULT_NAME = "sessions.json";
/** More than a session file can be (the store refuses larger): not read to be recognised. */
const MAX_LOOK_BYTES = 64 * 1024 * 1024;

export async function planWipe(file: string, deps: { now?: () => number } = {}): Promise<WipePlan> {
  const now = deps.now ?? Date.now;
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const refuse = (refused: string): WipePlan => ({ dir, file: resolved, files: [], refused });

  if (!/\.json$/i.test(base)) {
    return refuse(
      `${base} does not end in .json, so it is not taken for the sessions file. Nothing was touched.`,
    );
  }

  let mainStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    mainStat = await fs.lstat(resolved);
  } catch {
    // The main file may be gone while copies remain: they are still ours.
  }
  if (mainStat && !mainStat.isFile()) {
    return refuse(`${base} is not a file (a folder or a link), so it was not touched.`);
  }
  // The default name is ours by definition, even if its content is damaged (that is a case for wiping). A custom
  // name (SCMCP_SESSIONS_FILE) must hold what the store writes, or the variable points at someone else's file.
  if (!mainStat && base !== DEFAULT_NAME) {
    return refuse(
      `${base} is not there, and nothing else shows that this name belongs to the sessions file, so no copy next to it was touched. Check SCMCP_SESSIONS_FILE.`,
    );
  }
  if (mainStat && base !== DEFAULT_NAME) {
    let ok = false;
    if (mainStat.size <= MAX_LOOK_BYTES) {
      ok = looksLikeSessions(await fs.readFile(resolved, "utf8"));
    }
    if (!ok) {
      return refuse(
        `${base} does not look like a sessions file (no version and sessions list), so it was not touched. Check SCMCP_SESSIONS_FILE.`,
      );
    }
  }

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { dir, file: resolved, files: [] };
  }
  const files: WipeFile[] = [];
  for (const name of names) {
    const kind = kindOf(name, base);
    if (!kind) continue;
    let stat;
    try {
      stat = await fs.lstat(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // a link, a folder: never followed, never removed
    if (kind === "lock" && now() - stat.mtimeMs < LOCK_IN_USE_MS) {
      return refuse(
        `${name} is fresh: a server is writing the sessions right now. Close Claude Desktop (or wait a few seconds) and run it again.`,
      );
    }
    files.push({ name, bytes: stat.size, kind });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, file: resolved, files };
}

export async function applyWipe(plan: WipePlan): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  if (plan.refused) return { removed, failed };
  for (const { name } of plan.files) {
    try {
      await fs.rm(path.join(plan.dir, name), { force: true });
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed };
}

/** What the CLI prints: file names and sizes, never a content. */
export function describeWipe(
  plan: WipePlan,
  applied: boolean | { removed: string[]; failed: string[] },
): string {
  const lines = [`Sessions folder: ${shortPath(plan.dir)}`];
  if (plan.refused) return [...lines, `Refused: ${plan.refused}`].join("\n");
  if (plan.files.length === 0) {
    return [...lines, "Nothing to delete: no sessions file and no copy of it were found."].join(
      "\n",
    );
  }
  const done = typeof applied === "object" ? applied : null;
  lines.push(
    done ? "Deleted:" : "Would delete (the file and its copies; the cache folder is not touched):",
  );
  for (const f of plan.files) {
    const mark = done ? (done.failed.includes(f.name) ? " [FAILED]" : "") : "";
    lines.push(`  ${f.name}  (${f.bytes} bytes)${mark}`);
  }
  if (!done) {
    lines.push("", "Dry run: nothing was deleted. Re-run with --apply to delete these files.");
  } else if (done.failed.length) {
    lines.push(
      "",
      `${done.failed.length} file(s) could not be deleted: close the program that uses them and retry.`,
    );
  } else {
    lines.push("", "Done. The saved sessions are gone; a new session starts empty.");
  }
  return lines.join("\n");
}
