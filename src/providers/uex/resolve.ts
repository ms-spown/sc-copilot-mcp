import { isRow, label, type Row } from "./normalize.js";

/**
 * Resolve a name typed by the user to ONE UEX row: an exact match on any key first, else a single
 * partial match. Several candidates are listed in the error, never guessed between.
 */
export function pickRow(
  rows: readonly unknown[],
  wanted: string,
  what: string,
  keys: (row: Row) => unknown[],
): Row {
  const list = rows.filter(isRow);
  const needle = wanted.trim().toLowerCase();
  const texts = (r: Row) =>
    keys(r)
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.toLowerCase());
  const exact = list.filter((r) => texts(r).includes(needle));
  if (exact.length === 1) return exact[0];
  const partial = exact.length
    ? exact
    : list.filter((r) => texts(r).some((t) => t.includes(needle)));
  if (partial.length === 1) return partial[0];
  const shown = label(wanted, 60) ?? "that name";
  if (partial.length === 0) throw new Error(`No UEX ${what} matches "${shown}".`);
  const names = partial
    .slice(0, 8)
    .map((r) => label(r.name ?? r.fullname ?? r.id, 60))
    .join("; ");
  throw new Error(`"${shown}" matches several ${what}s (${names}). Be more specific.`);
}
