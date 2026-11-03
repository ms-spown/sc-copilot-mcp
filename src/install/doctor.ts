/**
 * "Is my installation healthy?", as a list of checks with a fix for each problem.
 * Pure: the script gathers the facts (files, environment) and this decides what they mean, so every
 * rule is testable without touching a real machine. Nothing here ever prints a secret: the token is
 * reported as set or not set, never its value or length.
 */
import { stripBom } from "./mergeConfig.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface DoctorFacts {
  nodeVersion: string;
  distBuilt: boolean;
  envFile: { exists: boolean; hasToken: boolean };
  /** Raw claude_desktop_config.json, or null when it does not exist. */
  claudeConfig: string | null;
  serverName: string;
  /** Where this checkout's dist/index.js is. */
  expectedEntry: string;
  fleet: { exists: boolean; count: number; error?: string };
  cacheWritable: boolean;
  gameLog: { configured: boolean; readable: boolean; file?: string; error?: string };
  /** Live telemetry switches. Omitted when the caller did not look. */
  telemetry?: TelemetryFacts;
}

export interface TelemetryFacts {
  /** SC_TELEMETRY in the sc-copilot entry of the Claude config. */
  serverSwitch: "on" | "other" | "absent";
  /** The persistent user variable GRPC_CLIENT_SERVER_ENABLED. */
  gameVar: "unset" | "true" | "other" | "unknown";
  /** "not_tested" whenever the server switch is not on: no connection is made without activation. */
  port: "open" | "closed" | "not_tested";
}

/** The runtime supports Node 20.19+, 22.13+ and 24+ (the range in package.json). */
export function nodeSupported(version: string): boolean {
  const m = version.replace(/^v/, "").match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24;
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

export function diagnose(f: DoctorFacts): Check[] {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, message: string, fix?: string) =>
    checks.push({ id, status, message, ...(fix ? { fix } : {}) });

  if (nodeSupported(f.nodeVersion)) {
    add("node", "ok", `Node ${f.nodeVersion}`);
  } else {
    add(
      "node",
      "fail",
      `Node ${f.nodeVersion} is not supported`,
      "Install Node 20.19+, 22.13+ or 24+ from nodejs.org.",
    );
  }

  if (f.distBuilt) {
    add("build", "ok", "dist/ is built");
  } else {
    add(
      "build",
      "fail",
      "dist/index.js is missing",
      "Run: npm ci --ignore-scripts && npm run build",
    );
  }

  if (!f.envFile.exists) {
    add(
      "uex-token",
      "warn",
      "No .env file next to package.json: UEX requests go out without your token (public endpoints still answer)",
      "Copy .env.example to .env and paste your own token after UEXTOKEN= (create it at https://uexcorp.space/api/apps).",
    );
  } else if (!f.envFile.hasToken) {
    add(
      "uex-token",
      "warn",
      ".env exists but UEXTOKEN is empty",
      "Paste your UEX token after UEXTOKEN=.",
    );
  } else {
    add("uex-token", "ok", "UEX token is set in .env");
  }

  if (f.claudeConfig === null) {
    add(
      "claude",
      "warn",
      "Claude Desktop config not found",
      "Run: npm run install:claude  (dry run), then add --apply.",
    );
  } else {
    let entry: { args?: string[]; env?: Record<string, string> } | undefined;
    try {
      const parsed = JSON.parse(stripBom(f.claudeConfig));
      entry = parsed?.mcpServers?.[f.serverName];
    } catch {
      add(
        "claude",
        "fail",
        "claude_desktop_config.json is not valid JSON",
        "Fix the file by hand; the installer refuses to touch an invalid file.",
      );
    }
    if (!checks.some((c) => c.id === "claude")) {
      if (!entry) {
        add(
          "claude",
          "warn",
          `The "${f.serverName}" server is not in the Claude Desktop config`,
          "Run: npm run install:claude  (dry run), then add --apply, then restart Claude Desktop.",
        );
      } else if (!(entry.args ?? []).some((a) => samePath(a, f.expectedEntry))) {
        add(
          "claude",
          "warn",
          `The "${f.serverName}" entry points to a different checkout`,
          "Re-run: npm run install:claude -- --apply from this folder.",
        );
      } else {
        add(
          "claude",
          "ok",
          `Claude Desktop is configured (profiles: ${entry.env?.SCMCP_PROFILES ?? "all tools"})`,
        );
      }
    }
  }

  if (f.fleet.error)
    add(
      "fleet",
      "warn",
      `Fleet file problem: ${f.fleet.error}`,
      "Fix or move the file; it is never overwritten while invalid.",
    );
  else if (!f.fleet.exists) add("fleet", "ok", "No fleet file yet (sc_fleet_upsert creates it)");
  else add("fleet", "ok", `Fleet file with ${f.fleet.count} ship${f.fleet.count === 1 ? "" : "s"}`);

  if (f.cacheWritable) {
    add("cache", "ok", "Cache folder is writable");
  } else {
    add(
      "cache",
      "warn",
      "The cache folder is not writable: answers still work but are not kept",
      "Set SCMCP_CACHE_DIR to a folder you can write to.",
    );
  }

  if (!f.gameLog.configured) {
    add(
      "game-log",
      "ok",
      "Game log is off (set SC_INSTALL_DIR in the Claude config to enable sc_log_* tools)",
    );
  } else if (f.gameLog.readable) {
    add("game-log", "ok", `Game log readable (${f.gameLog.file})`);
  } else {
    add(
      "game-log",
      "warn",
      `Game log configured but unreadable: ${f.gameLog.error ?? "unknown reason"}`,
      "Check SC_INSTALL_DIR points at the folder that contains Game.log (for example ...\\StarCitizen\\LIVE).",
    );
  }

  if (f.telemetry) addTelemetryChecks(f.telemetry, add);

  return checks;
}

