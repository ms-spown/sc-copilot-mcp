import path from "node:path";

/** Where Claude Desktop keeps claude_desktop_config.json: the same rule as scripts/install-claude-desktop.mjs. */
export function claudeConfigPath(env: { APPDATA?: string; HOME?: string } = process.env): string {
  return path.join(
    env.APPDATA ?? path.join(env.HOME ?? ".", ".config"),
    "Claude",
    "claude_desktop_config.json",
  );
}
