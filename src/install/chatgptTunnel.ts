/**
 * The pure part of `npm run chatgpt`: the pinned tunnel-client release, the checks on what the user types, the
 * profile written for tunnel-client and the environment handed to it. No file system, no network, no process:
 * `chatgptCli.ts` does the I/O and `scripts/chatgpt-tunnel.mjs` wires the real machine in.
 *
 * tunnel-client is OpenAI's program (Apache-2.0, github.com/openai/tunnel-client). It runs on the player's PC,
 * opens an outbound connection to OpenAI and starts this server as its stdio child, so that ChatGPT can call the
 * tools. The server itself is unchanged: it still speaks stdio only and contacts nothing new.
 */

/** The release this project was checked against. A new version is a reviewed change of this table, never a download of "latest". */
export const TUNNEL_CLIENT_VERSION = "0.0.19";

export interface TunnelAsset {
  os: "windows" | "linux" | "darwin";
  arch: "amd64" | "arm64";
  /** The official URL (listed in the release's PUBLIC_URLS.txt). */
  url: string;
  /** Exact size in bytes (GitHub release listing). */
  size: number;
  /** SHA-256 from the release's SHA256SUMS.txt, read on 2026-11-06. The network is never trusted for it. */
  sha256: string;
}

export const TUNNEL_ASSETS: readonly TunnelAsset[] = [
  {
    os: "windows",
    arch: "amd64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-windows-amd64.zip",
    size: 29539887,
    sha256: "1d0ecc3a54f2a51e27a635ac155f40fbb95df58c52cdeddf6c75532cc0bbeb25",
  },
  {
    os: "windows",
    arch: "arm64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-windows-arm64.zip",
    size: 26742842,
    sha256: "a054bfb19d72b446cc9802a7987a17eab517502355d27b18e51814bbb0b32731",
  },
  {
    os: "linux",
    arch: "amd64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-linux-amd64.zip",
    size: 29433736,
    sha256: "9ee9448592345a9dd1517fb79791ab54d24f051142eb92bcbe8cd355effc9142",
  },
  {
    os: "linux",
    arch: "arm64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-linux-arm64.zip",
    size: 26855239,
    sha256: "5a19e556c4a8736ab7a6fde6f0568f6e7411fa2dff21186fc15bc30e9b98a603",
  },
  {
    os: "darwin",
    arch: "amd64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-darwin-amd64.zip",
    size: 30293654,
    sha256: "dff97674c77cac59e6ab3d901e6cff50fb17a5784c01d8959d1f4adb3afdf4bf",
  },
  {
    os: "darwin",
    arch: "arm64",
    url: "https://persistent.oaistatic.com/tunnel-client/v0.0.19/tunnel-client-v0.0.19-darwin-arm64.zip",
    size: 28329144,
    sha256: "2243d024b77af8ee4b4ab7a1447949e5fc8d82bcd2d51b178927f2da9e47ecfd",
  },
];

/** The only host the downloader may contact, and only for the URLs of the table. */
export const DOWNLOAD_HOST = "persistent.oaistatic.com";

const OS_OF: Record<string, TunnelAsset["os"]> = {
  win32: "windows",
  linux: "linux",
  darwin: "darwin",
};
const ARCH_OF: Record<string, TunnelAsset["arch"]> = { x64: "amd64", arm64: "arm64" };

/** The archive for this machine (`process.platform`, `process.arch`), or null when OpenAI publishes none. */
export function selectAsset(platform: string, arch: string): TunnelAsset | null {
  const os = OS_OF[platform];
  const a = ARCH_OF[arch];
  if (!os || !a) return null;
  return TUNNEL_ASSETS.find((x) => x.os === os && x.arch === a) ?? null;
}

/** The executable's file name inside the archive. */
export function binaryName(platform: string): string {
  return platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
}

/**
 * Files the archive must contain (the Windows one, checked on 2026-11-06: tunnel-client, cloudflared, its manifest,
 * LICENSE, NOTICE, a licences list and an SPDX file). Anything else at the root is accepted only if its name is
 * plain (the zip reader refuses folders); these must be there.
 */
export function requiredFiles(platform: string): string[] {
  return [binaryName(platform), "LICENSE", "NOTICE"];
}

// ---------------------------------------------------------------------------------------------
// What the user types
// ---------------------------------------------------------------------------------------------

/** tunnel-client's own format: `tunnel_` + 32 lowercase letters or digits, optionally after a 4-character namespace. */
export const TUNNEL_ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;

