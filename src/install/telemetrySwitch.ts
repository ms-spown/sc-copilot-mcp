/**
 * `npm run telemetry -- status | enable | disable`: the two explicit switches of the live telemetry, in one place.
 *
 *   server side: SC_TELEMETRY=on in the env of the sc-copilot entry of claude_desktop_config.json
 *   game side:   GRPC_CLIENT_SERVER_ENABLED=true in the user environment (the RSI Launcher passes it to the game)
 *
 * Everything with a side effect goes through an injected dependency (the user environment store, the port probe,
 * the clock, the folders), and nothing here has a default for them: only scripts/telemetry.mjs builds the real
 * ones, so a test can never reach the real variable or the real Claude config. enable and disable are dry runs
 * unless `apply` is true. Nothing from the config file is ever printed except key names and booleans.
 */
import fs from "node:fs";
import path from "node:path";
import {
  GAME_SWITCH,
  LAUNCHER_REMINDER,
  SERVER_SWITCH,
  TELEMETRY_PORT,
  TELEMETRY_WARNING,
} from "../core/telemetryNotice.js";
import type { TelemetryFacts } from "./doctor.js";
import type { EnvStore } from "./envStore.js";
import { ConfigError, describeEnvKeyPlan, planEnvKey, type EnvKeyPlan } from "./mergeConfig.js";
import type { PortProbe, PortState } from "./portProbe.js";

export interface SwitchDeps {
  /** process.platform. Anything but "win32" gets manual instructions and no write at all. */
  platform: string;
  /** The user environment; null when this platform has none we can handle. */
  store: EnvStore | null;
  probe: PortProbe;
  configPath: string;
  serverName: string;
  /** Folder of the marker file and of the generated launcher: the app's user config folder, never the repo. */
  markerDir: string;
  now: () => Date;
  /** Standard places of the RSI Launcher, tried in order when --launcher is not given. */
  launcherCandidates: string[];
  fileExists: (file: string) => boolean;
}

export interface SwitchResult {
  code: number;
  lines: string[];
}

export const MARKER_FILE = "telemetry-switch.json";
export const SESSION_SCRIPT = "start-rsi-launcher-with-telemetry.cmd";

/** What the tool itself did, so that disable removes that and nothing else. Booleans, paths and names only. */
export interface Marker {
  version: 1;
  updatedAt: string;
  /** "tool": absent before, set by us. "manual": it was already there, so it is not ours to remove. */
  gameVar: { origin: "tool" | "manual" } | null;
  config: { path: string; backup: string | null } | null;
  session: { script: string; launcher: string } | null;
}

export function readMarker(markerDir: string): Marker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(markerDir, MARKER_FILE), "utf8"));
    if (parsed?.version !== 1) return null;
    const origin = parsed.gameVar?.origin;
    return {
      version: 1,
      updatedAt: String(parsed.updatedAt ?? ""),
      gameVar: origin === "tool" || origin === "manual" ? { origin } : null,
      config:
        typeof parsed.config?.path === "string"
          ? {
              path: parsed.config.path,
              backup: typeof parsed.config.backup === "string" ? parsed.config.backup : null,
            }
          : null,
      session:
        typeof parsed.session?.script === "string" && typeof parsed.session?.launcher === "string"
          ? { script: parsed.session.script, launcher: parsed.session.launcher }
          : null,
    };
  } catch {
    // Missing or damaged: treated as "we set nothing", which is the safe side (nothing gets removed).
    return null;
  }
}

function writeMarker(deps: SwitchDeps, marker: Marker): void {
  fs.mkdirSync(deps.markerDir, { recursive: true });
  writeAtomic(
    path.join(deps.markerDir, MARKER_FILE),
    `${JSON.stringify({ ...marker, updatedAt: deps.now().toISOString() }, null, 2)}\n`,
  );
}

