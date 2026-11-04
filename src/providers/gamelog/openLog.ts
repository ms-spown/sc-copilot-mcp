import fs from "node:fs/promises";
import { shortPath } from "../../core/paths.js";

/** Thrown for a refusal of the log reader (kept here so that every opener can raise it without a cycle). */
export class GameLogError extends Error {}

/**
 * Open a Game.log read-only. The reader's rule is "only a *.log file"; a symbolic link (or a junction) named Game.log
 * that points at some other file would turn it into "any file the link names". So a link is followed only when what it
 * leads to is itself called *.log (a log moved to another drive through a link stays possible). The file is then opened
 * by its resolved name, which narrows the gap between the check and the open. Errors of the open (ENOENT, EACCES...)
 * come through unchanged, for the callers that tell "not there" from "cannot read".
 */
export async function openLogFile(file: string): Promise<fs.FileHandle> {
  const real = await fs.realpath(file);
  if (!/\.log$/i.test(real)) {
    throw new GameLogError(
      `${shortPath(file)} is a link to a file that is not a .log, so it is not read.`,
    );
  }
  return fs.open(real, "r"); // read-only; Node/libuv shares read, write and delete
}
