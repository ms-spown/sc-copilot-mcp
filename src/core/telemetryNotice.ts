/**
 * Constants shared by the telemetry activation command and the doctor. A leaf module: it imports nothing, so the
 * install scripts can use it without loading the telemetry provider (and the HTTP/2 code behind it).
 */

/** The game's local telemetry port. A test checks it equals the reader's own constant. */
export const TELEMETRY_PORT = 2942;

/** Server side: set to "on" in the env of the sc-copilot entry of the Claude Desktop config. */
export const SERVER_SWITCH = "SC_TELEMETRY";
/** Game side: set in the environment of the RSI Launcher, which StarCitizen.exe inherits. */
export const GAME_SWITCH = "GRPC_CLIENT_SERVER_ENABLED";

/** Short warning shown by `npm run telemetry -- enable`. The full text is docs/TELEMETRY.md (written in a later milestone). */
export const TELEMETRY_WARNING: string[] = [
  "Warning: this uses an undocumented feature of the game (a local gRPC server).",
  "To our knowledge CIG has neither allowed nor forbidden it. The risk is yours; nothing here is a guarantee.",
  "Everything stays on your machine (127.0.0.1) and read-only. Read docs/TELEMETRY.md, including its Risks section.",
];

export const LAUNCHER_REMINDER =
  "The game inherits the variable from the RSI Launcher: quit the launcher COMPLETELY (tray icon included), then start it again. A launcher that stays open in the tray cancels the change.";
