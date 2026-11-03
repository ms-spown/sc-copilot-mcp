import { toErrorResult } from "../core/errors.js";
import type { FleetStore } from "../providers/fleet/store.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import type { Scmdb } from "../providers/scmdb/store.js";
import type { HttpClient } from "../core/http.js";
import {
  buildProvenance,
  runWithProvenance,
  type ProvenanceContext,
  type ToolMeta,
} from "../core/provenance.js";
import {
  DEFAULT_MAX_TEXT,
  delimitText,
  sanitizeUntrusted,
  UNTRUSTED_NOTICE,
} from "../core/untrusted.js";
import { CATALOG, PROFILE_NAMES, type Profile } from "./catalog.js";
import { dumpTools } from "./dumps.js";
import { localTools } from "./local.js";
import { patchNotesTools } from "./patchnotes.js";
import { scmdbTools } from "./scmdb.js";
import { fleetTools } from "./fleet.js";
import { gameLogTools } from "./gamelog.js";
import { sctTools } from "./sctools.js";
import { statusTools, type StatusProbe } from "./status.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import { uexTools } from "./uex.js";
import { vocabularyTools } from "./vocabulary.js";
import { wikiTools } from "./wiki.js";

export interface ToolClients {
  uexClient: HttpClient;
  scwClient: HttpClient;
  sctClient: HttpClient;
  scmdb: Scmdb;
  gameLog: GameLog;
  fleet: FleetStore;
}

/** Every tool this server implements, before any scoping. */
export function allTools(clients: ToolClients, probes: StatusProbe[] = []): ToolDefinition[] {
  return [
    ...statusTools(probes),
    ...uexTools(clients),
    ...wikiTools(clients),
    ...sctTools(clients),
    ...patchNotesTools(clients),
    ...scmdbTools(clients),
    ...gameLogTools(clients),
    ...fleetTools(clients),
    ...localTools(),
    ...vocabularyTools(clients),
    ...dumpTools(),
  ];
}

/** Which tools to advertise: explicit names win, then profiles, then everything. */
export interface Selection {
  /** SCMCP_TOOLS */
  tools?: Set<string> | null;
  /** SCMCP_PROFILES */
  profiles?: string[] | null;
}

export interface RegistryOptions {
  /** Game version to report for sources that do not stamp their rows (UEX). Failures give null. */
  gameVersionFor?: (meta: ToolMeta) => Promise<string | null>;
  now?: () => number;
}

export interface ToolRegistry {
  /** What `tools/list` advertises: name, description and schema, never the handler. */
  list(): { name: string; description: string; inputSchema: ToolDefinition["inputSchema"] }[];
  call(name: string, args: unknown): Promise<ToolResult>;
}

function selectedNames(tools: ToolDefinition[], selection: Selection): Set<string> | null {
  const known = new Set(tools.map((t) => t.name));

  if (selection.tools) {
    const unknown = [...selection.tools].filter((n) => !known.has(n));
    if (unknown.length) {
      throw new Error(
        `SCMCP_TOOLS names unknown tools: ${unknown.join(", ")}. Known: ${[...known].sort().join(", ")}.`,
      );
    }
    return new Set([...selection.tools, "sc_data_status"]);
  }

  if (selection.profiles) {
    const bad = selection.profiles.filter((p) => !(PROFILE_NAMES as readonly string[]).includes(p));
    if (bad.length) {
      throw new Error(
        `SCMCP_PROFILES names unknown profiles: ${bad.join(", ")}. Known: ${PROFILE_NAMES.join(", ")}.`,
      );
    }
    const wanted = new Set(selection.profiles as Profile[]);
    return new Set(
      tools
        .filter((t) => CATALOG[t.name]?.profiles.some((p) => wanted.has(p)))
        .map((t) => t.name)
        .concat("sc_data_status"),
    );
  }

  return null;
}

/**
 * Wrap a tool's output with its provenance. Free text from third parties is cleaned and
 * fenced first. The envelope is serialized here and nowhere else: formatOutput would strip
 * the nulls and zeros that matter in it.
 */
function envelope(
  meta: ToolMeta,
  result: ToolResult,
  ctx: ProvenanceContext,
  gameVersion: string | null,
  now: number,
): ToolResult {
  const raw = result.content.map((c) => c.text).join("\n");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  const untrusted = meta.trust === "untrusted_text";
  const max = meta.maxText ?? DEFAULT_MAX_TEXT;
  if (untrusted) {
    data =
      typeof data === "string" ? delimitText(data, meta.source, max) : sanitizeUntrusted(data, max);
  }

  const body = {
    provenance: buildProvenance(meta, ctx, gameVersion, now),
    ...(untrusted ? { notice: UNTRUSTED_NOTICE } : {}),
    data,
  };
  const pretty = JSON.stringify(body, null, 2);
  return {
    ...result,
    content: [{ type: "text", text: pretty.length > 60_000 ? JSON.stringify(body) : pretty }],
  };
}

/**
 * @param selection scopes the LISTING only (latency, not access control): a tool that is not
 *   advertised can still be called by name.
 */
export function createRegistry(
  tools: ToolDefinition[],
  selection: Selection = {},
  options: RegistryOptions = {},
): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  const enabled = selectedNames(tools, selection);
  const now = options.now ?? Date.now;

  return {
    list() {
      return tools
        .filter((t) => !enabled || enabled.has(t.name))
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, args) {
      try {
        const tool = byName.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const meta = CATALOG[name];
        return await runWithProvenance(async (ctx) => {
          const result = await tool.handler(args);
          if (result.isError || !meta) return result;
          let gameVersion: string | null = null;
          if (options.gameVersionFor && ctx.gameVersion === undefined) {
            try {
              gameVersion = await options.gameVersionFor(meta);
            } catch {
              gameVersion = null; // provenance must never make a good answer fail
            }
          }
          return envelope(meta, result, ctx, gameVersion, now());
        });
      } catch (error: unknown) {
        return toErrorResult(error);
      }
    },
  };
}
