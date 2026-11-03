import fs from "node:fs/promises";
import path from "node:path";
import { decodeLog, parseLog, type ParsedLog } from "./parser.js";

/**
 * Read-only access to the game's own Game.log.
 *
 * Off unless SC_GAME_LOG_PATH (the log file) or SC_INSTALL_DIR (a channel folder such as
 * ...\StarCitizen\LIVE) is set explicitly. Nothing is ever scanned or widened silently:
 * the only other places looked at are two fixed, well-known install folders, and only to
 * SUGGEST them. The file is opened for reading only, in the way that lets the game keep
 * writing (no lock is taken, nothing is created, renamed or deleted), and the contents never
 * go over the network: this module has no HTTP at all.
 */

/** How much of the end of the log is parsed. The header is always read from the start. */
export const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
/** A log written to in the last two minutes means the game is (probably) running. */
const RUNNING_WINDOW_MS = 2 * 60 * 1000;

export interface GameLogConfig {
  logPath?: string;
  installDir?: string;
}

export function gameLogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GameLogConfig {
  return {
    logPath: env.SC_GAME_LOG_PATH?.trim() || undefined,
    installDir: env.SC_INSTALL_DIR?.trim() || undefined,
  };
}

/** Where a default install usually is. Suggestions only: never read unless the user configures them. */
export function suggestedInstallDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.ProgramFiles || "C:\\Program Files";
  return ["LIVE", "PTU"].map((c) => path.join(base, "Roberts Space Industries", "StarCitizen", c));
}

/** The last three path parts: enough to recognise the file, without the user's folder names. */
export function shortPath(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  return `…/${parts.slice(-3).join("/")}`;
}

export class GameLogError extends Error {}

export interface LogSource {
  file: string;
  /** Folder of logbackups, when the log sits in an install folder. */
  backupsDir: string;
}

export function resolveSource(config: GameLogConfig): LogSource | null {
  if (config.logPath) {
    const file = path.resolve(config.logPath);
    return { file, backupsDir: path.join(path.dirname(file), "logbackups") };
  }
  if (config.installDir) {
    const dir = path.resolve(config.installDir);
    return { file: path.join(dir, "Game.log"), backupsDir: path.join(dir, "logbackups") };
  }
  return null;
}

/** Only a regular file called *.log is read: this must not become "read any file". */
function assertLogName(file: string) {
  if (!/\.log$/i.test(file)) {
    throw new GameLogError("The configured log path must be a .log file (normally Game.log).");
  }
}

export interface ReadResult {
  parsed: ParsedLog;
  file: string;
  bytes: number;
  modifiedAt: number;
  /** True when only the end of a larger file was parsed. */
  truncated: boolean;
  running: boolean;
}

export class GameLog {
  constructor(
    private config: GameLogConfig,
    private now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return resolveSource(this.config) !== null;
  }

  source(): LogSource {
    const source = resolveSource(this.config);
    if (!source) {
      throw new GameLogError(
        "The game log is off. Set SC_GAME_LOG_PATH to your Game.log, or SC_INSTALL_DIR to your LIVE or PTU folder, in the server's environment.",
      );
    }
    assertLogName(source.file);
    return source;
  }

  /** The newest file in logbackups, for "the session before this one". */
  private async newestBackup(source: LogSource): Promise<string> {
    let names: string[];
    try {
      names = (await fs.readdir(source.backupsDir)).filter((n) => /\.log$/i.test(n));
    } catch {
      throw new GameLogError(
        "There is no logbackups folder next to the log, so there is no previous session.",
      );
    }
    const stats = await Promise.all(
      names.map(async (n) => ({ n, t: (await fs.stat(path.join(source.backupsDir, n))).mtimeMs })),
    );
    const newest = stats.sort((a, b) => b.t - a.t)[0];
    if (!newest) throw new GameLogError("logbackups is empty, so there is no previous session.");
    return path.join(source.backupsDir, newest.n);
  }

  async read(
    which: "current" | "previous" = "current",
    tailBytes = DEFAULT_TAIL_BYTES,
  ): Promise<ReadResult> {
    const source = this.source();
    const file = which === "previous" ? await this.newestBackup(source) : source.file;

    let handle;
    try {
      handle = await fs.open(file, "r"); // read-only; Node/libuv shares read, write and delete
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new GameLogError(
        code === "ENOENT"
          ? `No log at ${shortPath(file)}. Is the path right, and has the game run at least once?`
          : `The log at ${shortPath(file)} cannot be read (${code ?? "error"}).`,
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new GameLogError(`${shortPath(file)} is not a regular file.`);

      const size = stat.size;
      const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
      await handle.read(head, 0, head.length, 0);

      let body: Buffer;
      let truncated = false;
      if (size <= tailBytes) {
        body = Buffer.alloc(size);
        await handle.read(body, 0, size, 0);
      } else {
        truncated = true;
        body = Buffer.alloc(tailBytes);
        await handle.read(body, 0, tailBytes, size - tailBytes);
      }

      let text = decodeLog(body);
      let parsed: ParsedLog;
      if (truncated) {
        // The cut usually lands inside a line: drop it. Session facts come from the file's
        // header; only the events come from the tail, so nothing is counted twice.
        text = text.slice(text.indexOf("\n") + 1);
        parsed = parseLog(text);
        const header = parseLog(decodeLog(head)).session;
        for (const key of Object.keys(header) as (keyof typeof header)[]) {
          if (
            key !== "clean_exit" &&
            parsed.session[key] === (key === "channel" ? "unknown" : null)
          ) {
            (parsed.session as unknown as Record<string, unknown>)[key] = header[key];
          }
        }
      } else {
        parsed = parseLog(text);
      }
      return {
        parsed,
        file,
        bytes: size,
        modifiedAt: stat.mtimeMs,
        truncated,
        running: which === "current" && this.now() - stat.mtimeMs < RUNNING_WINDOW_MS,
      };
    } finally {
      await handle.close();
    }
  }
}
