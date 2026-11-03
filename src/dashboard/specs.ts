import axios from "axios";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { cleanLabel } from "../core/untrusted.js";
import { positive } from "../providers/fleet/compare.js";
import { resolveShip, type VehicleRow } from "../providers/fleet/resolve.js";
import { MANUFACTURERS, splitInstance } from "../providers/telemetry/normalize.js";

/**
 * The "sheet" of the ship the player is flying, taken from the Star Citizen Wiki: the limits the dashboard gauges are
 * drawn against (SCM speed, maximum speed) and what else the sheet gives (cargo, shields, hull).
 *
 * Read this before changing anything:
 *  - The lookup NEVER runs in the poll's hot path. `current()` answers from memory at once; the first sight of a ship
 *    starts one search in the background (`pending` until it ends). The poll never waits for the wiki.
 *  - One search per ship class and per session. An outage is retried at most every five minutes.
 *  - The class name of the stream ("AEGS_Vanguard_Harbinger") becomes words ("Vanguard Harbinger") and goes through the
 *    word matching the fleet tools already use. Only ONE candidate is accepted: with several, nothing is chosen
 *    (`ambiguous`, with the names); with none, `unknown`. A wrong sheet would draw a wrong scale, which is worse than
 *    no sheet.
 *  - A figure of 0 is the wiki having no figure (same rule as sc_fleet_get): it is left out, never shown as a limit.
 *  - Nothing here is known about the hydrogen tank. The wiki data read by this project has no such field, so none is
 *    reported, and the hydrogen endurance stays the straight-line estimate of the View.
 *  - Wiki text is third-party text: names are cleaned and capped where they enter, figures are bounded numbers.
 */

export type SpecsStatus = "pending" | "ready" | "unknown" | "ambiguous" | "error";

/** What `sc_live_poll` carries under `specs`. Bounded by construction: at most 8 names of 60 characters. */
export interface ShipSpecs {
  status: SpecsStatus;
  /** The wiki's name for the ship (ready only). */
  name?: string;
  /** Speed in standard cruise mode, m/s (the wiki gives m/s). Absent when the sheet gives none (0 = not provided). */
  speed_scm_ms?: number;
  /** Maximum speed, m/s. Absent when the sheet gives none. */
  speed_max_ms?: number;
  cargo_scu?: number;
  shield_hp?: number;
  hull_hp?: number;
  source: "star-citizen.wiki";
  /** When this server read the sheet from the wiki (ISO 8601, ready only). The View works the age out from it. */
  fetched_at?: string;
  /** True when the wiki could not be reached and the last good copy was used. */
  stale?: true;
  /** The game version the wiki stamps on the record, when it gives one. */
  version?: string;
  /** When the wiki last changed the record (ISO 8601), when it says. */
  updated_at?: string;
  /** Names of the sheets that fit (ambiguous only). Nothing was chosen. */
  candidates?: string[];
}

export const SPECS_SOURCE = "star-citizen.wiki" as const;
export const SPECS_RETRY_MS = 5 * 60 * 1000;
export const SPECS_MAX_ENTRIES = 32;
export const SPECS_MAX_CANDIDATES = 8;
const NAME_MAX = 60;
const VERSION_MAX = 30;
const PAGE_SIZE = 50;
/** No ship goes faster than this: a larger figure is a hole or an error in the source. */
const MAX_SPEED_MS = 10_000_000;
const MAX_CARGO_SCU = 1_000_000;
const MAX_HP = 1_000_000_000;

// ---------------------------------------------------------------------------------------------
// The class name of the stream, as words
// ---------------------------------------------------------------------------------------------

export type NameWords =
  | {
      ok: true;
      /** The class name without its numeric instance suffix: the cache key. */
      className: string;
      /** The maker's code in the class name: AEGS. */
      prefix: string;
      /** The maker, derived from the code (the stream never fills its own field): Aegis. */
      maker: string;
      /** The ship's words, space separated: "Vanguard Harbinger". */
      model: string;
      /** The word the wiki is asked for (`filter[name]` is a substring match): the longest of the model. */
      searchTerm: string;
    }
  | { ok: false; reason: "no_name" | "bad_name" | "unknown_maker" | "no_model" };

const GAME_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ROMAN: Record<string, string> = { "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V" };

/**
 * 'AEGS_Vanguard_Harbinger' -> maker "Aegis", model "Vanguard Harbinger". A name with an instance suffix
 * ('DRAK_Cutter_907038284543') gives the same words as without. Anything that is not a game identifier, and any code
 * of a maker the project does not know, is refused here: nothing is then asked of the wiki.
 *
 * "Mk2" is written "Mk II" (the wiki's spelling); that is a guess the match then confirms or refutes.
 */
