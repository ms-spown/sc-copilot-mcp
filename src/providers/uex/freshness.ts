import { setDataAgeUnknown, setDataDates } from "../../core/provenance.js";

/**
 * How old UEX's rows really are, and which game version they belong to.
 *
 * Price rows carry `date_modified`: when a player last reported the price. That is the age of
 * the data; the age of our HTTP fetch says nothing about it. ONLY date_modified is read.
 * `date_added` is not a price date: on a price row it is when the row was created (years ago),
 * on a route it is when UEX recomputed the route (minutes ago) while the prices under it may be
 * weeks old. A row without date_modified has no date.
 */

type Row = Record<string, unknown>;

/** A UEX date as epoch ms: UEX sends Unix seconds; ISO strings and milliseconds are tolerated. */
export function parseUexDate(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** When a row's price was last reported (epoch ms), or null when UEX gave no date_modified. */
export function rowTimestamp(row: Row): number | null {
  return parseUexDate(row.date_modified);
}

/** The row's modification time as an ISO string, for the answer. */
export function rowUpdatedAt(row: Row): string | null {
  const t = rowTimestamp(row);
  return t === null ? null : new Date(t).toISOString();
}

/**
 * Put the real age of the returned rows in the provenance: the stalest and the freshest row.
 * With no dated row the age stays unknown, with the reason, instead of falling back to the
 * fetch time.
 */
export function reportRowDates(rows: Row[], what: string, why?: string): void {
  const times = rows.map(rowTimestamp).filter((t): t is number => t !== null);
  if (times.length === 0) {
    setDataAgeUnknown(
      rows.length === 0
        ? `no ${what} returned, so there is nothing to date`
        : `UEX gave no price date (date_modified) on the ${what} returned${why ? `: ${why}` : ""}; cache_age only says when this server fetched them`,
    );
    return;
  }
  const undated = rows.length - times.length;
  setDataDates(
    Math.min(...times),
    Math.max(...times),
    `UEX date_modified of the ${times.length} ${what} returned` +
      (undated ? ` (${undated} without a date are not counted)` : ""),
  );
}

/** "4.10.2-LIVE.123" -> [4, 10, 2]; null when it does not start like a version. */
export function versionParts(version: unknown): number[] | null {
  if (typeof version !== "string") return null;
  const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(version);
  return m ? m[1].split(".").map(Number) : null;
}

/**
 * Negative when a < b, positive when a > b, 0 when equal OR when they agree on every segment
 * both have: "4.10" against "4.10.2" is not known to differ, so neither is older.
 */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return 0;
}

export interface VersionSplit {
  /** Rows to answer with: everything except the rows of a version older than LIVE. */
  kept: Row[];
  /** Rows of a version older than LIVE. */
  older: Row[];
  /** Rows of a version newer than LIVE (a PTU build): kept, but reported. */
  newer: Row[];
  /** UEX's LIVE version, or null when UEX did not give a usable one: then nothing is excluded. */
  reference: string | null;
  /** Every version found in the rows, with its row count. */
  versions: Record<string, number>;
}

/**
 * Separate the rows of an older game version from the current ones, against UEX's LIVE version.
 * Without a known LIVE version nothing can be called old (the newest row may be a PTU row), so
 * nothing is excluded. Rows with no version, or a version too short to tell, are kept.
 */
export function splitByVersion(rows: Row[], live: unknown): VersionSplit {
  const liveParts = versionParts(live);
  const versions: Record<string, number> = {};
  const kept: Row[] = [];
  const older: Row[] = [];
  const newer: Row[] = [];
  for (const r of rows) {
    if (typeof r.game_version === "string" && r.game_version) {
      versions[r.game_version] = (versions[r.game_version] ?? 0) + 1;
    }
    const parts = versionParts(r.game_version);
    const d = liveParts && parts ? compareVersions(parts, liveParts) : 0;
    if (d < 0) older.push(r);
    else {
      kept.push(r);
      if (d > 0) newer.push(r);
    }
  }
  return { kept, older, newer, reference: liveParts ? String(live) : null, versions };
}
