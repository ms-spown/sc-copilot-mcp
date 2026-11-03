import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where an answer came from and how fresh it is.
 *
 * Every tool result is wrapped in a `provenance` block built here. It is serialized by the
 * registry, never through formatOutput: that helper drops nulls and zeros, and a null
 * game_version or a zero age is information, not noise.
 */

export type Kind =
  | "datamined"
  | "crowdsourced"
  | "editorial"
  | "local_log"
  | "local_telemetry"
  | "user"
  | "computed";
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

export interface ProvenanceContext {
  fetches: FetchRecord[];
  channel?: Channel;
  gameVersion?: string | null;
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
  data_age: string;
  kind: Kind;
  trust: Trust;
  stale?: true;
  stale_reason?: string;
  notes?: string[];
}

/**
 * The oldest fetch sets fetched_at and data_age: an answer is as old as its stalest input.
 * With no fetch at all (a local read) the data is read now.
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
    data_age: humanizeAge(now - oldest),
    kind: meta.kind,
    trust: meta.trust,
  };
  if (stale) {
    provenance.stale = true;
    provenance.stale_reason = stale.staleReason ?? "the live request failed";
  }
  if (ctx.notes.length) provenance.notes = [...new Set(ctx.notes)];
  return provenance;
}
