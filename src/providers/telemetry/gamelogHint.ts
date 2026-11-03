import fs from "node:fs/promises";
import type { GameLog } from "../gamelog/reader.js";
import { decodeLog } from "../gamelog/parser.js";
import type { GameLogHint } from "./service.js";

/**
 * Whether the running game registered the telemetry service, read from the head of Game.log. Used only to tell
 * "game running without telemetry" from "game not running". Read-only, no lock, never leaves the process, and
 * only a yes/no comes out. Null when the log is not configured or cannot be read.
 */

const HEAD_BYTES = 512 * 1024;
const RUNNING_WINDOW_MS = 2 * 60 * 1000;
export const REGISTERED_LINE = "Service 'sc.game.telemetry.v1.GameTelemetryService' registered";

export function createGameLogHint(
  gameLog: GameLog,
  now: () => number = Date.now,
): () => Promise<GameLogHint | null> {
  return async () => {
    if (!gameLog.configured) return null;
    let handle;
    try {
      handle = await fs.open(gameLog.source().file, "r");
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      return {
        running: now() - stat.mtimeMs < RUNNING_WINDOW_MS,
        telemetryRegistered: decodeLog(buffer).includes(REGISTERED_LINE),
      };
    } finally {
      await handle.close();
    }
  };
}