function deleteMarker(markerDir: string): void {
  fs.rmSync(path.join(markerDir, MARKER_FILE), { force: true });
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const emptyMarker = (): Marker => ({
  version: 1,
  updatedAt: "",
  gameVar: null,
  config: null,
  session: null,
});

// ---------------------------------------------------------------------------------------------------------
// Reading the two switches

export type GameVarState = "unset" | "true" | "other" | "unknown";
export type ServerSwitchState = "on" | "other" | "absent";

async function readGameVar(deps: SwitchDeps): Promise<GameVarState> {
  if (!deps.store) return "unknown";
  const value = await deps.store.get(GAME_SWITCH);
  if (value === null || value === "") return "unset";
  return /^true$/i.test(value.trim()) ? "true" : "other";
}

interface ConfigFacts {
  exists: boolean;
  raw: string | null;
}

function readConfigFile(file: string): ConfigFacts {
  try {
    return { exists: true, raw: fs.readFileSync(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, raw: null };
    throw error;
  }
}

/** Looks at the entry without exposing any of its content. */
function readServerSwitch(
  raw: string | null,
  name: string,
): { entryPresent: boolean; state: ServerSwitchState; valid: boolean } {
  if (raw === null) return { entryPresent: false, state: "absent", valid: true };
  try {
    const entry = JSON.parse(raw)?.mcpServers?.[name];
    if (!entry || typeof entry !== "object")
      return { entryPresent: false, state: "absent", valid: true };
    const value = entry.env?.[SERVER_SWITCH];
    if (typeof value !== "string") return { entryPresent: true, state: "absent", valid: true };
    return {
      entryPresent: true,
      state: /^(on|1|true|yes)$/i.test(value.trim()) ? "on" : "other",
      valid: true,
    };
  } catch {
    return { entryPresent: false, state: "absent", valid: false };
  }
}

/**
 * The facts the doctor needs. The loopback port is tested ONLY when SC_TELEMETRY is on in the config: without
 * that activation no connection is made, not even a TCP one.
 */
export async function gatherTelemetryFacts(input: {
  configRaw: string | null;
  serverName: string;
  store: EnvStore | null;
  probe: PortProbe;
}): Promise<TelemetryFacts> {
  const server = readServerSwitch(input.configRaw, input.serverName);
  let gameVar: TelemetryFacts["gameVar"] = "unknown";
  if (input.store) {
    try {
      const value = await input.store.get(GAME_SWITCH);
      gameVar =
        value === null || value === "" ? "unset" : /^true$/i.test(value.trim()) ? "true" : "other";
    } catch {
      gameVar = "unknown";
    }
  }
  const port = server.state === "on" ? await input.probe(TELEMETRY_PORT) : "not_tested";
  return { serverSwitch: server.state, gameVar, port };
}

function describeGameVar(state: GameVarState, marker: Marker | null): string {
  switch (state) {
    case "unset":
      return "not set";
    case "true":
      return marker?.gameVar?.origin === "tool"
        ? "set to true (set by this tool)"
        : "set to true (set by hand, or before this tool: it is not ours to remove)";
    case "other":
      return "set, but to something other than true (not touched by this tool)";
    case "unknown":
      return "unknown (no user environment store on this platform)";
  }
}

// ---------------------------------------------------------------------------------------------------------
// status

export async function statusCommand(deps: SwitchDeps): Promise<SwitchResult> {
  const lines: string[] = ["Live telemetry: status (read-only)", ""];
  const config = readConfigFile(deps.configPath);
  const server = readServerSwitch(config.raw, deps.serverName);
  const marker = readMarker(deps.markerDir);
  let gameVar: GameVarState = "unknown";
  let gameVarError: string | null = null;
  try {
    gameVar = await readGameVar(deps);
  } catch (error) {
    gameVarError = (error as Error).message;
  }

  lines.push(`Switch 1, server side: ${SERVER_SWITCH} in the Claude Desktop config`);
  lines.push(`  config file:        ${config.exists ? "found" : "not found"} (${deps.configPath})`);
  if (!server.valid)
    lines.push("  config content:     not valid JSON, so nothing can be read from it");
  lines.push(`  "${deps.serverName}" entry:   ${server.entryPresent ? "present" : "absent"}`);
  lines.push(
    `  ${SERVER_SWITCH}:       ${
      server.state === "on"
        ? "set (on)"
        : server.state === "other"
          ? "set, but not to on (the server treats it as off)"
          : "not set"
    }`,
  );
  lines.push("");
  lines.push(`Switch 2, game side: user environment variable ${GAME_SWITCH}`);
  lines.push(
    `  ${gameVarError ? `could not be read: ${gameVarError}` : describeGameVar(gameVar, marker)}`,
  );
  const script = marker?.session?.script;
  if (script) {
    lines.push(
      `  session launcher:   ${deps.fileExists(script) ? "generated" : "recorded but the file is gone"} (${script})`,
    );
  }
  lines.push("");
  const port = await deps.probe(TELEMETRY_PORT);
  lines.push(
    `Port 127.0.0.1:${TELEMETRY_PORT}: ${port === "open" ? "open (something is listening)" : "closed"}`,
  );
  lines.push("  This is a plain TCP connection test; nothing is read from or sent to the game.");
  lines.push(...nextStep(server, gameVar, port));
  lines.push("", LAUNCHER_REMINDER);
  return { code: 0, lines };
}

function nextStep(
  server: { entryPresent: boolean; state: ServerSwitchState },
  gameVar: GameVarState,
  port: PortState,
): string[] {
  const serverOn = server.state === "on";
  const gameOn = gameVar === "true";
  if (!serverOn && !gameOn)
    return ["", "Both switches are off (the default). To turn it on: npm run telemetry -- enable"];
  if (!server.entryPresent)
    return ["", `The server entry is missing: run npm run install:claude first.`];
  if (serverOn && !gameOn)
    return [
      "",
      "Only the server side is on. Set the game side too: npm run telemetry -- enable (add --apply).",
    ];
  if (!serverOn && gameOn)
    return [
      "",
      "Only the game side is on. Switch the server side on too: npm run telemetry -- enable (add --apply).",
    ];
  if (port === "closed")
    return [
      "",
      "Both switches are on but the port is closed: the game is not running, or the launcher was not restarted since the variable was set.",
    ];
  return [
    "",
    "Both switches are on and the port is open. Ask Claude for sc_live_status to see whether frames arrive.",
  ];
}

// ---------------------------------------------------------------------------------------------------------
// enable

export interface EnableOptions {
  apply: boolean;
  session: boolean;
  launcher?: string;
}

const manualInstructions = (action: "enable" | "disable"): string[] =>
  action === "enable"
    ? [
        "This platform is not Windows, so nothing was written. Manual steps (NOT TESTED):",
        `  1. In the env of the "sc-copilot" entry of your MCP client config, add ${SERVER_SWITCH}=on.`,
        `  2. Lutris: add the environment variable ${GAME_SWITCH}=true in the game's configuration (Runner options / System options).`,
        `     Steam: set the launch options to  ${GAME_SWITCH}=true %command%`,
        "  Then start the game again.",
      ]
    : [
        "This platform is not Windows, so nothing was written. Manual steps (NOT TESTED):",
        `  1. Remove ${SERVER_SWITCH} from the env of the "sc-copilot" entry of your MCP client config.`,
        `  2. Remove ${GAME_SWITCH}=true from the Lutris game configuration, or from the Steam launch options.`,
      ];

export async function enableCommand(deps: SwitchDeps, opts: EnableOptions): Promise<SwitchResult> {
  const lines: string[] = [`Live telemetry: enable${opts.session ? " (session only)" : ""}`, ""];
  const fail = (message: string): SwitchResult => ({ code: 1, lines: [...lines, message] });

  lines.push(...TELEMETRY_WARNING, "");
  if (deps.platform !== "win32" || !deps.store) {
    lines.push(...manualInstructions("enable"));
    return { code: 0, lines };
  }

  // Everything that can be refused is checked before the first write.
  const config = readConfigFile(deps.configPath);
  let configPlan: EnvKeyPlan;
  try {
    configPlan = planEnvKey(config.raw, deps.serverName, SERVER_SWITCH, "on");
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }
  if (configPlan.action === "no_entry") {
    return fail(
      `${config.exists ? `The "${deps.serverName}" server is not in the Claude Desktop config` : `The Claude Desktop config does not exist (${deps.configPath})`}: no entry is invented. Run: npm run install:claude (then --apply), then try again. Nothing was written.`,
    );
  }

  let gameVar: GameVarState;
  try {
    gameVar = await readGameVar(deps);
  } catch (error) {
    return fail(`${(error as Error).message} Nothing was written.`);
  }

  let launcher: string | null = null;
  if (opts.session) {
    const found = resolveLauncher(deps, opts.launcher);
    if (typeof found !== "string") return fail(found.error);
    launcher = found;
  }

  const marker = readMarker(deps.markerDir) ?? emptyMarker();
  const scriptPath = path.join(deps.markerDir, SESSION_SCRIPT);

  // The plan, as a diff without any secret.
  lines.push(opts.apply ? "Doing:" : "Would do (dry run):");
  let gameStep: "set" | "keep" | "foreign" | "session" = "keep";
  if (opts.session) {
    gameStep = "session";
    lines.push(
      `  1. Game side: NOT touching the user environment. Generate ${scriptPath}, which sets ${GAME_SWITCH}=true for the launcher it starts only.`,
      `     Launcher: ${launcher}`,
    );
    if (gameVar === "true")
      lines.push(
        `     Note: ${GAME_SWITCH}=true is already set permanently, so a session launcher adds nothing.`,
      );
  } else if (gameVar === "unset") {
    gameStep = "set";
    lines.push(
      `  1. Game side: set the USER environment variable ${GAME_SWITCH}=true (PowerShell, [Environment]::SetEnvironmentVariable).`,
    );
  } else if (gameVar === "true") {
    lines.push(`  1. Game side: ${GAME_SWITCH}=true is already set. Nothing to do.`);
  } else {
    gameStep = "foreign";
    lines.push(
      `  1. Game side: ${GAME_SWITCH} is already set to another value. It is NOT changed: set it to true yourself if that is what you want.`,
    );
  }
  lines.push(
    `  2. ${describeEnvKeyPlan(configPlan, deps.serverName, "on").split("\n").join("\n     ")}`,
  );
  if (opts.session)
    lines.push(
      `     (${SERVER_SWITCH}=on stays set in the config even in session mode: it is the server switch.)`,
    );

  if (!opts.apply) {
    lines.push(
      "",
      "Dry run: nothing was written. Re-run with --apply to do it.",
      "",
      LAUNCHER_REMINDER,
    );
    return { code: 0, lines };
  }

  // Apply. The marker is updated after each step, so an interruption leaves an accurate trace.
  const done: string[] = [];
  if (gameStep === "set") {
    await deps.store.set(GAME_SWITCH, "true");
    marker.gameVar = { origin: "tool" };
    writeMarker(deps, marker);
    done.push(`Set the user variable ${GAME_SWITCH}=true.`);
  } else if (!opts.session && gameVar === "true") {
    // Present already. If we set it on an earlier run the marker keeps saying so; otherwise it is a hand-set one.
    if (marker.gameVar?.origin !== "tool") {
      marker.gameVar = { origin: "manual" };
      writeMarker(deps, marker);
    }
    done.push(
      `${GAME_SWITCH}=true was already set (${marker.gameVar?.origin === "tool" ? "by this tool" : "by hand"}).`,
    );
  } else if (gameStep === "foreign") {
    done.push(`${GAME_SWITCH} left as it is (another value).`);
  }

  if (opts.session && launcher) {
    fs.mkdirSync(deps.markerDir, { recursive: true });
    writeAtomic(scriptPath, sessionScript(launcher));
    marker.session = { script: scriptPath, launcher };
    writeMarker(deps, marker);
    done.push(`Wrote the session launcher: ${scriptPath}`);
  }

  if (configPlan.merged) {
    const backup = writeConfigWithBackup(deps, config, configPlan.merged);
    marker.config = { path: deps.configPath, backup: backup ?? marker.config?.backup ?? null };
    writeMarker(deps, marker);
    done.push(
      `Set ${SERVER_SWITCH}=on in the "${deps.serverName}" entry.${backup ? ` Backup: ${backup}` : ""}`,
    );
  } else {
    done.push(
      `${SERVER_SWITCH}=on was already set in the "${deps.serverName}" entry. No backup, nothing written.`,
    );
    if (!marker.config) {
      marker.config = { path: deps.configPath, backup: null };
      writeMarker(deps, marker);
    }
  }

  lines.push("", ...done);
  lines.push(
    "",
    opts.session
      ? `Start the game through ${scriptPath} (quit the RSI Launcher completely first, tray icon included). A launcher that is already open cancels the effect.`
      : LAUNCHER_REMINDER,
    "Restart Claude Desktop so that the server picks up SC_TELEMETRY.",
    `Undo with: npm run telemetry -- disable --apply`,
  );
  return { code: 0, lines };
}

function writeConfigWithBackup(
  deps: SwitchDeps,
  current: ConfigFacts,
  merged: Record<string, unknown>,
): string | null {
  let backup: string | null = null;
  if (current.exists) {
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    backup = `${deps.configPath}.bak-${stamp}`;
    fs.copyFileSync(deps.configPath, backup);
  }
  writeAtomic(deps.configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return backup;
}

// ---------------------------------------------------------------------------------------------------------
// session launcher

/** Where the RSI Launcher is installed by default, from the usual environment variables. */
export function launcherCandidatesFromEnv(env: Record<string, string | undefined>): string[] {
  const suffix = ["Roberts Space Industries", "RSI Launcher", "RSI Launcher.exe"];
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter((r): r is string => !!r);
  const out = roots.map((r) => path.win32.join(r, ...suffix));
  if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, "Programs", ...suffix));
  return out;
}

function resolveLauncher(deps: SwitchDeps, given: string | undefined): string | { error: string } {
  if (given !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (/["%\u0000-\u001f]/.test(given))
      return {
        error:
          'The --launcher path contains a character that is not allowed in the generated launcher (", % or a control character).',
      };
    if (!deps.fileExists(given)) return { error: `The --launcher path does not exist: ${given}` };
    return given;
  }
  const found = deps.launcherCandidates.find((c) => deps.fileExists(c));
  if (!found)
    return {
      error:
        'The RSI Launcher was not found in its standard places. Give its path: npm run telemetry -- enable --session --launcher "C:\\path\\to\\RSI Launcher.exe"',
    };
  return found;
}

function sessionScript(launcher: string): string {
  return [
    "@echo off",
    'rem Generated by "npm run telemetry -- enable --session". Remove it with: npm run telemetry -- disable --apply',
    "rem Sets the game's telemetry switch for the RSI Launcher started below, and for nothing else.",
    "rem If the launcher is already open (tray icon included), quit it completely first, or this has no effect.",
    `set "${GAME_SWITCH}=true"`,
    `start "" "${launcher}"`,
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------------------------------------
// disable

export async function disableCommand(
  deps: SwitchDeps,
  opts: { apply: boolean },
): Promise<SwitchResult> {
  const lines: string[] = ["Live telemetry: disable", ""];
  const fail = (message: string): SwitchResult => ({ code: 1, lines: [...lines, message] });
  if (deps.platform !== "win32" || !deps.store) {
    lines.push(...manualInstructions("disable"));
    return { code: 0, lines };
  }

  const config = readConfigFile(deps.configPath);
  let configPlan: EnvKeyPlan;
  try {
    configPlan = planEnvKey(config.raw, deps.serverName, SERVER_SWITCH, null);
  } catch (error) {
    if (error instanceof ConfigError) return fail(`${error.message} Nothing was changed.`);
    throw error;
  }
  let gameVar: GameVarState;
  try {
    gameVar = await readGameVar(deps);
  } catch (error) {
    return fail(`${(error as Error).message} Nothing was changed.`);
  }

  const marker = readMarker(deps.markerDir);
  const ours = marker?.gameVar?.origin === "tool";
  const removeVar = ours && gameVar === "true";
  const script = marker?.session?.script ?? null;
  const removeScript = script !== null && deps.fileExists(script);

  lines.push(opts.apply ? "Doing:" : "Would do (dry run):");
  const kept: string[] = [];
  let anything = false;

  if (removeVar) {
    anything = true;
    lines.push(`  - Remove the user variable ${GAME_SWITCH} (this tool set it).`);
  } else if (gameVar === "true" || gameVar === "other") {
    kept.push(
      `${GAME_SWITCH} is set but this tool did not set it${ours ? " (its value was changed since)" : ""}, so it is KEPT.`,
      `  To remove it yourself: PowerShell  [Environment]::SetEnvironmentVariable('${GAME_SWITCH}', $null, 'User')`,
      "  or Windows Settings > System > About > Advanced system settings > Environment Variables > User variables.",
    );
  } else {
    lines.push(`  - ${GAME_SWITCH}: not set. Nothing to do.`);
  }

  if (configPlan.action === "remove") {
    anything = true;
    lines.push(
      `  - ${describeEnvKeyPlan(configPlan, deps.serverName, null).split("\n").join("\n    ")}`,
    );
  } else if (configPlan.action === "no_entry") {
    lines.push(
      `  - The "${deps.serverName}" entry is not in the config (or the file is missing): nothing to remove there.`,
    );
  } else {
    lines.push(`  - ${SERVER_SWITCH} is not in the "${deps.serverName}" entry. Nothing to do.`);
  }

  if (removeScript) {
    anything = true;
    lines.push(`  - Delete the session launcher this tool generated: ${script}`);
  }
  if (marker) anything = true;

  if (!opts.apply) {
    lines.push(...(kept.length ? ["", ...kept] : []));
    lines.push(
      "",
      anything ? "Dry run: nothing was changed. Re-run with --apply to do it." : "Nothing to do.",
    );
    return { code: 0, lines };
  }

  const done: string[] = [];
  if (configPlan.merged) {
    const backup = writeConfigWithBackup(deps, config, configPlan.merged);
    done.push(
      `Removed ${SERVER_SWITCH} from the "${deps.serverName}" entry.${backup ? ` Backup: ${backup}` : ""}`,
    );
  }
  if (removeVar) {
    await deps.store.remove(GAME_SWITCH);
    done.push(`Removed the user variable ${GAME_SWITCH}.`);
  }
  if (removeScript && script) {
    fs.rmSync(script, { force: true });
    done.push(`Deleted ${script}`);
  }
  if (marker) deleteMarker(deps.markerDir);

  lines.push(
    "",
    ...(done.length ? done : ["Nothing to change."]),
    ...(kept.length ? ["", ...kept] : []),
  );
  if (done.length)
    lines.push("", "Restart Claude Desktop. " + (removeVar ? LAUNCHER_REMINDER : ""));
  return { code: 0, lines };
}
