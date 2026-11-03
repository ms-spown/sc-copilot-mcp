import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where an answer came from and how fresh it is.
 *
 * Every tool result is wrapped in a `provenance` block built here. It is serialized by the
 * registry, never through formatOutput: that helper drops nulls and zeros, and a null
 * game_version or a zero age is information, not noise.
 */

export type Kind = "datamined" | "crowdsourced" | "editorial" | "local_log" | "user" | "computed";
export type Trust = "untrusted_text" | "structured";
export type Channel = "live" | "ptu" | "unknown";
export type CacheState = "network" | "memory" | "stale-disk";

/** Static facts about a tool's data, declared once in tools/catalog.ts. */
export interface ToolMeta {
  source: string;
  kind: Kind;
  trust: Trust;
  /** What the source serves. "unknown" when it cannot say: never guessed. */
  channel: Channel;
  /** Longest string kept in the answer, for untrusted tools. */
  maxText?: number;
}

export interface FetchRecord {
  fetchedAt: number;
  cache: CacheState;
  staleReason?: string;
}

/** The real dates of the data a tool returned, when the source gives them. */
export interface DataDates {
  /** Epoch ms of the stalest datum returned. */
  oldest: number;
  /** Epoch ms of the freshest datum returned. */
  newest: number;
  /** Where the dates come from, in words. */
  basis: string[];
}

export interface ProvenanceContext {
  fetches: FetchRecord[];
  channel?: Channel;
  gameVersion?: string | null;
  dataDates?: DataDates;
  /** Why the age of the data is not known, when a tool knows. */
  dataAgeUnknown?: string;
  notes: string[];
}

const store = new AsyncLocalStorage<ProvenanceContext>();

export function runWithProvenance<T>(fn: (ctx: ProvenanceContext) => Promise<T>): Promise<T> {
  const ctx: ProvenanceContext = { fetches: [], notes: [] };
  return store.run(ctx, () => fn(ctx));
}

export function recordFetch(record: FetchRecord): void {
  store.getStore()?.fetches.push(record);
}

export function setChannel(channel: Channel): void {
  const ctx = store.getStore();
  if (ctx) ctx.channel = channel;
}

export function setGameVersion(version: string | null): void {
  const ctx = store.getStore();
  if (ctx) ctx.gameVersion = version;
}

/**
 * Say how old the DATA is (not the retrieval): the stalest and freshest dates the source gave for
 * what is returned. Several calls in one answer merge to the widest range.
 */
export function setDataDates(oldest: number, newest: number, basis: string): void {
  const ctx = store.getStore();
  if (!ctx || !Number.isFinite(oldest) || !Number.isFinite(newest)) return;
  const prev = ctx.dataDates;
  ctx.dataDates = {
    oldest: prev ? Math.min(prev.oldest, oldest) : oldest,
    newest: prev ? Math.max(prev.newest, newest) : newest,
    basis: prev && !prev.basis.includes(basis) ? [...prev.basis, basis] : (prev?.basis ?? [basis]),
  };
}

/** Say why the age of the data cannot be given (the source dates nothing the tool returned). */
export function setDataAgeUnknown(reason: string): void {
  const ctx = store.getStore();
  if (ctx) ctx.dataAgeUnknown = reason;
}

export function addNote(note: string): void {
  store.getStore()?.notes.push(note);
}

/** "42s", "5m", "3h", "2d": one unit, rounded down, because precision here is false comfort. */
export function humanizeAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export interface Provenance {
  source: string;
  channel: Channel;
  game_version: string | null;
  fetched_at: string;
  /** How long ago this server got the data (network, memory or disk cache). NOT how old the data is. */
  cache_age: string;
  /** How old the DATA itself is, from dates the source gives; null when it gives none. */
  data_age: string | null;
  /** The date of the stalest datum returned (ISO), when known. */
  data_date?: string;
  /** What data_age is based on, or why it is null. */
  data_age_note: string;
  kind: Kind;
  trust: Trust;
  stale?: true;
  stale_reason?: string;
  notes?: string[];
}

export const DATA_AGE_UNKNOWN_DEFAULT =
  "this tool reads no date from the source for what it returns; cache_age only says when this server fetched it";

/**
 * The oldest fetch sets fetched_at and cache_age: an answer was retrieved as long ago as its
 * stalest input. With no fetch at all (a local read) it is read now.
 *
 * data_age is a different thing: the age of the data itself, taken from dates the source gives
 * (UEX row modification dates, the SCMDB channel's generation date). It is null, with the reason
 * in data_age_note, when the source gives none: a retrieval time is never passed off as it.
 */
export function buildProvenance(
  meta: ToolMeta,
  ctx: ProvenanceContext,
  gameVersion: string | null,
  now: number = Date.now(),
): Provenance {
  const oldest = ctx.fetches.length ? Math.min(...ctx.fetches.map((f) => f.fetchedAt)) : now;
  const stale = ctx.fetches.find((f) => f.cache === "stale-disk");
  const provenance: Provenance = {
    source: meta.source,
    channel: ctx.channel ?? meta.channel,
    game_version: ctx.gameVersion !== undefined ? ctx.gameVersion : gameVersion,
    fetched_at: new Date(oldest).toISOString(),
    cache_age: humanizeAge(now - oldest),
    data_age: null,
    data_age_note: ctx.dataAgeUnknown ?? DATA_AGE_UNKNOWN_DEFAULT,
    kind: meta.kind,
    trust: meta.trust,
  };
  if (ctx.dataDates) {
    const { oldest: from, newest: to, basis } = ctx.dataDates;
    provenance.data_age = humanizeAge(now - from);
    provenance.data_date = new Date(from).toISOString();
    provenance.data_age_note =
      `${basis.join("; ")}; this is the oldest date` +
      (to > from ? ` (the freshest is ${humanizeAge(now - to)} old)` : "");
  }
  if (stale) {
    provenance.stale = true;
    provenance.stale_reason = stale.staleReason ?? "the live request failed";
  }
  if (ctx.notes.length) provenance.notes = [...new Set(ctx.notes)];
  return provenance;
}
