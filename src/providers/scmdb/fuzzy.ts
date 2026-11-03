/**
 * Name matching that forgives a typo. SCMDB spells things the way the game does ("Quantainium"),
 * and a player or a model types "quantanium": an exact substring search then answers nothing.
 *
 * Two passes, kept apart on purpose: the exact pass is what the tools always did (every word of
 * the query must appear in the text). Only when it finds nothing does the loose pass run, and its
 * hits are reported as close matches, never as if they were exact.
 */

/**
 * Lower case, accents removed, anything that is not a letter or a digit (in any script) becomes
 * a space. Letters such as the Japanese ones or the Norwegian O-stroke are kept, not erased.
 */
export function fold(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a query, folded. */
export const queryWords = (q?: string): string[] => fold(q).split(" ").filter(Boolean);

/** Edit distance where swapping two neighbouring letters counts as one edit (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

/** How many edits a word of this length may be off by. Short words must be exact: too many collisions. */
const allowedEdits = (len: number) => (len < 5 ? 0 : len < 9 ? 1 : 2);

/** Every word of the query appears in the (already folded) text. */
export const exactMatch = (foldedText: string, words: string[]) =>
  words.every((w) => foldedText.includes(w));

/**
 * Every word either appears in the text or is a typo of one of its words. A word can only be off
 * by a few letters, and only when it is long enough for that to mean something.
 */
export function looseMatch(foldedText: string, words: string[]): boolean {
  const parts = foldedText.split(" ");
  return words.every((w) => {
    if (foldedText.includes(w)) return true;
    const max = allowedEdits(w.length);
    if (!max) return false;
    return parts.some((p) => Math.abs(p.length - w.length) <= max && editDistance(w, p) <= max);
  });
}

export interface Searched<T> {
  hits: T[];
  /** True when nothing matched exactly and these are close matches instead. */
  loose: boolean;
}

/**
 * Exact matches first; if there are none and loose matching is allowed, close matches. With no
 * words, everything matches.
 */
export function searchByName<T>(
  items: T[],
  words: string[],
  text: (item: T) => string,
  allowLoose = true,
): Searched<T> {
  if (!words.length) return { hits: items, loose: false };
  const folded = items.map((item) => ({ item, text: fold(text(item)) }));
  const exact = folded.filter((f) => exactMatch(f.text, words)).map((f) => f.item);
  if (exact.length || !allowLoose) return { hits: exact, loose: false };
  return {
    hits: folded.filter((f) => looseMatch(f.text, words)).map((f) => f.item),
    loose: true,
  };
}

const asked = (value: string, label: string) => `${label ? `${label} ` : ""}"${value.trim()}"`;

/** The message that goes with close matches, or with no match at all. */
export function closeMatchNote(rawQuery: string | undefined, names: string[], label = ""): string {
  const what = asked(rawQuery ?? "", label);
  const unique = [...new Set(names)].slice(0, 5);
  return unique.length
    ? `No exact match for ${what}: showing close matches (spelling may differ from the game's). Did you mean: ${unique.join(", ")}?`
    : `No match for ${what}, even allowing for typos. Try fewer or shorter words, or search with no query to browse.`;
}

/** A query made only of punctuation or symbols has no word to search for: say so, match nothing. */
export const unusableNote = (rawQuery: string, label = "") =>
  `No usable word in ${asked(rawQuery, label)} (only punctuation or symbols), so nothing was searched.`;

/** A non-blank text that folds to no word at all. */
export const isUnusable = (raw: string | undefined) =>
  Boolean(raw?.trim()) && !queryWords(raw).length;

export interface NameFilter<T> {
  /** What the filter is called in messages ("" for the main query). */
  label: string;
  value?: string;
  /** The text of the item this filter looks at. */
  text: (item: T) => string;
  /** Names to offer as "did you mean" for an item that matched loosely. */
  suggest?: (item: T) => string[];
}

export interface Filtered<T> {
  hits: T[];
  /** True when some filter fell back to close matches. */
  loose: boolean;
  notes: string[];
}

/**
 * Apply text filters, each judged on its own: a filter that matches nothing exactly falls back to
 * close spellings, and one that matches nothing at all says so in a note (never a silent zero).
 * Several filters together are an AND, as before.
 */
export function filterByNames<T>(items: T[], filters: NameFilter<T>[]): Filtered<T> {
  const notes: string[] = [];
  let loose = false;
  let alive = items.map(() => true);
  const active = filters.filter((f) => f.value?.trim());

  for (const f of active) {
    const value = f.value as string;
    const words = queryWords(value);
    if (!words.length) {
      notes.push(unusableNote(value, f.label));
      alive = alive.map(() => false);
      continue;
    }
    const folded = items.map((item) => fold(f.text(item)));
    let keep = folded.map((t) => exactMatch(t, words));
    if (!keep.some(Boolean)) {
      keep = folded.map((t) => looseMatch(t, words));
      const names: string[] = [];
      keep.forEach((k, i) => {
        if (!k || !f.suggest) return;
        const all = f.suggest(items[i]);
        const near = all.filter((s) => looseMatch(fold(s), words));
        names.push(...(near.length ? near : all));
      });
      if (keep.some(Boolean)) loose = true;
      notes.push(closeMatchNote(value, names, f.label));
    }
    alive = alive.map((a, i) => a && keep[i]);
  }

  const hits = items.filter((_, i) => alive[i]);
  if (!hits.length && active.length > 1 && !notes.length) {
    notes.push(
      "Each filter matches something on its own, but nothing matches all of them together: relax one.",
    );
  }
  return { hits, loose, notes };
}