export function shipNameToWords(className: unknown): NameWords {
  if (typeof className !== "string" || className === "") return { ok: false, reason: "no_name" };
  if (!GAME_ID.test(className)) return { ok: false, reason: "bad_name" };
  const [bare] = splitInstance(className);
  const parts = bare.split("_");
  const prefix = parts[0] ?? "";
  const maker = Object.hasOwn(MANUFACTURERS, prefix) ? MANUFACTURERS[prefix] : undefined;
  if (!maker) return { ok: false, reason: "unknown_maker" };
  const tokens = parts
    .slice(1)
    .flatMap((p) => p.split(/[.-]+/))
    .filter((t) => t !== "");
  if (tokens.length === 0) return { ok: false, reason: "no_model" };
  const words = tokens.flatMap((t) => {
    const mk = /^mk([1-5])$/i.exec(t);
    return mk ? ["Mk", ROMAN[mk[1] as string] as string] : [t];
  });
  const searchable = tokens.filter((t) => !/^mk\d$/i.test(t));
  const pool = searchable.length > 0 ? searchable : tokens;
  const searchTerm = pool.reduce((best, t) => (t.length > best.length ? t : best), "");
  return { ok: true, className: bare, prefix, maker, model: words.join(" "), searchTerm };
}

// ---------------------------------------------------------------------------------------------
// From the wiki's rows to one sheet
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

const lowerWords = (s: unknown): string[] =>
  typeof s === "string"
    ? s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter(Boolean)
    : [];

/** Words of a maker's wiki name that the derived maker does not contain (the table gives short names). */
const MAKER_ALIASES: Record<string, string[]> = { RSI: ["roberts"], MISC: ["musashi"] };

/**
 * Is this wiki row by the maker the class name says? A row without maker information cannot be refuted and passes;
 * a row of another maker is left out, so a name shared by two makers cannot pick the wrong ship.
 */
export function makerFits(row: Row, prefix: string, maker: string): boolean {
  const m = row["manufacturer"];
  if (!isRow(m)) return true;
  const code = typeof m["code"] === "string" ? m["code"].toUpperCase() : "";
  const nameWords = lowerWords(m["name"]);
  if (code === "" && nameWords.length === 0) return true;
  if (code === prefix.toUpperCase()) return true;
  const wanted = [...lowerWords(maker).slice(0, 1), ...(MAKER_ALIASES[prefix] ?? [])];
  return wanted.some((w) => nameWords.includes(w));
}

const figure = (v: unknown, max: number): number | undefined => {
  const n = positive(v);
  return n !== undefined && n <= max ? n : undefined;
};

export type Outcome =
  | { status: "ready"; specs: ShipSpecs; fetchedAt: number }
  | { status: "unknown" }
  | { status: "ambiguous"; candidates: string[] };

/**
 * Pure: the wiki's list answer for `filter[name]=<searchTerm>` and the class name's words -> one outcome.
 *
 * Two ways to one sheet, both refusing to guess:
 *  1. The wiki stamps each record with its game `class_name` (AEGS_Vanguard_Harbinger). When exactly ONE row carries the
 *     very class name of the stream, that is the ship: an identifier, not a resemblance.
 *  2. Otherwise the words of the class name go through the word matching of the fleet tools. One candidate: that sheet.
 *     Several: `ambiguous`, with their names, nothing chosen. None: `unknown`.
 * `truncated` is true when the page was full or there were more pages: the list is then incomplete, and a candidate
 * found by words proves nothing about uniqueness, so nothing is accepted that way.
 */
export function pickSheet(
  rows: readonly unknown[],
  words: Extract<NameWords, { ok: true }>,
  truncated: boolean,
  fetchedAt: number,
): Outcome {
  const named = rows.filter((r): r is Row => isRow(r) && typeof r["name"] === "string");
  const wanted = words.className.toLowerCase();
  const sameClass = named.filter(
    (r) => typeof r["class_name"] === "string" && r["class_name"].toLowerCase() === wanted,
  );
  let row: Row;
  if (sameClass.length === 1) {
    row = sameClass[0] as Row;
  } else {
    if (truncated) return { status: "unknown" };
    const fitting = named.filter((r) => makerFits(r, words.prefix, words.maker));
    const found = resolveShip(words.model, fitting as VehicleRow[]);
    if (found.match === "not_found") return { status: "unknown" };
    if (found.match === "ambiguous") {
      const names = found.candidates
        .map((c) => cleanLabel(c.name, NAME_MAX))
        .filter((n): n is string => n !== null)
        .slice(0, SPECS_MAX_CANDIDATES);
      return names.length > 1 ? { status: "ambiguous", candidates: names } : { status: "unknown" };
    }
    row = found.vehicle as Row;
  }
  const name = cleanLabel(row["name"], NAME_MAX);
  if (name === null) return { status: "unknown" };
  const speed = isRow(row["speed"]) ? row["speed"] : {};
  const scm = figure(speed["scm"], MAX_SPEED_MS);
  const max = figure(speed["max"], MAX_SPEED_MS);
  const cargo = figure(row["cargo_capacity"], MAX_CARGO_SCU);
  const shield = figure(row["shield_hp"], MAX_HP);
  const hull = figure(row["health"], MAX_HP);
  const version = cleanLabel(row["version"] ?? row["game_version"], VERSION_MAX);
  const stamp = typeof row["updated_at"] === "string" ? Date.parse(row["updated_at"]) : NaN;
  const specs: ShipSpecs = {
    status: "ready",
    name,
    ...(scm !== undefined ? { speed_scm_ms: scm } : {}),
    ...(max !== undefined ? { speed_max_ms: max } : {}),
    ...(cargo !== undefined ? { cargo_scu: cargo } : {}),
    ...(shield !== undefined ? { shield_hp: shield } : {}),
    ...(hull !== undefined ? { hull_hp: hull } : {}),
    source: SPECS_SOURCE,
    ...(version !== null ? { version } : {}),
    ...(Number.isFinite(stamp) ? { updated_at: new Date(stamp).toISOString() } : {}),
  };
  return { status: "ready", specs, fetchedAt };
}