function addTelemetryChecks(
  t: TelemetryFacts,
  add: (id: string, status: CheckStatus, message: string, fix?: string) => void,
): void {
  const serverOn = t.serverSwitch === "on";
  const gameOn = t.gameVar === "true";
  const enableFix = "Run: npm run telemetry -- enable  (a dry run), then add --apply.";

  if (!serverOn && !gameOn) {
    add(
      "telemetry",
      "ok",
      "Live telemetry is off (the default). Switch 1 (SC_TELEMETRY): off. Switch 2 (GRPC_CLIENT_SERVER_ENABLED): not set. Port not tested: no connection without activation",
    );
    return;
  }
  const s1 = serverOn ? "on" : t.serverSwitch === "other" ? "set but not on" : "off";
  const s2 = gameOn
    ? "set"
    : t.gameVar === "other"
      ? "set to another value"
      : t.gameVar === "unknown"
        ? "unknown"
        : "not set";
  const summary = `Switch 1 (SC_TELEMETRY in the Claude config): ${s1}. Switch 2 (GRPC_CLIENT_SERVER_ENABLED, user variable): ${s2}`;
  if (serverOn && gameOn) {
    add("telemetry", "ok", `Live telemetry is on. ${summary}`);
  } else if (serverOn) {
    add("telemetry", "warn", `Only the server side is on. ${summary}`, enableFix);
  } else {
    add(
      "telemetry",
      "warn",
      `Only the game side is set, so the server will not read the stream. ${summary}`,
      enableFix,
    );
  }

  if (t.port === "not_tested") {
    add(
      "telemetry-port",
      "ok",
      "Port 2942 not tested: SC_TELEMETRY is not on in the Claude config",
    );
    return;
  }
  if (t.port === "open") {
    add("telemetry-port", "ok", "Port 127.0.0.1:2942 is open (something is listening)");
    add(
      "telemetry-stream",
      "ok",
      "Stream: not verified (the doctor opens no gRPC connection). Ask Claude for sc_live_status",
    );
    return;
  }
  add(
    "telemetry-port",
    "warn",
    gameOn
      ? "Port 127.0.0.1:2942 is closed although the variable is set: the launcher has to be restarted, or the game is not running"
      : "Port 127.0.0.1:2942 is closed (the game is not running, or its telemetry is not switched on)",
    "Quit the RSI Launcher completely (tray icon included), start it again, then start the game.",
  );
  add(
    "telemetry-stream",
    "ok",
    "Stream: not verified (the port is closed, and the doctor opens no gRPC connection)",
  );
}

export function summarize(checks: Check[]): { failed: number; warned: number } {
  return {
    failed: checks.filter((c) => c.status === "fail").length,
    warned: checks.filter((c) => c.status === "warn").length,
  };
}
