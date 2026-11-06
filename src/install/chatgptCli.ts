/**
 * `npm run chatgpt -- <command>`: use this server from ChatGPT through OpenAI's Secure MCP Tunnel (tunnel-client).
 *
 *   setup --tunnel-id tunnel_... [--port 8080] [--dry-run]   download the pinned tunnel-client, write the profile
 *   key [--remove]                                            save (or delete) the runtime API key, never shown
 *   start [--telemetry on|off] [--balance shown|hidden] [--profiles list] [--dry-run]   run the tunnel (alias: run)
 *   doctor                                                    our checks, then tunnel-client doctor --explain
 *   status                                                    what is installed, and whether the tunnel is up
 *
 * Every machine effect goes through `CliDeps`, so tests run it on temporary folders with a fake download, a fake
 * prompt and a fake process. Nothing here prints, logs or writes the key anywhere but its own file.
 */
import fs from "node:fs";
import path from "node:path";
import {
  TUNNEL_CLIENT_VERSION,
  binaryName,
  chatgptFormLines,
  checkApiKey,
  checkPort,
  checkTunnelId,
  childEnv,
  PathError,
  renderProfile,
  requiredFiles,
  selectAsset,
  type StartOptions,
  type TunnelAsset,
} from "./chatgptTunnel.js";
import type { PortProbe } from "./portProbe.js";
import { sha256, verifyArchive } from "./tunnelDownload.js";
import { readZip } from "./zipReader.js";

export type Command = "setup" | "key" | "start" | "doctor" | "status" | "help";

export interface ParsedArgs {
  command: Command;
  dryRun: boolean;
  tunnelId?: string;
  port?: number;
  remove: boolean;
  telemetry?: "on" | "off";
  balance?: "shown" | "hidden";
  profiles?: string;
  verbose: boolean;
}

export const USAGE = [
  "Usage: npm run chatgpt -- <command> [options]",
  "  setup --tunnel-id tunnel_...  download OpenAI's tunnel-client (pinned version, checked) and write its profile",
  "        [--port 8080]           the local status port (default 8080)",
  "        [--dry-run]             show what would be downloaded and written, change nothing",
  "  key                           save the runtime API key (paste it; nothing is shown)",
  "  key --remove                  delete the saved key",
  "  start                         run the tunnel; keep the window open, Ctrl+C stops it (alias: run)",
  "        [--telemetry on|off]    live telemetry for this run (SC_TELEMETRY)",
  "        [--balance shown|hidden] the aUEC balance for this run (SC_BALANCE)",
  "        [--profiles <list>]     tool profiles (SCMCP_PROFILES, default core,trade,data,local)",
  "        [--verbose]             tunnel-client's informational log too (default: warnings and errors only)",
  "        [--dry-run]             show the command and the settings, start nothing",
  "  doctor                        check everything, then run tunnel-client doctor --explain",
  "  status                        what is installed and whether the tunnel is running",
  "Guide: docs/CHATGPT.md (French: docs/CHATGPT.fr.md)",
];

