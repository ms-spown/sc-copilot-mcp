import { toErrorResult } from "../core/errors.js";
import type { FleetStore } from "../providers/fleet/store.js";
import type { ConnectionTracker } from "../providers/gamelog/connection.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import type { Scmdb } from "../providers/scmdb/store.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import type { HttpClient } from "../core/http.js";
import {
  buildProvenance,
  runWithProvenance,
  type ProvenanceContext,
  type ToolMeta,
} from "../core/provenance.js";
import {
  cleanString,
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
import { dashboardResources, dashboardTools } from "./dashboard.js";
import { fleetTools } from "./fleet.js";
import { gameLogTools } from "./gamelog.js";
import { sctTools } from "./sctools.js";
import { statusTools, type StatusProbe } from "./status.js";
import { telemetryTools } from "./telemetry.js";
import type {
  ClientContext,
  ListedTool,
  ResourceDefinition,
  ToolDefinition,
  ToolResult,
} from "./types.js";
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
  /** Optional live telemetry. Absent or disabled: its tools say so and nothing connects. */
  telemetry?: Telemetry;
  /** Follows the end of Game.log for the player's connection to the servers. Absent: it is simply not reported. */
  connection?: ConnectionTracker;
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
    ...telemetryTools(clients),
    ...dashboardTools(clients),
    ...fleetTools(clients),
    ...localTools(),
    ...vocabularyTools(clients),
    ...dumpTools(),
  ];
}

/** The resources the server serves, before any condition. Today: the live dashboard View. */
export function allResources(clients: ToolClients): ResourceDefinition[] {
  return dashboardResources(clients);
}

/** Which tools to advertise: explicit names win, then profiles, then everything. */
export interface Selection {
  /** SCMCP_TOOLS */
  tools?: Set<string> | null;
  /** SCMCP_PROFILES */
  profiles?: string[] | null;
}

export interface RegistryOptions {
  /** Resources served through resources/list and resources/read (only while each one is `advertised`). */
  resources?: ResourceDefinition[];
  /** Game version to report for sources that do not stamp their rows (UEX). Failures give null. */
  gameVersionFor?: (meta: ToolMeta) => Promise<string | null>;
  now?: () => number;
}

export interface ToolRegistry {
  /**
   * What `tools/list` advertises: name, description, schema and (MCP Apps) `_meta`, never the handler.
   * Tools that need a View are listed only when `context.ui` is true.
   */
  list(context?: ClientContext): ListedTool[];
  /** The resources to advertise now (empty while their feature is off). */
  listResources(): ResourceDefinition[];
  /** One advertised resource with its text; throws for an unknown one or one whose feature is off. */
  readResource(uri: string): ResourceDefinition & { body: string };
  call(name: string, args: unknown): Promise<ToolResult>;
}

/** The dashboard View needs its two app-only tools: a scoped list must never open a View that cannot poll. */
function withDashboardSet(names: Set<string>): Set<string> {
  if (names.has("sc_live_dashboard")) {
    names.add("sc_live_poll");
    names.add("sc_live_mark");
  }
  return names;
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
    return withDashboardSet(new Set([...selection.tools, "sc_data_status"]));
  }

  if (selection.profiles) {
    const bad = selection.profiles.filter((p) => !(PROFILE_NAMES as readonly string[]).includes(p));
    if (bad.length) {
      throw new Error(
        `SCMCP_PROFILES names unknown profiles: ${bad.join(", ")}. Known: ${PROFILE_NAMES.join(", ")}.`,
      );
    }
    const wanted = new Set(selection.profiles as Profile[]);
    return withDashboardSet(
      new Set(
        tools
          .filter((t) => CATALOG[t.name]?.profiles.some((p) => wanted.has(p)))
          .map((t) => t.name)
          .concat("sc_data_status"),
      ),
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

/** An error a handler built itself: no invisible characters, and a bound on its length. */
function cleanErrorResult(result: ToolResult): ToolResult {
  return {
    ...result,
    content: result.content.map((c) => ({ ...c, text: cleanString(c.text, 2000) })),
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
  const resources = options.resources ?? [];

  return {
    list(context) {
      return tools
        .filter((t) => !enabled || enabled.has(t.name))
        .filter((t) => t.advertised?.() !== false)
        .filter((t) => !t.requiresUi || context?.ui === true)
        .map(({ name, description, inputSchema, meta }) => ({
          name,
          description,
          inputSchema,
          ...(meta ? { _meta: meta } : {}),
        }));
    },
    listResources() {
      return resources.filter((r) => r.advertised());
    },
    readResource(uri) {
      const resource = resources.find((r) => r.uri === uri);
      if (!resource) throw new Error(`Unknown resource: ${uri}`);
      if (!resource.advertised()) {
        throw new Error(
          "This resource is not available: live telemetry is switched off (SC_TELEMETRY is not 'on').",
        );
      }
      return { ...resource, body: resource.text() };
    },
    async call(name, args) {
      try {
        const tool = byName.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const meta = CATALOG[name];
        return await runWithProvenance(async (ctx) => {
          const result = await tool.handler(args);
          if (result.isError) return cleanErrorResult(result);
          if (!meta) return result;
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
