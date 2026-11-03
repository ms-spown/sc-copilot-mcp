import fs from "node:fs/promises";
import { decodeLog, parseLog, type LogEvent } from "../providers/gamelog/parser.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import { buildContracts, EMPTY_LEDGER, type LedgerBase } from "./ledger.js";

/**
 * The reading side of the transport ledger: keeps the contracts of the current game session in memory and refreshes
 * them thriftily from Game.log.
 *
 * - `state()` is synchronous and returns the LAST computed result. It never waits for a file. The poll calls it.
 * - At most every LEDGER_REFRESH_MS it starts a refresh in the background: the file's modification date is looked
 *   at (one `stat`), and nothing is read unless that date changed since the last read.
 * - The first read, and any doubt, is a full read (the end of the log, as every other log tool does it). After that
 *   only the bytes added since the last read are parsed, with a short look-behind so that two lines the game wrote
 *   a moment apart are never separated by a cut. A shorter file, or a different beginning (a new game session
 *   replaced the log), starts again with a full read. A log in UTF-16 is always read in full.
 * - A refresh that hangs does not pile up: while one is in flight no other starts.
 * - Reads are asynchronous and lock-free (the file is opened read-only). Nothing is written, nothing leaves the
 *   process. Parsing is synchronous work, proportional to what was read.
 */

/** Minimum time between two looks at the log file. */
export const LEDGER_REFRESH_MS = 5000;
/** Bytes re-read before the last position, so a line pair cut by a read boundary is seen whole. */
export const LEDGER_LOOKBEHIND_BYTES = 16 * 1024;
/** Bytes of the beginning of the file that identify a game session. */
export const LEDGER_HEAD_BYTES = 256;
/**
 * An incremental read never takes more than this many bytes (like the reader's own tail): when the log grew by more
 * than that since the last read, a full read (the end of the log) is done instead.
 */
export const LEDGER_MAX_INCREMENTAL_BYTES = 8 * 1024 * 1024;
/** The events kept (only the types the ledger uses); the oldest go first. */
export const LEDGER_MAX_EVENTS = 4000;

const LEDGER_TYPES = new Set([
  "mission_accepted",
  "mission_completed",
  "mission_ended",
  "objective_new",
  "objective_completed",
  "hauling_objective",
]);

/** What the service needs from the log: injectable, so tests never touch a real Game.log. */
export interface LedgerLogSource {
  readonly configured: boolean;
  stat(): Promise<{ mtimeMs: number; size: number }>;
  /** The whole log as the reader gives it (the end of a very large one). */
  read(): Promise<{ events: LogEvent[]; truncated: boolean; modifiedAt: number }>;
  /** The first bytes of the file, which identify the session. Absent: every read is a full read. */
  head?(): Promise<Buffer>;
  /** Bytes [start, end) of the file. Absent: every read is a full read. */
  bytes?(start: number, end: number): Promise<Buffer>;
}

async function withFile<T>(gameLog: GameLog, use: (h: fs.FileHandle) => Promise<T>): Promise<T> {
  const handle = await fs.open(gameLog.source().file, "r"); // read-only; no lock
  try {
    return await use(handle);
  } finally {
    await handle.close();
  }
}

/** The server's GameLog as a source. Off (`configured` false) unless the user set SC_INSTALL_DIR or SC_GAME_LOG_PATH. */
export function ledgerLogFrom(gameLog: GameLog): LedgerLogSource {
  return {
    get configured() {
      return gameLog.configured;
    },
    stat: async () => {
      const s = await fs.stat(gameLog.source().file);
      return { mtimeMs: s.mtimeMs, size: s.size };
    },
    read: async () => {
      const r = await gameLog.read("current");
      return { events: r.parsed.events, truncated: r.truncated, modifiedAt: r.modifiedAt };
    },
    head: () =>
      withFile(gameLog, async (h) => {
        const buffer = Buffer.alloc(LEDGER_HEAD_BYTES);
        const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
      }),
    bytes: (start, end) =>
      withFile(gameLog, async (h) => {
        if (end - start > LEDGER_MAX_INCREMENTAL_BYTES) throw new Error("range too large");
        const buffer = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await h.read(buffer, 0, buffer.length, start);
        return buffer.subarray(0, bytesRead);
      }),
  };
}

/**
 * What makes two events the same one. The game repeats a hauling line hundreds of times with a new time each time, and
 * a read re-parses a look-behind: the first occurrence of a step is the only one kept (no time in its key). Every other
 * event is identified by its whole content, time included.
 */
const eventKey = (e: LogEvent) =>
  e.type === "hauling_objective"
    ? `h|${String(e.mission_id)}|${String(e.kind)}|${String(e.location)}|${String(e.cargo)}`
    : JSON.stringify(e);

/** A read error that says "try again", as opposed to a log that is gone or not a log. */
function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = `${code ?? ""} ${error instanceof Error ? error.message : ""}`;
  return /\b(EBUSY|EPERM|EACCES|EAGAIN|EMFILE|ENFILE|EIO)\b/.test(text);
}