const OPTIONS: Record<Command, string[]> = {
  setup: ["--tunnel-id", "--port", "--dry-run"],
  key: ["--remove"],
  start: ["--telemetry", "--balance", "--profiles", "--verbose", "--dry-run"],
  doctor: [],
  status: [],
  help: [],
};

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const [first, ...rest] = argv;
  const command: Command | null =
    first === undefined || first === "help" || first === "--help" || first === "-h"
      ? "help"
      : first === "run"
        ? "start"
        : ((["setup", "key", "start", "doctor", "status"] as const).find((c) => c === first) ??
          null);
  if (!command) return { error: `Unknown command: ${first}` };
  const out: ParsedArgs = { command, dryRun: false, remove: false, verbose: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!OPTIONS[command].includes(arg))
      return { error: `${command} takes no option ${arg}. See: npm run chatgpt -- help` };
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--remove") {
      out.remove = true;
      continue;
    }
    if (arg === "--verbose") {
      out.verbose = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value.` };
    if (arg === "--tunnel-id") {
      const id = checkTunnelId(value);
      if ("error" in id) return { error: id.error };
      out.tunnelId = id.id;
    } else if (arg === "--port") {
      const p = checkPort(value);
      if ("error" in p) return { error: p.error };
      out.port = p.port;
    } else if (arg === "--telemetry") {
      if (value !== "on" && value !== "off") return { error: "--telemetry takes on or off." };
      out.telemetry = value;
    } else if (arg === "--balance") {
      if (value !== "shown" && value !== "hidden")
        return { error: "--balance takes shown or hidden." };
      out.balance = value;
    } else if (arg === "--profiles") {
      const list = value.trim().toLowerCase();
      if (!/^[a-z]+(,[a-z]+)*$/.test(list))
        return { error: "--profiles takes names separated by commas, e.g. core,trade" };
      out.profiles = list;
    }
  }
  return out;
}

export interface CliDeps {
  platform: string;
  arch: string;
  /** The per-user folder of the bridge (`userChatGptDir()`). */
  home: string;
  /** This checkout (where dist/index.js is). */
  repoRoot: string;
  /** `process.execPath`. */
  nodePath: string;
  env: Record<string, string | undefined>;
  pid: number;
  download(asset: TunnelAsset): Promise<Buffer>;
  /**
   * Tests only: the archive to expect instead of the pinned one of this machine (so that a hand-made archive can
   * pass the size and SHA-256 check). The script never sets it.
   */
  asset?: TunnelAsset | null;
  readSecret(prompt: string): Promise<string>;
  probe: PortProbe;
  isAlive(pid: number): boolean;
  /** Runs a program with the terminal attached and resolves its exit code. */
  exec(file: string, args: string[], env: Record<string, string>): Promise<number>;
  now(): Date;
  out(line: string): void;
}

export interface Layout {
  home: string;
  binDir: string;
  binary: string;
  profile: string;
  keyFile: string;
  state: string;
  lock: string;
}

export function layout(home: string, platform: string): Layout {
  const binDir = path.join(home, "tunnel-client", `v${TUNNEL_CLIENT_VERSION}`);
  return {
    home,
    binDir,
    binary: path.join(binDir, binaryName(platform)),
    profile: path.join(home, "profile.yaml"),
    keyFile: path.join(home, "control-plane-api-key"),
    state: path.join(home, "state.json"),
    lock: path.join(home, "run.lock"),
  };
}

export interface BridgeState {
  version: 1;
  tunnelClientVersion: string;
  binarySha256: string;
  tunnelId: string;
  port: number;
  entry: string;
  node: string;
  writtenAt: string;
}

export const DEFAULT_PORT = 8080;

function readState(file: string): BridgeState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeState;
    if (s && s.version === 1 && typeof s.tunnelId === "string" && typeof s.port === "number")
      return s;
  } catch {
    // absent or unreadable: treated as not set up
  }
  return null;
}

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
function writeAtomic(file: string, data: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/**
 * MEASURED on Node 24.8 (Windows): fs.rmSync silently does nothing on a path with a non-ASCII character (a user
 * folder such as C:\Users\José), while unlinkSync and rmdirSync work. So removals go through these two.
 */
export function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function removeTree(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
  } else fs.unlinkSync(target);
}

function fileSha(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

interface LockInfo {
  pid: number;
  tunnelId: string;
  startedAt: string;
}

function readLock(file: string): LockInfo | null {
  try {
    const l = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
    return typeof l.pid === "number" ? l : null;
  } catch {
    return null;
  }
}

/** The pid of a launcher that is still running, or null (a stale lock is not a running tunnel). */
function runningPid(deps: CliDeps, lay: Layout): number | null {
  const lock = readLock(lay.lock);
  return lock && lock.pid !== deps.pid && deps.isAlive(lock.pid) ? lock.pid : null;
}

const BUILD_HINT =
  "Run npm run build in this folder first. If Claude Desktop runs this server from this same folder, quit it " +
  "before building (its server runs from dist/).";

export async function runChatgpt(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const lay = layout(deps.home, deps.platform);
  switch (args.command) {
    case "help":
      USAGE.forEach((l) => deps.out(l));
      return 0;
    case "setup":
      return setup(args, deps, lay);
    case "key":
      return key(args, deps, lay);
    case "start":
      return start(args, deps, lay);
    case "doctor":
      return doctor(deps, lay);
    case "status":
      return status(deps, lay);
  }
}

// ---------------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------------

async function setup(args: ParsedArgs, deps: CliDeps, lay: Layout): Promise<number> {
  const out = deps.out;
  const previous = readState(lay.state);
  const tunnelId = args.tunnelId ?? previous?.tunnelId;
  if (!tunnelId) {
    out("setup needs your tunnel ID: npm run chatgpt -- setup --tunnel-id tunnel_...");
    out(
      "Create one at https://platform.openai.com/settings/organization/tunnels (see docs/CHATGPT.md).",
    );
    return 2;
  }
  const entry = path.join(deps.repoRoot, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    out(`dist/index.js is missing in ${deps.repoRoot}. ${BUILD_HINT}`);
    return 1;
  }
  const asset = deps.asset !== undefined ? deps.asset : selectAsset(deps.platform, deps.arch);
  if (!asset) {
    out(
      `OpenAI publishes no tunnel-client ${TUNNEL_CLIENT_VERSION} for ${deps.platform}/${deps.arch}. ` +
        "Supported: Windows, Linux and macOS on x64 or arm64.",
    );
    return 1;
  }
  const port = args.port ?? previous?.port ?? DEFAULT_PORT;
  const dry = args.dryRun;

  let profileText: string;
  try {
    profileText = renderProfile({
      tunnelId,
      nodePath: deps.nodePath,
      entryPath: entry,
      keyFile: lay.keyFile,
      port,
      platform: deps.platform,
    });
  } catch (error) {
    if (error instanceof PathError) {
      out(error.message);
      return 1;
    }
    throw error;
  }

  const running = runningPid(deps, lay);
  const recorded = previous?.tunnelClientVersion === TUNNEL_CLIENT_VERSION;
  const currentSha = recorded ? fileSha(lay.binary) : null;
  let binarySha = previous?.binarySha256 ?? "";
  if (recorded && currentSha !== null && currentSha === previous?.binarySha256) {
    out(`tunnel-client ${TUNNEL_CLIENT_VERSION} is already installed and unchanged: ${lay.binDir}`);
  } else if (dry) {
    out(`Would download tunnel-client ${TUNNEL_CLIENT_VERSION} (OpenAI, Apache-2.0):`);
    out(`  ${asset.url}`);
    out(
      `  ${asset.size} bytes, SHA-256 ${asset.sha256} (pinned in this project, checked before anything is extracted)`,
    );
    out(`  into ${lay.binDir}`);
  } else {
    if (running !== null) {
      out(
        `A tunnel started by this command is running (process ${running}). Stop it (Ctrl+C in its window), then run setup again.`,
      );
      return 1;
    }
    out(`Downloading tunnel-client ${TUNNEL_CLIENT_VERSION} from ${asset.url} ...`);
    let files;
    try {
      const data = await deps.download(asset);
      verifyArchive(asset, data);
      files = readZip(data);
    } catch (error) {
      out((error as Error).message);
      out("Nothing was installed.");
      return 1;
    }
    const names = new Set(files.map((f) => f.name));
    const missing = requiredFiles(deps.platform).filter((n) => !names.has(n));
    if (missing.length > 0) {
      out(`The archive lacks ${missing.join(", ")}. Nothing was installed.`);
      return 1;
    }
    out(`SHA-256 checked: ${asset.sha256}`);
    const partial = `${lay.binDir}.partial-${deps.pid}`;
    try {
      removeTree(partial);
      fs.mkdirSync(partial, { recursive: true });
      for (const f of files) {
        const executable =
          deps.platform !== "win32" && /^(tunnel-client|cloudflared)$/.test(f.name);
        fs.writeFileSync(path.join(partial, f.name), f.data, { mode: executable ? 0o755 : 0o644 });
      }
      removeTree(lay.binDir);
      fs.renameSync(partial, lay.binDir);
    } catch (error) {
      removeTree(partial);
      out(`Could not install into ${lay.binDir}: ${(error as Error).message}`);
      out("If a tunnel-client is running from that folder, stop it and run setup again.");
      return 1;
    }
    binarySha = sha256(files.find((f) => f.name === binaryName(deps.platform))!.data);
    out(`Installed: ${lay.binary}`);
  }

  if (dry) {
    out(`Would write the profile ${lay.profile}:`);
    profileText
      .trimEnd()
      .split("\n")
      .forEach((l) => out(`  | ${l}`));
    out(`Would record the setup in ${lay.state}.`);
    out(
      "Dry run: nothing was downloaded or written. Run the same command without --dry-run to do it.",
    );
    return 0;
  }

  writeAtomic(lay.profile, profileText);
  const state: BridgeState = {
    version: 1,
    tunnelClientVersion: TUNNEL_CLIENT_VERSION,
    binarySha256: binarySha,
    tunnelId,
    port,
    entry,
    node: deps.nodePath,
    writtenAt: deps.now().toISOString(),
  };
  writeAtomic(lay.state, JSON.stringify(state, null, 2) + "\n");
  if (previous && previous.tunnelId !== tunnelId)
    out(`Profile written for the new tunnel ID (it replaces ${previous.tunnelId}): ${lay.profile}`);
  else out(`Profile written: ${lay.profile}`);
  out(`It starts this server with ${deps.nodePath} and ${entry}.`);
  if (running !== null)
    out(`A tunnel is running (process ${running}): restart it to use this profile.`);
  out("");
  out("Next:");
  if (!fs.existsSync(lay.keyFile))
    out("  1. npm run chatgpt -- key      (paste the runtime API key; nothing is shown)");
  else out("  1. Runtime key: present (npm run chatgpt -- key replaces it).");
  out("  2. npm run chatgpt -- start    (keep that window open)");
  out("  3. Then, while it runs:");
  chatgptFormLines(tunnelId).forEach((l) => out(`     ${l}`));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------------------------

async function key(args: ParsedArgs, deps: CliDeps, lay: Layout): Promise<number> {
  const out = deps.out;
  if (args.remove) {
    if (!fs.existsSync(lay.keyFile)) {
      out("No saved key.");
      return 0;
    }
    removeFile(lay.keyFile);
    out(`Key file deleted: ${lay.keyFile}`);
    out(
      "If you no longer use that key, revoke it too: https://platform.openai.com/settings/organization/api-keys",
    );
    return 0;
  }
  out(
    "Paste the runtime API key (Platform > API keys, Restricted: Tunnels Read + Use), then press Enter.",
  );
  out("Nothing is shown while you paste. Ctrl+C cancels.");
  let raw: string;
  try {
    raw = await deps.readSecret("Key: ");
  } catch (error) {
    out((error as Error).message);
    return 1;
  }
  const checked = checkApiKey(raw);
  if ("error" in checked) {
    out(`${checked.error} Nothing was saved.`);
    return 1;
  }
  if (checked.warning) out(`Warning: ${checked.warning}`);
  writeAtomic(lay.keyFile, checked.key, 0o600);
  out(`Key saved in ${lay.keyFile} (never printed, never in the profile or in this repository).`);
  out("Like any file of your user folder, programs running under your account can read it.");
  if (runningPid(deps, lay) !== null) out("A tunnel is running: restart it to use the new key.");
  else out("Next: npm run chatgpt -- start");
  return 0;
}

// ---------------------------------------------------------------------------------------------
// start, doctor, status
// ---------------------------------------------------------------------------------------------

interface Ready {
  state: BridgeState;
  problems: string[];
}

/** Everything start needs, as a list of problems with their fix. Read-only. */
function readiness(deps: CliDeps, lay: Layout): Ready | null {
  const state = readState(lay.state);
  if (!state) return null;
  const problems: string[] = [];
  if (!fs.existsSync(lay.profile))
    problems.push(`The profile is missing (${lay.profile}): run setup again.`);
  const sha = fileSha(lay.binary);
  if (state.tunnelClientVersion !== TUNNEL_CLIENT_VERSION || sha === null)
    problems.push(`tunnel-client ${TUNNEL_CLIENT_VERSION} is not installed: run setup again.`);
  else if (sha !== state.binarySha256)
    problems.push(
      `${lay.binary} is not the file setup checked (it changed on disk): run setup again to reinstall it.`,
    );
  if (!fs.existsSync(state.entry))
    problems.push(`The server is missing (${state.entry}). ${BUILD_HINT} Then run setup again.`);
  if (!fs.existsSync(state.node))
    problems.push(`Node.js moved (${state.node} is gone): run setup again.`);
  if (!fs.existsSync(lay.keyFile)) problems.push("No runtime key yet: npm run chatgpt -- key");
  return { state, problems };
}

const NOT_SET_UP = "Not set up yet: npm run chatgpt -- setup --tunnel-id tunnel_...";

async function start(args: ParsedArgs, deps: CliDeps, lay: Layout): Promise<number> {
  const out = deps.out;
  const ready = readiness(deps, lay);
  if (!ready) {
    out(NOT_SET_UP);
    return 1;
  }
  const { state, problems } = ready;
  if (problems.length > 0) {
    problems.forEach((p) => out(p));
    return 1;
  }
  out("Runtime key: present.");
  const other = runningPid(deps, lay);
  if (other !== null) {
    out(
      `A tunnel started by this command is already running (process ${other}). Keep only one per tunnel ID: ` +
        `use that window, or stop it with Ctrl+C. If none is running, delete ${lay.lock}.`,
    );
    return 1;
  }
  if ((await deps.probe(state.port)) === "open") {
    out(
      `Something already listens on 127.0.0.1:${state.port}: probably a tunnel-client still running ` +
        `(look at 127.0.0.1:${state.port}/ui in a browser), or another program. Stop it, or pick another port: ` +
        "npm run chatgpt -- setup --port 8090",
    );
    return 1;
  }
  const options: StartOptions = {
    telemetry: args.telemetry,
    balance: args.balance,
    profiles: args.profiles,
  };
  const child = childEnv(deps.env, options);
  if (child.removed.length > 0)
    out(
      `Not passed on (they would override the profile or reach the server): ${child.removed.join(", ")}`,
    );
  if (child.set.length > 0) out(`Server settings for this run: ${child.set.join(", ")}`);
  const balanceShown = (child.env.SC_BALANCE ?? "").trim().toLowerCase() !== "hidden";
  if (balanceShown)
    out(
      "The aUEC balance is shown by default and so reaches ChatGPT with the tool results. To hide it: --balance hidden",
    );
  chatgptFormLines(state.tunnelId).forEach((l) => out(l));
  out(
    `Local status page: 127.0.0.1:${state.port}/ui (in a browser). Keep this window open; Ctrl+C stops the tunnel.`,
  );
  const runArgs = [
    "run",
    "--config",
    lay.profile,
    ...(args.verbose ? ["--log.level", "info"] : []),
  ];
  if (args.dryRun) {
    out(
      `Would run: "${lay.binary}" ${runArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
    );
    out("Dry run: nothing was started.");
    return 0;
  }
  const acquire = (): number | null => {
    try {
      return fs.openSync(lay.lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
  };
  let fd = acquire();
  if (fd === null) {
    // runningPid said above that no live launcher holds it: a stale lock from a crash or a closed window.
    removeFile(lay.lock);
    fd = acquire();
  }
  if (fd === null) {
    out(`Another start is in progress (${lay.lock}). Try again in a moment.`);
    return 1;
  }
  const lock: LockInfo = {
    pid: deps.pid,
    tunnelId: state.tunnelId,
    startedAt: deps.now().toISOString(),
  };
  fs.writeSync(fd, JSON.stringify(lock));
  fs.closeSync(fd);
  try {
    out(
      "The window stays quiet while all is well; warnings and errors appear here. Check with: npm run chatgpt -- status",
    );
    const code = await deps.exec(lay.binary, runArgs, child.env);
    out(`tunnel-client stopped (exit code ${code}).`);
    return code;
  } finally {
    if (readLock(lay.lock)?.pid === deps.pid) removeFile(lay.lock);
  }
}

async function doctor(deps: CliDeps, lay: Layout): Promise<number> {
  const out = deps.out;
  const ready = readiness(deps, lay);
  if (!ready) {
    out(`FAIL  ${NOT_SET_UP}`);
    return 1;
  }
  const { state, problems } = ready;
  out(`OK    setup recorded: tunnel ${state.tunnelId}, port ${state.port}`);
  problems.forEach((p) => out(`FAIL  ${p}`));
  const running = runningPid(deps, lay);
  out(
    running !== null
      ? `INFO  a tunnel started by this command is running (process ${running})`
      : "INFO  no tunnel started by this command is running",
  );
  if (problems.length > 0) {
    out("Fix the FAIL lines above, then run doctor again.");
    return 1;
  }
  out(
    "OK    tunnel-client, profile, server and runtime key are in place. tunnel-client's own check follows:",
  );
  out("");
  const child = childEnv(deps.env, {});
  return deps.exec(lay.binary, ["doctor", "--config", lay.profile, "--explain"], child.env);
}

async function status(deps: CliDeps, lay: Layout): Promise<number> {
  const out = deps.out;
  const state = readState(lay.state);
  if (!state) {
    out(NOT_SET_UP);
    return 1;
  }
  out(`tunnel-client: ${state.tunnelClientVersion} in ${lay.binDir}`);
  out(`Tunnel ID:     ${state.tunnelId}`);
  out(`Profile:       ${lay.profile}`);
  out(
    `Runtime key:   ${fs.existsSync(lay.keyFile) ? "present" : "absent (npm run chatgpt -- key)"}`,
  );
  const running = runningPid(deps, lay);
  out(`Started here:  ${running !== null ? `yes, process ${running}` : "no"}`);
  const port = await deps.probe(state.port);
  if (port === "closed") {
    out(
      `Status port 127.0.0.1:${state.port}: nothing listens, the tunnel is not running (npm run chatgpt -- start).`,
    );
    return 0;
  }
  out(`Status port 127.0.0.1:${state.port}: open. tunnel-client health says:`);
  // "ready" alone only means the local side is up (MEASURED: it passes with OpenAI unreachable); one successful poll of
  // OpenAI's control plane is what says the tunnel really works.
  const code = await deps.exec(
    lay.binary,
    ["health", "--port", String(state.port), "--require-control-plane-poll"],
    childEnv(deps.env, {}).env,
  );
  if (code !== 0)
    out(
      "No successful contact with OpenAI yet (give it a few seconds after start). If it lasts: check the runtime key " +
        "(Tunnels Read + Use), the tunnel ID and the connection; the tunnel window shows the error.",
    );
  else chatgptFormLines(state.tunnelId).forEach((l) => out(l));
  return code;
}