export function checkTunnelId(raw: string): { id: string } | { error: string } {
  const id = raw.trim();
  if (TUNNEL_ID.test(id)) return { id };
  if (/^sk-/.test(id))
    return {
      error:
        "That looks like an API key, not a tunnel ID. The tunnel ID starts with tunnel_ (Platform > Tunnels). " +
        "The key goes in with: npm run chatgpt -- key",
    };
  return {
    error:
      "A tunnel ID is tunnel_ followed by 32 lowercase letters or digits (sometimes tunnel_abcd_ then 32). " +
      "Copy it from https://platform.openai.com/settings/organization/tunnels",
  };
}

export type KeyCheck = { key: string; warning?: string } | { error: string };

/**
 * The runtime API key, checked without ever being repeated: no message here contains the value or its length.
 * An admin key is refused (tunnel-client's docs: never for the long-lived daemon), so is a tunnel ID pasted by mistake.
 */
export function checkApiKey(raw: string): KeyCheck {
  const key = raw.trim();
  if (key === "") return { error: "No key received." };
  if (/^tunnel_/.test(key))
    return {
      error:
        "That is the tunnel ID, not the key. Give it to setup (--tunnel-id); the key is a runtime API key.",
    };
  if (/^sk-admin-/.test(key))
    return {
      error:
        "That is an admin key. tunnel-client needs a runtime key restricted to Tunnels Read + Use, never an admin key.",
    };
  if (!/^[\x21-\x7e]+$/.test(key))
    return { error: "The key contains spaces or unusual characters: copy it again, in one piece." };
  if (key.length < 20 || key.length > 1024)
    return { error: "That does not look like an API key: copy it again, in one piece." };
  if (!/^sk-/.test(key))
    return {
      key,
      warning:
        "The key does not start with sk-: check it is the runtime key of Platform > API keys (Tunnels Read + Use).",
    };
  return { key };
}

/** The health port: tunnel-client's default is 8080, which other programs use too. */
export function checkPort(raw: string): { port: number } | { error: string } {
  if (!/^\d{1,5}$/.test(raw.trim())) return { error: "--port needs a number from 1024 to 65535." };
  const port = Number(raw.trim());
  if (port < 1024 || port > 65535) return { error: "--port needs a number from 1024 to 65535." };
  return { port };
}

// ---------------------------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------------------------

export class PathError extends Error {}

/** A C0 control character or DEL (a new line in a path would break the YAML and the command line). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * One path as tunnel-client's command line needs it. MEASURED (v0.0.19): the command is split like a shell line and
 * backslashes are eaten (`C:\Program Files\nodejs\node.exe` became `C:Program Filesnodejsnode.exe`). So on Windows every
 * backslash becomes a forward slash (Windows accepts both) and the path is put in double quotes (spaces). A character
 * that a shell-style split would interpret inside double quotes is refused rather than escaped.
 */