export class LedgerService {
  private current: LedgerBase = { ...EMPTY_LEDGER, status: "loading" };
  private inFlight: Promise<void> | null = null;
  private lastLookAt: number | null = null;
  private lastModified: number | null = null;
  /** Incremental state: where the last read stopped, how the file began, what was kept. */
  private offset = 0;
  private head: string | null = null;
  private partial = false;
  private events: LogEvent[] = [];
  private keys = new Set<string>();
  /** How the file was read, for tests and diagnostics. */
  reads = 0;
  fullReads = 0;
  incrementalReads = 0;
  bytesParsed = 0;

  constructor(
    private readonly source: LedgerLogSource | undefined,
    private readonly now: () => number = Date.now,
    private readonly refreshMs: number = LEDGER_REFRESH_MS,
  ) {}

  /** How many events are kept (for tests and diagnostics). */
  get eventCount(): number {
    return this.events.length;
  }

  /** The last computed ledger. Synchronous. May start a background refresh; never waits for it. */
  state(): LedgerBase {
    if (!this.source || !this.source.configured) return EMPTY_LEDGER;
    this.maybeRefresh();
    return this.current;
  }

  /** Resolves when the refresh in flight (if any) is done. For tests. */
  async settled(): Promise<void> {
    if (this.inFlight) await this.inFlight;
  }

  private maybeRefresh(): void {
    if (this.inFlight) return;
    const t = this.now();
    if (this.lastLookAt !== null && t - this.lastLookAt < this.refreshMs) return;
    this.lastLookAt = t;
    this.inFlight = this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
  }

  private forget(): void {
    this.lastModified = null;
    this.offset = 0;
    this.head = null;
    this.events = [];
    this.keys = new Set();
  }

  private unreadable(): void {
    this.forget();
    this.current = { ...EMPTY_LEDGER, status: "unreadable" };
  }

  private async refresh(): Promise<void> {
    const source = this.source!;
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await source.stat();
    } catch (error) {
      this.failed(error);
      return;
    }
    if (this.current.status === "ok" && stat.mtimeMs === this.lastModified) return;
    try {
      const done = await this.readIncrementally(source, stat.size);
      if (!done) await this.readFully(source, stat.size);
      this.lastModified = stat.mtimeMs;
      this.reads += 1;
      this.current = {
        status: "ok",
        asOf: stat.mtimeMs,
        partial: this.partial,
        contracts: buildContracts(this.events),
      };
    } catch (error) {
      this.failed(error);
    }
  }

  /** A transient error keeps the contracts known so far (the next look tries again); anything else is unreadable. */
  private failed(error: unknown): void {
    if (this.current.status === "ok" && isTransient(error)) return;
    this.unreadable();
  }

  private async readFully(source: LedgerLogSource, size: number): Promise<void> {
    // The beginning of the file first: if the game appends in between, the next look-behind covers the difference.
    const head = source.head ? await source.head() : null;
    const r = await source.read();
    this.fullReads += 1;
    this.forget();
    this.partial = r.truncated;
    this.offset = size;
    // A log in UTF-16 cannot be read from the middle: every read stays a full one.
    this.head = head && !(head[0] === 0xff && head[1] === 0xfe) ? head.toString("hex") : null;
    this.add(r.events);
  }

  /** Parses only what was added since the last read. False when a full read is needed instead. */
  private async readIncrementally(source: LedgerLogSource, size: number): Promise<boolean> {
    if (this.current.status !== "ok" || this.head === null || !source.head || !source.bytes) {
      return false;
    }
    if (size < this.offset) return false; // the file is shorter than before: renewed or truncated
    if (size - this.offset > LEDGER_MAX_INCREMENTAL_BYTES) return false; // grew a lot: the end of the log, in full
    if ((await source.head()).toString("hex") !== this.head) return false; // another game session
    const start = Math.max(0, this.offset - LEDGER_LOOKBEHIND_BYTES);
    const buffer = await source.bytes(start, size);
    // Only whole lines: the last one may still be being written; it is parsed with the next read.
    const end = buffer.lastIndexOf(0x0a) + 1;
    if (end === 0) return true;
    let text = decodeLog(buffer.subarray(0, end));
    // The look-behind begins in the middle of a line unless it starts at the top of the file: drop that line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    this.bytesParsed += end;
    this.incrementalReads += 1;
    this.add(parseLog(text).events);
    this.offset = start + end;
    return true;
  }

  /** Keeps the events the ledger uses that have not been seen yet (the look-behind re-reads some). */
  private add(events: LogEvent[]): void {
    for (const e of events) {
      if (!LEDGER_TYPES.has(e.type)) continue;
      const key = eventKey(e);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.events.push(e);
    }
    if (this.events.length > LEDGER_MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - LEDGER_MAX_EVENTS);
      this.keys = new Set(this.events.map(eventKey));
    }
  }
}
