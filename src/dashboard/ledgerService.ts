import fs from "node:fs/promises";
import type { LogEvent } from "../providers/gamelog/parser.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import { buildContracts, EMPTY_LEDGER, type LedgerBase } from "./ledger.js";

/**
 * The reading side of the transport ledger: keeps the contracts of the current game session in memory and refreshes
 * them thriftily from Game.log.
 *
 * - `state()` is synchronous and returns the LAST computed result. It never waits for a file. The poll calls it.
 * - At most every LEDGER_REFRESH_MS it starts a refresh in the background: the file's modification date is looked
 *   at (one `stat`), and the file is read and parsed again only when that date changed since the last read.
 * - A refresh that hangs does not pile up: while one is in flight no other starts.
 * - The file read is asynchronous and lock-free (GameLog opens it read-only). Parsing a large log is synchronous
 *   work, done at most once per refresh. Nothing is written, nothing leaves the process.
 */

/** Minimum time between two looks at the log file. */
export const LEDGER_REFRESH_MS = 5000;

/** What the service needs from the log: injectable, so tests never touch a real Game.log. */
export interface LedgerLogSource {
  readonly configured: boolean;
  stat(): Promise<{ mtimeMs: number }>;
  read(): Promise<{ events: LogEvent[]; truncated: boolean; modifiedAt: number }>;
}

/** The server's GameLog as a source. Off (`configured` false) unless the user set SC_INSTALL_DIR or SC_GAME_LOG_PATH. */
export function ledgerLogFrom(gameLog: GameLog): LedgerLogSource {
  return {
    get configured() {
      return gameLog.configured;
    },
    stat: async () => ({ mtimeMs: (await fs.stat(gameLog.source().file)).mtimeMs }),
    read: async () => {
      const r = await gameLog.read("current");
      return { events: r.parsed.events, truncated: r.truncated, modifiedAt: r.modifiedAt };
    },
  };
}

export class LedgerService {
  private current: LedgerBase = { ...EMPTY_LEDGER, status: "loading" };
  private inFlight: Promise<void> | null = null;
  private lastLookAt: number | null = null;
  private lastModified: number | null = null;
  /** How many times the file was actually read (for tests and diagnostics). */
  reads = 0;

  constructor(
    private readonly source: LedgerLogSource | undefined,
    private readonly now: () => number = Date.now,
    private readonly refreshMs: number = LEDGER_REFRESH_MS,
  ) {}

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

  private async refresh(): Promise<void> {
    const source = this.source!;
    let mtimeMs: number;
    try {
      mtimeMs = (await source.stat()).mtimeMs;
    } catch {
      this.lastModified = null;
      this.current = { ...EMPTY_LEDGER, status: "unreadable" };
      return;
    }
    if (this.current.status === "ok" && mtimeMs === this.lastModified) return;
    try {
      const r = await source.read();
      this.reads += 1;
      this.lastModified = mtimeMs;
      this.current = {
        status: "ok",
        asOf: r.modifiedAt,
        partial: r.truncated,
        contracts: buildContracts(r.events),
      };
    } catch {
      this.lastModified = null;
      this.current = { ...EMPTY_LEDGER, status: "unreadable" };
    }
  }
}
