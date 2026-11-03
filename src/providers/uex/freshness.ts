import { setDataAgeUnknown, setDataDates } from "../../core/provenance.js";

/**
 * How old UEX's rows really are, and which game version they belong to.
 *
 * UEX rows carry `date_modified` (and `date_added`): when a player last reported the price.
 * That is the age of the data; the age of our HTTP fetch says nothing about it. Both fields are
 * read when present and never invented: a row without them has no date.
 */

type Row = Record<string, unknown>;

const DATE_FIELDS = ["date_modified", "date_added"] as const;

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

/** When a row was last modified (epoch ms), or null when UEX gave no date for it. */
export function rowTimestamp(row: Row): number | null {
  for (const field of DATE_FIELDS) {
    const t = parseUexDate(row[field]);
    if (t !== null) return t;
  }
  return null;
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
export function reportRowDates(rows: Row[], what: string): void {
  const times = rows.map(rowTimestamp).filter((t): t is number => t !== null);
  if (times.length === 0) {
    setDataAgeUnknown(
      rows.length === 0
        ? `no ${what} returned, so there is nothing to date`
        : `UEX gave no modification date on the ${what} returned; cache_age only says when this server fetched them`,
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

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface VersionSplit {
  kept: Row[];
  /** Rows of a version older than the reference. */
  older: Row[];
  /** Version the rows were compared with, as written by UEX or by the row that set it. */
  reference: string | null;
  referenceSource: "uex_live" | "newest_row" | null;
}

/**
 * Separate the rows of an older game version from the current ones. The reference is UEX's
 * LIVE version when known, else the newest version found in the rows. Rows with no version
 * are kept: they cannot be shown to be old.
 */
export function splitByVersion(rows: Row[], live: unknown): VersionSplit {
  let reference: string | null = null;
  let referenceSource: VersionSplit["referenceSource"] = null;
  if (versionParts(live)) {
    reference = String(live);
    referenceSource = "uex_live";
  } else {
    let best: { parts: number[]; text: string } | null = null;
    for (const r of rows) {
      const parts = versionParts(r.game_version);
      if (parts && (!best || compareVersions(parts, best.parts) > 0)) {
        best = { parts, text: String(r.game_version) };
      }
    }
    if (best) {
      reference = best.text;
      referenceSource = "newest_row";
    }
  }
  const refParts = versionParts(reference);
  if (!refParts) return { kept: rows, older: [], reference, referenceSource };
  const kept: Row[] = [];
  const older: Row[] = [];
  for (const r of rows) {
    const parts = versionParts(r.game_version);
    (parts && compareVersions(parts, refParts) < 0 ? older : kept).push(r);
  }
  return { kept, older, reference, referenceSource };
}
