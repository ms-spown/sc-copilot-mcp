import type { SessionBar } from "../providers/sessions/manager.js";
import type { GameLogHint, TelemetryStateName } from "../providers/telemetry/service.js";

/**
 * The `health` section of the poll: what is wired and what is missing, as a handful of codes. Pure, built from facts the
 * server already holds (the telemetry state, the game-log hint it keeps, the connection tracker's answer, the session
 * bar): no new read, no network, nothing stored about the player.
 *
 * Codes only, no sentence: the View owns every text and every command (healthPanel.ts), which keeps this object tiny
 * and its cleaning a whitelist. It carries no amount and nothing derived from the balance, so it is a plain field of the
 * answer (like `sessions`) and takes no part in the hashes. The only text-like value is `label`, one of a fixed list:
 * a path (and the user name it may hold) never leaves this file.
 */

export type HealthLog = "off" | "unchecked" | "ok" | "unreadable";
export type HealthVia = "install_dir" | "log_path";
export type HealthRegistration = "seen" | "not_seen" | "unknown";
/** off: SC_SESSIONS says so. unavailable: they should run but the manager is not there or its bar did not answer. */
export type HealthSessions =
  "on" | "off" | "unavailable" | "needs_telemetry" | "readonly" | "degraded";

export interface HealthSection {
  v: 1;
  /**
   * off: no SC_INSTALL_DIR / SC_GAME_LOG_PATH. unchecked: set, but not looked at (telemetry is off, nothing is read).
   * unreadable: set, but the file cannot be followed (not created yet, wrong folder). ok: followed.
   */
  log: HealthLog;
  via?: HealthVia;
  /** "LIVE/Game.log" style, "Game.log", or "custom". Never a path. */
  label?: string;
  registration: HealthRegistration;
  sessions: HealthSessions;
  /** When this process last wrote the session file. Absent: not yet since the server started. */
  saved_at?: string;
}

/** What never changes while the server runs: how the log is configured. */
export interface LogConfigFacts {
  configured: boolean;
  via: HealthVia | null;
  label: string | null;
}

export interface HealthStatic {
  log: LogConfigFacts;
  /** SC_SESSIONS is off (or 0, false, no). */
  sessionsOff: boolean;
}

export interface HealthFacts {
  telemetryOn: boolean;
  state: TelemetryStateName;
  hint: GameLogHint | null;
  log: LogConfigFacts;
  /** The connection tracker could follow Game.log. Meaningless while telemetry is off. */
  logFollowed: boolean;
  sessionsOff: boolean;
  /** The session bar's status, or null when the server has no session manager (or its bar failed). */
  sessionStatus: SessionBar["status"] | null;
  savedAtMs: number | null;
}

const CHANNELS = ["LIVE", "PTU", "EPTU", "HOTFIX", "TECH-PREVIEW"];

/** The label of a log file: its channel folder and name when they are the game's own, otherwise "custom". */
export function healthLogLabel(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  if (!/^game\.log$/i.test(parts[parts.length - 1] ?? "")) return "custom";
  const parent = (parts[parts.length - 2] ?? "").toUpperCase();
  return CHANNELS.includes(parent) ? `${parent}/Game.log` : "Game.log";
}

/** How the log is configured, from the reader itself. `source()` throws when the name is not a .log. */
export function logConfigFacts(
  gameLog: { configured: boolean; via: HealthVia | null; source(): { file: string } } | undefined,
): LogConfigFacts {
  if (!gameLog?.configured || !gameLog.via) return { configured: false, via: null, label: null };
  let label = "custom";
  try {
    label = healthLogLabel(gameLog.source().file);
  } catch {
    // A name that is not a .log: the reader refuses it too.
  }
  return { configured: true, via: gameLog.via, label };
}

function registration(f: HealthFacts): HealthRegistration {
  if (!f.telemetryOn) return "unknown";
  switch (f.state) {
    case "live":
    case "connected":
      return "seen"; // frames arrive: the game has the variable
    case "game_without_telemetry":
      return "not_seen";
    case "waiting":
      return f.hint?.running && f.hint.telemetryRegistered ? "seen" : "unknown";
    default:
      return "unknown";
  }
}

function sessions(f: HealthFacts): HealthSessions {
  if (!f.telemetryOn) return "needs_telemetry";
  if (f.sessionsOff) return "off";
  if (f.sessionStatus === null || f.sessionStatus === "off") return "unavailable";
  if (f.sessionStatus === "readonly" || f.sessionStatus === "degraded") return f.sessionStatus;
  return "on";
}

export function buildHealth(f: HealthFacts): HealthSection {
  const log: HealthLog = !f.log.configured
    ? "off"
    : !f.telemetryOn
      ? "unchecked"
      : f.logFollowed
        ? "ok"
        : "unreadable";
  return {
    v: 1,
    log,
    ...(f.log.configured && f.log.via ? { via: f.log.via } : {}),
    ...(f.log.configured && f.log.label ? { label: f.log.label } : {}),
    registration: registration(f),
    sessions: sessions(f),
    ...(f.telemetryOn && f.savedAtMs !== null
      ? { saved_at: new Date(f.savedAtMs).toISOString() }
      : {}),
  };
}
