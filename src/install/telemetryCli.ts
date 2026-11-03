import {
  disableCommand,
  enableCommand,
  statusCommand,
  type SwitchDeps,
  type SwitchResult,
} from "./telemetrySwitch.js";

export interface ParsedArgs {
  command: "status" | "enable" | "disable";
  apply: boolean;
  session: boolean;
  launcher?: string;
  config?: string;
}

export const USAGE = [
  "Usage: npm run telemetry -- <command> [options]",
  "  status                       show both switches and the port (read-only)",
  "  enable [--apply]             turn live telemetry on; a dry run unless --apply",
  "  disable [--apply]            turn it off, removing only what this tool set",
  "Options:",
  "  --session                    (enable) do not touch the user environment: generate a launcher script instead",
  "  --launcher <path>            (enable --session) path of RSI Launcher.exe if it is not in its standard place",
  "  --config <path>              the claude_desktop_config.json to use (tests, unusual installs)",
];

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "enable" && command !== "disable")
    return { error: command ? `Unknown command: ${command}` : "No command given." };
  const out: ParsedArgs = { command, apply: false, session: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--session") out.session = true;
    else if (arg === "--launcher" || arg === "--config") {
      const value = rest[++i];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a path.` };
      if (arg === "--launcher") out.launcher = value;
      else out.config = value;
    } else return { error: `Unknown option: ${arg}` };
  }
  if (command === "status" && (out.apply || out.session || out.launcher))
    return { error: "status takes no --apply, --session or --launcher: it never writes." };
  if (command === "disable" && (out.session || out.launcher))
    return { error: "disable takes no --session or --launcher." };
  if (out.launcher && !out.session) return { error: "--launcher only makes sense with --session." };
  return out;
}

export async function runTelemetry(args: ParsedArgs, deps: SwitchDeps): Promise<SwitchResult> {
  switch (args.command) {
    case "status":
      return statusCommand(deps);
    case "enable":
      return enableCommand(deps, {
        apply: args.apply,
        session: args.session,
        launcher: args.launcher,
      });
    case "disable":
      return disableCommand(deps, { apply: args.apply });
  }
}
