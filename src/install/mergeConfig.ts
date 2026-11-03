/**
 * Minimal merge of this server into claude_desktop_config.json.
 *
 * That file also holds the user's other MCP servers, so it is never replaced: exactly one key,
 * mcpServers[name], is added or updated and everything else is kept as is. Nothing secret goes
 * into it: the UEX token lives in a .env file next to the package, which the server reads
 * itself. The planning step is pure, so it can be shown to the user before anything is written.
 */
import { editEnvKeyText } from "./jsonEdit.js";

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

/** A UTF-8 BOM is not part of the JSON: Windows editors add it, and JSON.parse rejects it. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseConfig(rawConfig: string | null): Record<string, unknown> {
  if (rawConfig === null || rawConfig.trim() === "") return {};
  try {
    const parsed = JSON.parse(stripBom(rawConfig));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ConfigError(
      "The Claude Desktop config is not valid JSON, so it was not touched. Fix it first.",
    );
  }
}

function readServers(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.mcpServers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    throw new ConfigError(
      "mcpServers in the Claude config is not an object, so it was not touched.",
    );
  }
  return (servers ?? {}) as Record<string, unknown>;
}

/** The opt-in telemetry switch lives in the entry's env: reinstalling must not silently switch it off. */
const CARRIED_OVER = "SC_TELEMETRY";

export function planMerge(rawConfig: string | null, name: string, entry: ServerEntry): MergePlan {
  const config = parseConfig(rawConfig);

  for (const key of Object.keys(entry.env)) {
    if (looksSecret.test(key))
      throw new ConfigError(
        `Refusing to write ${key} into the Claude config: keep secrets in .env.`,
      );
  }

  const existing = readServers(config);
  const previous = (existing[name] as ServerEntry | undefined) ?? null;

  const carried = previous?.env?.[CARRIED_OVER];
  const finalEntry: ServerEntry =
    typeof carried === "string" && !(CARRIED_OVER in entry.env)
      ? { ...entry, env: { ...entry.env, [CARRIED_OVER]: carried } }
      : entry;

  const merged = { ...config, mcpServers: { ...existing, [name]: finalEntry } };
  const action =
    previous === null
      ? "add"
      : JSON.stringify(previous) === JSON.stringify(finalEntry)
        ? "unchanged"
        : "update";
  return {
    action,
    entry: finalEntry,
    previous,
    merged,
    otherServers: Object.keys(existing).filter((k) => k !== name).length,
  };
}

export interface EnvKeyPlan {
  /** "no_entry": the server is not in the config; nothing is invented. */
  action: "add" | "update" | "remove" | "unchanged" | "no_entry";
  key: string;
  /** Whether the key was in the entry's env before. Its value is never exposed. */
  presentBefore: boolean;
  /** The parsed content expected after the change, or null when nothing changes or there is no entry. */
  merged: Record<string, unknown> | null;
  /**
   * The new file text: the original with only this key inserted, changed or removed, byte for byte otherwise
   * (BOM, line endings, indentation, number spellings kept). Null when nothing changes.
   */
  text: string | null;
  otherServers: number;
}

/**
 * Set (string) or remove (null) ONE key of mcpServers[name].env and nothing else: the entry's command, args,
 * other env keys and every other server are kept as they are. An entry that does not exist is never created.
 */
export function planEnvKey(
  rawConfig: string | null,
  name: string,
  key: string,
  value: string | null,
): EnvKeyPlan {
  const config = parseConfig(rawConfig);
  if (looksSecret.test(key))
    throw new ConfigError(`Refusing to write ${key} into the Claude config: keep secrets in .env.`);

  const servers = readServers(config);
  const otherServers = Object.keys(servers).filter((k) => k !== name).length;
  const entry = servers[name];
  if (entry === undefined) {
    return {
      action: "no_entry",
      key,
      presentBefore: false,
      merged: null,
      text: null,
      otherServers,
    };
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    throw new ConfigError(
      `The "${name}" entry in the Claude config is not an object, so it was not touched.`,
    );
  const rawEnv = (entry as Record<string, unknown>).env;
  if (
    rawEnv !== undefined &&
    (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv))
  )
    throw new ConfigError(
      `The env of "${name}" in the Claude config is not an object, so it was not touched.`,
    );
  const env = (rawEnv ?? {}) as Record<string, unknown>;
  const presentBefore = key in env;

  let action: EnvKeyPlan["action"];
  if (value === null) action = presentBefore ? "remove" : "unchanged";
  else if (!presentBefore) action = "add";
  else action = env[key] === value ? "unchanged" : "update";
  if (action === "unchanged")
    return { action, key, presentBefore, merged: null, text: null, otherServers };

  const nextEnv: Record<string, unknown> = { ...env };
  if (value === null) delete nextEnv[key];
  else nextEnv[key] = value;
  const nextEntry = { ...(entry as Record<string, unknown>), env: nextEnv };
  const merged = { ...config, mcpServers: { ...servers, [name]: nextEntry } };

  // Edit the text itself, then prove the result means exactly what the object-level change would.
  const bom = rawConfig !== null && stripBom(rawConfig) !== rawConfig ? "\uFEFF" : "";
  let edited: string | null;
  try {
    edited = editEnvKeyText(stripBom(rawConfig ?? ""), name, key, value);
    if (JSON.stringify(JSON.parse(edited)) !== JSON.stringify(merged)) edited = null;
  } catch {
    edited = null;
  }
  if (edited === null) {
    const todo =
      value === null
        ? `remove "${key}" from the env of "${name}"`
        : `in the env of "${name}", set ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    throw new ConfigError(
      `The config could not be edited safely, so it was not touched. Do it by hand: ${todo}.`,
    );
  }
  return { action, key, presentBefore, merged, text: bom + edited, otherServers };
}

/** Shown before writing: the key's name and its new state. No other key or value of the file appears. */
export function describeEnvKeyPlan(plan: EnvKeyPlan, name: string, value: string | null): string {
  if (plan.action === "no_entry")
    return `The "${name}" server is not in the Claude Desktop config, so nothing can be changed there (run: npm run install:claude).`;
  const before = plan.presentBefore ? "(set)" : "(absent)";
  const after = value === null ? "(absent)" : JSON.stringify(value);
  return [
    `Config change: mcpServers["${name}"].env.${plan.key}: ${before} -> ${after}${plan.action === "unchanged" ? "  [already so, nothing to write]" : ""}`,
    `Everything else is kept as is, including ${plan.otherServers} other server(s).`,
  ].join("\n");
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
