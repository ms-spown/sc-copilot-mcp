/**
 * Where the player stands towards the game servers, read from the lines the game writes in Game.log. The
 * telemetry stream does not say it: it simply goes quiet, or keeps repeating the last values, which is why a
 * player kicked for inactivity still saw a calm dashboard.
 *
 * Every marker below was seen in real LIVE logs (build 4.10, November 2026), three times each, and nothing else
 * is guessed:
 *
 * - `<Join PU>` then `<CDisciplineServiceExternal::BeginSession>`: the client joined a universe server.
 * - `<Channel Disconnected>` outside the front-end (gamerules other than SC_Frontend): the server link is gone.
 *   The kick for inactivity reads `cause=30028 reason="Remote Disconnect - player inactive"`. The same line with
 *   `gamerules="SC_Frontend"` (cause 30010, "Nub destroyed") is the local menu being torn down while joining a
 *   server: it is NOT a disconnection and is ignored.
 * - `<Error Popup Opened> errorCode=N ... [Team_UI][Disconnection]`: the "you were disconnected" window.
 * - `<CDisciplineServiceExternal::EndSession>`: the server session is over (written with every kick seen).
 * - `<[EALobby] EALobbyQuit>`: the player is back in the menu.
 * - `<SystemQuit>`: the game closes (its cause is not kept: it is not a connection cause).
 * - `<LoginCompleted>`: logged in again, so in the menus (used only to leave `unknown` or `closed`).
 *
 * This file is pure (no file access, no node import): the file follower is in connection.ts.
 *
 * Read-only and local. Only a state, a time, a numeric code and a short reason are kept: no handle, address,
 * session id, node id or any other line content ever leaves this file.
 */

export type ConnectionState =
  /** No marker seen yet (log just rotated, or an older build): never presented as a fact. */
  | "unknown"
  /** Logged in, in the menus (before joining a server, or back from a disconnection). */
  | "menu"
  /** Joined a universe server. */
  | "online"
  /** Kicked or cut from the server. `code` and `reason` say why when the game wrote them. */
  | "disconnected"
  /** The game wrote its quit line. */
  | "closed";

export interface ConnectionInfo {
  state: ConnectionState;
  /** UTC time, from the log, of the line that set this state. */
  since: string | null;
  /** The game's own numeric cause (30028 = inactivity); only with `disconnected`. */
  code: number | null;
  /** The game's own reason text, reduced to a short safe charset; only with `disconnected`. */
  reason: string | null;
}

export const UNKNOWN_CONNECTION: ConnectionInfo = {
  state: "unknown",
  since: null,
  code: null,
  reason: null,
};

/** True when the log says the player is not in a server session: whatever the stream still holds is not current. */
export function notInSession(
  connection: Pick<ConnectionInfo, "state"> | null | undefined,
): boolean {
  const state = connection?.state;
  return state === "disconnected" || state === "menu" || state === "closed";
}

/** One sentence for an agent: what the state means for the data it is about to read. */
export function describeConnection(info: ConnectionInfo): string {
  switch (info.state) {
    case "disconnected":
      return info.code === 30028
        ? "The server disconnected the player for inactivity. The stream's last values are NOT current: tell the player they were disconnected."
        : "The player is no longer connected to a game server. The stream's last values are NOT current: tell the player they were disconnected.";
    case "menu":
      return "The player is in the game's menus, not in a server session. The stream's last values are NOT current.";
    case "closed":
      return "The game wrote its quit line. The stream's last values are NOT current.";
    case "online":
      return "The player is connected to a game server.";
    default:
      return "Unknown: the game log shows no connection marker yet. Not a fact either way.";
  }
}

const STAMP = /^<(\d{4}-\d{2}-\d{2}T[\d:.]+Z)>/;
const SAFE_REASON = /[^A-Za-z0-9 ._:\-/()]/g;

function cleanReason(raw: string | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(SAFE_REASON, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean || null;
}

/** Applies one log line to the state. Pure: the same line on the same state gives the same state. */
export function applyConnectionLine(prev: ConnectionInfo, line: string): ConnectionInfo {
  const stamp = line.match(STAMP);
  if (!stamp) return prev;
  const at = stamp[1];
  const body = line.slice(stamp[0].length);
  const set = (
    state: ConnectionState,
    code: number | null = null,
    reason: string | null = null,
  ): ConnectionInfo => ({ state, since: at, code, reason });

  // Anchored on the line's own tag ("[Notice] <Tag> ..."): a marker word inside free text cannot forge a state.
  const tagged = body.match(/^\s*\[\w+\]\s*<([^>]*)>(.*)$/);
  if (!tagged) return prev;
  const tag = tagged[1];
  const rest = tagged[2];
  switch (tag) {
    case "Join PU":
    case "CDisciplineServiceExternal::BeginSession":
      // BeginSession follows Join PU by milliseconds: keep the earlier time.
      return prev.state === "online" ? prev : set("online");
    case "Channel Disconnected": {
      if (/gamerules="SC_Frontend"/.test(rest)) return prev; // the menu's own link, torn down on joining
      if (prev.state === "disconnected") return prev; // the second side of the same cut
      const code = rest.match(/\bcause=(\d{1,6})\b/);
      const reason = rest.match(/\breason="([^"]*)"/);
      return set("disconnected", code ? Number(code[1]) : null, cleanReason(reason?.[1]));
    }
    case "Error Popup Opened": {
      const popup = rest.match(/^\s*errorCode=(\d{1,6})\b.*\[Team_UI\]\[Disconnection\]/);
      if (!popup) return prev;
      if (prev.state === "disconnected")
        return prev.code === null ? { ...prev, code: Number(popup[1]) } : prev;
      return set("disconnected", Number(popup[1]));
    }
    case "CDisciplineServiceExternal::EndSession":
      return prev.state === "online" ? set("disconnected") : prev;
    case "[EALobby] EALobbyQuit":
      // Back in the menu. Ignored while online: leaving a lobby does not end the server session.
      return prev.state === "online" ? prev : set("menu");
    case "LoginCompleted":
      return prev.state === "unknown" || prev.state === "closed" ? set("menu") : prev;
    case "SystemQuit":
      return set("closed");
    default:
      return prev;
  }
}

/** The state after a whole text (tests, and the first read of a log). */
export function connectionFromText(text: string, start: ConnectionInfo = UNKNOWN_CONNECTION) {
  let state = start;
  for (const line of text.split(/\r?\n/)) {
    // A cheap guard before the regexes: the log is mostly lines this module does not care about.
    if (line.length < 20 || line.charCodeAt(0) !== 60) continue;
    state = applyConnectionLine(state, line);
  }
  return state;
}
