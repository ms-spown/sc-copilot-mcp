import type { ConnectionInfo } from "../providers/gamelog/connectionState.js";
import { notInSession } from "../providers/gamelog/connectionState.js";
import type { Session } from "../providers/sessions/types.js";
import type { TelemetrySnapshot, TelemetryStatusReport } from "../providers/telemetry/service.js";

/**
 * The account balance as a standing reminder, independent of any play session ("Solde" in the header of the dashboard).
 *
 * PURE: a snapshot of the stream, the newest saved balance and the clock in, one small object out. No file, no network.
 *
 * Where the figure comes from, and nothing is invented:
 *   - `live`        a frame carried it a moment ago (the stream is live and the player is in a server session);
 *   - `last_known`  the newest reading we hold, with the time it was read: the last frame the stream reader kept in
 *                   memory (`from: "stream"`), or the last balance saved with a play session (`from: "session"`, the
 *                   local sessions file, see providers/sessions). The newer of the two wins;
 *   - `unknown`     no reading at all, with the reason (`game_closed`, `no_reading`). Telemetry off is told by the
 *                   poll's own state, since nothing is read then.
 *
 * PRIVACY: this is an aUEC figure. The service builds it ONLY for a poll that asked for the balance (the same gate as
 * `balance`), it is never put in the channel between Views nor in anything sent to the model (the View strips it).
 */

/** A frame this recent, with the stream live, is "live". The stream sends about 17 frames a second. */
export const ACCOUNT_LIVE_MS = 15_000;

export interface AccountBalance {
  source: "live" | "last_known" | "unknown";
  /** Absent when `source` is "unknown". A decimal string only when the number does not fit (as in `balance`). */
  uec?: number | string;
  /** When the figure was read (ISO); only for "last_known" (a live reading is now). The View works out the age itself. */
  at?: string;
  /** Where a "last_known" figure comes from. */
  from?: "stream" | "session";
  /** Why it is unknown; only for "unknown". */
  reason?: "game_closed" | "no_reading";
}

export interface SavedBalance {
  auec: number;
  /** ISO time of the reading. */
  at: string;
}

/**
 * The newest balance any saved session holds (the current, just-created session has none yet: a session starts with a
 * balance only when one was seen). Looks at every session, newest first; the reading time wins over the order.
 */
export function newestSavedBalance(sessions: readonly Session[]): SavedBalance | null {
  let best: SavedBalance | null = null;
  let bestMs = -Infinity;
  for (const s of sessions) {
    if (typeof s.last_balance !== "number" || !Number.isFinite(s.last_balance)) continue;
    const at = s.last_balance_at ?? s.start_balance_at ?? s.last_activity_at;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    best = { auec: s.last_balance, at: new Date(ms).toISOString() };
    bestMs = ms;
  }
  return best;
}

export interface AccountInput {
  status: Pick<TelemetryStatusReport, "state">;
  snapshot: TelemetrySnapshot | null;
  saved?: SavedBalance | null | undefined;
  connection?: Pick<ConnectionInfo, "state"> | null | undefined;
  nowMs: number;
}

export function buildAccountBalance(input: AccountInput): AccountBalance {
  const { status, snapshot, saved, connection, nowMs } = input;
  const raw = snapshot?.state.pilot?.uec_balance;
  const streamUec =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && /^-?\d{1,20}$/.test(raw)
        ? raw
        : null;
  const streamAt = snapshot ? nowMs - snapshot.frame_age_ms : NaN;
  const stream =
    streamUec !== null && Number.isFinite(streamAt) ? { uec: streamUec, at: streamAt } : null;
  const savedMs = saved ? Date.parse(saved.at) : NaN;
  const hasSaved = !!saved && Number.isFinite(savedMs);

  const fresh = !!stream && status.state === "live" && nowMs - stream.at <= ACCOUNT_LIVE_MS;
  if (stream && fresh && !notInSession(connection)) return { source: "live", uec: stream.uec };
  // The newer reading wins; on a tie the stream's (it is the one that can be live again).
  if (stream && (!hasSaved || stream.at >= savedMs)) {
    return {
      source: "last_known",
      uec: stream.uec,
      at: new Date(stream.at).toISOString(),
      from: "stream",
    };
  }
  if (hasSaved && saved) {
    return {
      source: "last_known",
      uec: saved.auec,
      at: new Date(savedMs).toISOString(),
      from: "session",
    };
  }
  // "Closed" only on the game's own quit line: a stream that waits (menus, loading) does not say the game is not running.
  const closed = connection?.state === "closed";
  return { source: "unknown", reason: closed ? "game_closed" : "no_reading" };
}
