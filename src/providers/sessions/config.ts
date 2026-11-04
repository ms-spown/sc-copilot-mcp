import path from "node:path";
import { userDataDir } from "../../core/paths.js";

/**
 * Settings of the session file.
 *
 * - Sessions exist ONLY while live telemetry is on (SC_TELEMETRY=on): with telemetry off nothing is created, read or
 *   watched, whatever else is set.
 * - SC_SESSIONS=off (or 0, false, no) switches persistence off while telemetry stays on: no file is created or read.
 * - SCMCP_SESSIONS_FILE moves the file; the default is in the per-user data folder (core/paths.ts).
 * - SC_SESSION_GAP_HOURS is the quiet time after which the next play period is a NEW session (default 3, from 0.25
 *   to 48). Within that time the last session is resumed, whether the game ended cleanly or not.
 */

export const DEFAULT_GAP_HOURS = 3;
export const MIN_GAP_HOURS = 0.25;
export const MAX_GAP_HOURS = 48;

export interface SessionsConfig {
  enabled: boolean;
  file: string;
  gapMs: number;
}

export const sessionsFilePath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SCMCP_SESSIONS_FILE
    ? path.resolve(env.SCMCP_SESSIONS_FILE)
    : path.join(userDataDir(env), "sessions.json");

export function gapHours(raw: string | undefined): number {
  const n = Number((raw ?? "").trim().replace(",", "."));
  if (!raw?.trim() || !Number.isFinite(n) || n < MIN_GAP_HOURS || n > MAX_GAP_HOURS)
    return DEFAULT_GAP_HOURS;
  return n;
}

/** SC_SESSIONS=off (or 0, false, no). */
export const sessionsSwitchedOff = (env: NodeJS.ProcessEnv = process.env): boolean =>
  /^(off|0|false|no)$/i.test(env.SC_SESSIONS?.trim() ?? "");

export function sessionsConfig(
  env: NodeJS.ProcessEnv = process.env,
  telemetryOn: boolean,
): SessionsConfig {
  return {
    enabled: telemetryOn && !sessionsSwitchedOff(env),
    file: sessionsFilePath(env),
    gapMs: Math.round(gapHours(env.SC_SESSION_GAP_HOURS) * 3_600_000),
  };
}
