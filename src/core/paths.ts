import os from "node:os";
import path from "node:path";

/**
 * Per-user directories.
 *
 * The server is started by Claude with a working directory that is not this repository and
 * is often not writable, so nothing may default to `process.cwd()`. Each directory has an
 * environment override, which wins over the platform default.
 */

const APP = "sc-copilot-mcp";

interface Env {
  [key: string]: string | undefined;
}

function local(env: Env, home: string): string {
  return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
}

/** Re-creatable data: HTTP responses and downloaded dumps. Safe to delete. */
export function userCacheDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  if (env.SCMCP_CACHE_DIR) return path.resolve(env.SCMCP_CACHE_DIR);
  if (platform === "win32") return path.join(local(env, home), APP, "cache");
  if (platform === "darwin") return path.join(home, "Library", "Caches", APP);
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), APP);
}

/** Data the user would miss: wiki snapshots. */
export function userDataDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  if (env.SCMCP_DATA_DIR) return path.resolve(env.SCMCP_DATA_DIR);
  if (platform === "win32") return path.join(local(env, home), APP, "data");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP);
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP);
}

/** Settings and personal lists (the fleet file lives here). */
export function userConfigDir(
  env: Env = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  if (env.SCMCP_CONFIG_DIR) return path.resolve(env.SCMCP_CONFIG_DIR);
  if (platform === "win32")
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP);
}
