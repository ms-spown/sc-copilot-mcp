import fs from "node:fs/promises";
import { connectionFromText, UNKNOWN_CONNECTION, type ConnectionInfo } from "./connectionState.js";
import { decodeLog } from "./parser.js";
import type { GameLog } from "./reader.js";

// The state machine is in connectionState.ts (pure). This file only follows the end of Game.log.
export * from "./connectionState.js";

/** The first read looks at this much of the end of the log: a session's connection lines are far smaller. */
export const FIRST_READ_BYTES = 4 * 1024 * 1024;
/** Never more than this in one read: a burst is processed over the next polls. */
const MAX_STEP_BYTES = 2 * 1024 * 1024;
/** One `stat` at most this often. */
const MIN_INTERVAL_MS = 400;

/**
 * Follows the end of Game.log and keeps the current state. One `stat` per call (at most every 400 ms), and
 * only the bytes added since the last call are read. Null when the log is not configured or cannot be read.
 * Read-only, no lock, nothing written.
 */
export class ConnectionTracker {
  private info: ConnectionInfo = UNKNOWN_CONNECTION;
  private file = "";
  private offset = 0;
  private carry = "";
  private firstRead = true;
  private checkedAt = 0;
  private busy: Promise<void> | null = null;

  constructor(
    private readonly gameLog: GameLog,
    private readonly now: () => number = Date.now,
  ) {}

  async current(): Promise<ConnectionInfo | null> {
    if (!this.gameLog.configured) return null;
    if (this.busy) await this.busy;
    else if (this.now() - this.checkedAt >= MIN_INTERVAL_MS) {
      this.busy = this.advance().finally(() => {
        this.busy = null;
      });
      await this.busy;
    }
    return this.file ? this.info : null;
  }

  private async advance(): Promise<void> {
    this.checkedAt = this.now();
    let handle;
    try {
      const file = this.gameLog.source().file;
      handle = await fs.open(file, "r");
      if (file !== this.file) this.reset(file);
    } catch {
      this.file = "";
      return;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      if (stat.size < this.offset) this.reset(this.file); // the log was recreated
      if (stat.size === this.offset) return;
      const from = this.offset === 0 ? Math.max(0, stat.size - FIRST_READ_BYTES) : this.offset;
      const length = Math.min(stat.size - from, MAX_STEP_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      this.offset = from + bytesRead;
      let text = this.carry + decodeLog(buffer.subarray(0, bytesRead));
      if (this.firstRead && from > 0) {
        // The first read starts mid-file: its first line is probably cut.
        text = text.slice(text.indexOf("\n") + 1);
      }
      this.firstRead = false;
      const cut = text.lastIndexOf("\n");
      this.carry = cut < 0 ? text.slice(-4096) : text.slice(cut + 1);
      this.info = connectionFromText(cut < 0 ? "" : text.slice(0, cut), this.info);
    } finally {
      await handle.close();
    }
  }

  private reset(file: string): void {
    this.file = file;
    this.offset = 0;
    this.carry = "";
    this.firstRead = true;
    this.info = UNKNOWN_CONNECTION;
  }
}
