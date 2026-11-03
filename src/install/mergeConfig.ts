/**
 * Minimal merge of this server into claude_desktop_config.json.
 *
 * That file also holds the user's other MCP servers, so it is never replaced: exactly one key,
 * mcpServers[name], is added or updated and everything else is kept as is. Nothing secret goes
 * into it: the UEX token lives in a .env file next to the package, which the server reads
 * itself. The planning step is pure, so it can be shown to the user before anything is written.
 */

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface MergePlan {
  action: "add" | "update" | "unchanged";
  entry: ServerEntry;
  previous: ServerEntry | null;
  /** The whole file after the merge, ready to write. */
  merged: Record<string, unknown>;
  /** How many other servers are kept untouched. Their names and settings are never shown. */
  otherServers: number;
}

export class ConfigError extends Error {}

const looksSecret = /token|key|secret|password|authorization/i;

export function planMerge(rawConfig: string | null, name: string, entry: ServerEntry): MergePlan {
  let config: Record<string, unknown> = {};
  if (rawConfig !== null && rawConfig.trim() !== "") {
    try {
      const parsed = JSON.parse(rawConfig);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      throw new ConfigError(
        "The Claude Desktop config is not valid JSON, so it was not touched. Fix it first.",
      );
    }
  }

  for (const key of Object.keys(entry.env)) {
    if (looksSecret.test(key))
      throw new ConfigError(
        `Refusing to write ${key} into the Claude config: keep secrets in .env.`,
      );
  }

  const servers = config.mcpServers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    throw new ConfigError(
      "mcpServers in the Claude config is not an object, so it was not touched.",
    );
  }
  const existing = (servers ?? {}) as Record<string, unknown>;
  const previous = (existing[name] as ServerEntry | undefined) ?? null;

  const merged = { ...config, mcpServers: { ...existing, [name]: entry } };
  const action =
    previous === null
      ? "add"
      : JSON.stringify(previous) === JSON.stringify(entry)
        ? "unchanged"
        : "update";
  return {
    action,
    entry,
    previous,
    merged,
    otherServers: Object.keys(existing).filter((k) => k !== name).length,
  };
}

/** What is shown before writing: only this server's entry and a count of the others. */
export function describePlan(plan: MergePlan, name: string): string {
  const lines = [
    `Action: ${plan.action} the "${name}" server in mcpServers`,
    `Other servers left untouched: ${plan.otherServers}`,
    "",
    "Entry that would be written:",
    ...JSON.stringify({ [name]: plan.entry }, null, 2)
      .split("\n")
      .map((l) => `  ${l}`),
  ];
  if (plan.previous && plan.action === "update") {
    lines.push(
      "",
      "Replaces:",
      ...JSON.stringify({ [name]: plan.previous }, null, 2)
        .split("\n")
        .map((l) => `  ${l}`),
    );
  }
  return lines.join("\n");
}