// ---------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------

interface Entry {
  status: SpecsStatus;
  outcome?: Outcome;
  stale?: boolean;
  failedAt?: number;
  job?: Promise<void>;
}

export class ShipSpecsResolver {
  private readonly entries = new Map<string, Entry>();
  private readonly jobs = new Set<Promise<void>>();

  constructor(
    private readonly client: HttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * What is known about this ship right now. Synchronous: it never waits for the wiki. `undefined` when there is no
   * ship. A first sight starts the search in the background and answers `pending`.
   */
  current(className: unknown, nowMs: number = this.now()): ShipSpecs | undefined {
    const words = shipNameToWords(className);
    if (!words.ok) {
      return words.reason === "no_name" ? undefined : { status: "unknown", source: SPECS_SOURCE };
    }
    let entry = this.entries.get(words.className);
    if (!entry) {
      this.makeRoom();
      entry = { status: "pending" };
      this.entries.set(words.className, entry);
      this.start(entry, words);
    } else if (
      entry.status === "error" &&
      !entry.job &&
      entry.failedAt !== undefined &&
      nowMs - entry.failedAt >= SPECS_RETRY_MS
    ) {
      entry.status = "pending";
      this.start(entry, words);
    }
    return this.view(entry);
  }

  /** How many ships are remembered (bounded by SPECS_MAX_ENTRIES). */
  get size(): number {
    return this.entries.size;
  }

  /** Resolves when every search in flight has ended. For tests and for a clean stop. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs]);
  }

  private makeRoom(): void {
    if (this.entries.size < SPECS_MAX_ENTRIES) return;
    for (const [key, e] of this.entries) {
      if (!e.job) {
        this.entries.delete(key);
        return;
      }
    }
  }

  private start(entry: Entry, words: Extract<NameWords, { ok: true }>): void {
    const job: Promise<void> = this.search(entry, words).finally(() => {
      entry.job = undefined;
      this.jobs.delete(job);
    });
    entry.job = job;
    this.jobs.add(job);
  }

  /** Never throws: every failure becomes an `error` state with a time to retry from. */
  private async search(entry: Entry, words: Extract<NameWords, { ok: true }>): Promise<void> {
    try {
      // record:false: a background search must not write into the provenance of the poll that happened to start it.
      const res = await fetchWithCache(
        this.client,
        "/vehicles",
        {
          params: {
            "filter[name]": words.searchTerm,
            "page[number]": 1,
            "page[size]": PAGE_SIZE,
          },
        },
        { record: false },
      );
      const data: unknown = res.data;
      const list = isRow(data) && Array.isArray(data["data"]) ? (data["data"] as unknown[]) : [];
      const meta = isRow(data) && isRow(data["meta"]) ? data["meta"] : {};
      const lastPage = typeof meta["last_page"] === "number" ? meta["last_page"] : 1;
      const truncated = list.length >= PAGE_SIZE || lastPage > 1;
      entry.outcome = pickSheet(list, words, truncated, res.fetchedAt);
      entry.stale = res.cache === "stale-disk";
      entry.status = entry.outcome.status;
    } catch (error) {
      // A 404 of the list endpoint is the wiki saying it has nothing for this name.
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        entry.outcome = { status: "unknown" };
        entry.status = "unknown";
        return;
      }
      entry.status = "error";
      entry.failedAt = this.now();
    }
  }

  private view(entry: Entry): ShipSpecs {
    const out = entry.outcome;
    if (entry.status === "ready" && out?.status === "ready") {
      return {
        ...out.specs,
        fetched_at: new Date(out.fetchedAt).toISOString(),
        ...(entry.stale ? { stale: true as const } : {}),
      };
    }
    if (entry.status === "ambiguous" && out?.status === "ambiguous") {
      return { status: "ambiguous", source: SPECS_SOURCE, candidates: out.candidates };
    }
    return { status: entry.status, source: SPECS_SOURCE };
  }
}
