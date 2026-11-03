import fs from "node:fs/promises";
import { connectionFromText, UNKNOWN_CONNECTION, type ConnectionInfo } from "./connectionState.js";
import { decodeLog } from "./parser.js";
import type { GameLog } from "./reader.js";

// The state machine is in connectionState.ts (pure). This file only follows the end of Game.log.
export * from "./connectionState.js";

/** The first read looks at this much of the end of the log: a session's connection lines are far smaller. */
export const FIRST_READ_BYTES = 4 * 1024 * 1024;
/** One read of at most this much. */
const MAX_STEP_BYTES = 2 * 1024 * 1024;
/** Steps in one call: with the 4 MiB catch-up limit this always reaches the end of the file. */
const MAX_STEPS = 4;
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
  /** Identity of the file being followed: a new one (rotation) starts the state over. */
  private birth = 0;
  private ino = 0;
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
    let file: string;
    try {
      file = this.gameLog.source().file;
    } catch {
      this.file = "";
      return;
    }
    let handle;
    try {
      handle = await fs.open(file, "r");
    } catch (error) {
      // A file that is not there (the game is restarting) is "nothing to report"; a transient error (antivirus,
      // sharing) keeps what is known instead of forgetting it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.file = "";
      return;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return;
      // A new file (the game recreated the log, even one bigger than the old offset) or a shorter one: start over.
      if (
        file !== this.file ||
        stat.size < this.offset ||
        stat.birthtimeMs !== this.birth ||
        stat.ino !== this.ino
      ) {
        this.reset(file, stat.birthtimeMs, stat.ino);
      }
      // Too far behind (idle for long, or a burst): what was skipped is not worth replaying, only the end matters.
      if (this.offset > 0 && stat.size - this.offset > FIRST_READ_BYTES) {
        this.reset(file, stat.birthtimeMs, stat.ino);
      }
      // Always to the end of what exists now: a state read before the end would be a wrong answer.
      for (let step = 0; step < MAX_STEPS && this.offset < stat.size; step++) {
        await this.readStep(handle, stat.size);
      }
    } finally {
      await handle.close();
    }
  }

  private async readStep(handle: fs.FileHandle, size: number): Promise<void> {
    const from = this.offset === 0 ? Math.max(0, size - FIRST_READ_BYTES) : this.offset;
    const length = Math.min(size - from, MAX_STEP_BYTES);
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
  }

  private reset(file: string, birth = 0, ino = 0): void {
    this.file = file;
    this.birth = birth;
    this.ino = ino;
    this.offset = 0;
    this.carry = "";
    this.firstRead = true;
    this.info = UNKNOWN_CONNECTION;
  }
}