export function commandPath(file: string, platform: string): string {
  const p = platform === "win32" ? file.replace(/\\/g, "/") : file;
  if (hasControl(p) || /["`$]/.test(p) || (platform !== "win32" && p.includes("\\")))
    throw new PathError(
      `This path cannot be passed safely to tunnel-client: ${p}. Move the folder to a path without quotes, ` +
        "backslashes, dollar signs or backticks.",
    );
  return `"${p}"`;
}

/** A path inside the YAML (not split like a command): forward slashes on Windows, no control character. */
export function yamlPath(file: string, platform: string): string {
  const p = platform === "win32" ? file.replace(/\\/g, "/") : file;
  if (hasControl(p))
    throw new PathError(`This path contains a control character: ${JSON.stringify(p)}.`);
  return p;
}

/** A YAML double-quoted scalar. Only `\` and `"` need escaping once control characters are refused. */
export function yamlString(s: string): string {
  if (hasControl(s)) throw new PathError("Refusing a control character in the profile.");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface ProfileInput {
  tunnelId: string;
  /** `process.execPath`: the very Node that runs this command, absolute. */
  nodePath: string;
  /** Absolute path of this checkout's dist/index.js. */
  entryPath: string;
  /** Absolute path of the runtime key file (`api_key: file:...`). */
  keyFile: string;
  port: number;
  platform: string;
}

/** The mcp command line: node and the server entry, each quoted for tunnel-client's split. */
export function mcpCommand(
  input: Pick<ProfileInput, "nodePath" | "entryPath" | "platform">,
): string {
  return `${commandPath(input.nodePath, input.platform)} ${commandPath(input.entryPath, input.platform)}`;
}

/**
 * The YAML profile. Same keys as `tunnel-client init` writes (checked on v0.0.19), with three differences on purpose:
 * the key is read from a file (`file:`), never from an environment variable that every program would inherit; the
 * log is readable text at level warn, since the player watches that window (MEASURED on v0.0.19: level info prints
 * about 40 lines of internal wiring with stack traces at every start; `start --verbose` brings info back); and no
 * base_url (tunnel-client's default, OpenAI's API, is the only one this project documents).
 */
export function renderProfile(input: ProfileInput): string {
  const id = checkTunnelId(input.tunnelId);
  if ("error" in id) throw new PathError(id.error);
  const lines = [
    "# Written by sc-copilot-mcp (npm run chatgpt -- setup). Re-running setup replaces this file.",
    "# No secret here: tunnel-client reads the runtime key from the file named by api_key.",
    "config_version: 1",
    "control_plane:",
    `  tunnel_id: ${yamlString(id.id)}`,
    `  api_key: ${yamlString(`file:${yamlPath(input.keyFile, input.platform)}`)}`,
    "health:",
    `  listen_addr: ${yamlString(`127.0.0.1:${input.port}`)}`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: warn",
    "  format: struct-text",
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: ${yamlString(mcpCommand(input))}`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The environment of tunnel-client, and so of the server it starts
// ---------------------------------------------------------------------------------------------

/**
 * Variables tunnel-client reads by itself. Its precedence is flags > environment > YAML, so a variable left in the
 * player's environment (a CONTROL_PLANE_TUNNEL_ID of another project, an OPENAI_API_KEY, LOG_HTTP_RAW_UNSAFE,
 * ALLOW_REMOTE_UI...) would silently override the profile. They are removed from the child's environment, which
 * also keeps every OpenAI key away from this server (it inherits tunnel-client's environment).
 */
const TUNNEL_PREFIXES = [
  "CONTROL_PLANE_",
  "OPENAI_",
  "MCP_",
  "HEALTH_",
  "LOG_",
  "ADMIN_UI_",
  "CLOUDFLARED_",
  "HARPOON_",
  "TUNNEL_CLIENT_",
];
const TUNNEL_NAMES = new Set([
  "ALLOW_REMOTE_UI",
  "FORWARD_REQUEST_ID",
  "CA_BUNDLE",
  "PROXY_CHECK_INTERVAL",
]);

export function isTunnelClientVariable(name: string): boolean {
  const n = name.toUpperCase();
  return TUNNEL_NAMES.has(n) || TUNNEL_PREFIXES.some((p) => n.startsWith(p));
}

/** The profiles the Claude Desktop installer gives a new entry: the same tools in ChatGPT unless asked otherwise. */
export const DEFAULT_PROFILES = "core,trade,data,local";

export interface StartOptions {
  telemetry?: "on" | "off";
  balance?: "shown" | "hidden";
  profiles?: string;
}

export interface ChildEnv {
  env: Record<string, string>;
  /** Names removed (never values). */
  removed: string[];
  /** What this command set, as NAME=value: only SC_TELEMETRY, SC_BALANCE and SCMCP_PROFILES, never a secret. */
  set: string[];
}

/** The environment for tunnel-client (and so for this server): the player's own, minus tunnel-client's settings, plus the options. */
export function childEnv(
  base: Record<string, string | undefined>,
  options: StartOptions,
): ChildEnv {
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isTunnelClientVariable(name)) removed.push(name);
    else env[name] = value;
  }
  const set: string[] = [];
  const put = (name: string, value: string) => {
    for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
    env[name] = value;
    set.push(`${name}=${value}`);
  };
  if (options.telemetry === "on") put("SC_TELEMETRY", "on");
  if (options.telemetry === "off") {
    for (const k of Object.keys(env)) if (k.toUpperCase() === "SC_TELEMETRY") delete env[k];
    set.push("SC_TELEMETRY (removed: telemetry off)");
  }
  if (options.balance) put("SC_BALANCE", options.balance);
  if (options.profiles) put("SCMCP_PROFILES", options.profiles);
  else if (!Object.keys(env).some((k) => k.toUpperCase() === "SCMCP_PROFILES"))
    put("SCMCP_PROFILES", DEFAULT_PROFILES);
  return { env, removed: removed.sort(), set };
}

/** The values to type in ChatGPT's form. */
export function chatgptFormLines(tunnelId: string): string[] {
  return [
    "In ChatGPT: https://chatgpt.com/#settings/Connectors (Developer mode on, in Advanced settings),",
    "create an app / add a custom MCP server, while this tunnel is running:",
    "  Connection:      Tunnel",
    `  Tunnel ID:       ${tunnelId}`,
    "  Authentication:  No authentication",
  ];
}
