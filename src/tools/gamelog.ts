import { z } from "zod";
import { formatOutputRaw } from "../core/format.js";
import { addNote, recordFetch, setChannel, setGameVersion } from "../core/provenance.js";
import { EVENT_TYPES, type LogEvent, type SessionInfo } from "../providers/gamelog/parser.js";
import { type GameLog, shortPath, suggestedInstallDirs } from "../providers/gamelog/reader.js";
import type { ToolDefinition, ToolResult } from "./types.js";
import fs from "node:fs";

/**
 * The local Game.log, read-only and off unless the user points the server at it.
 * Only events that were seen in real logs are reported; everything else is ignored and counted.
 * No handle, account id or personal path is ever returned.
 */

const MAX_EVENTS = 100;
const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

const sessionView = (s: SessionInfo, running: boolean) => ({
  game_version: s.game_version,
  build: s.build,
  environment: s.environment,
  channel: s.channel,
  started_local: s.started_local,
  built_on: s.built_on,
  state: s.clean_exit
    ? "ended (clean quit)"
    : running
      ? "running (log written in the last 2 minutes)"
      : "not running, no clean quit seen (crash, kill or still loading)",
});

function noteProvenance(session: SessionInfo, modifiedAt: number) {
  setChannel(session.channel);
  setGameVersion(
    session.game_version
      ? `${session.game_version}${session.build ? ` (build ${session.build})` : ""}`
      : null,
  );
  // The data is as old as the last line the game wrote.
  recordFetch({ fetchedAt: modifiedAt, cache: "network" });
}

export function gameLogTools({ gameLog }: { gameLog: GameLog }): ToolDefinition[] {
  return [
    {
      name: "sc_log_status",
      description:
        "Is the local Game.log readable, and what does it say about the running game: game version, build, LIVE or PTU, whether the game is running or quit cleanly, and how many lines were recognised. The log is OFF until the user sets SC_GAME_LOG_PATH or SC_INSTALL_DIR; when off this explains how and suggests default install folders. Read-only; nothing leaves the machine.",
      inputSchema: { type: "object", properties: {} },
      handler: async (): Promise<ToolResult> => {
        if (!gameLog.configured) {
          return ok({
            configured: false,
            how_to_enable:
              "Set SC_GAME_LOG_PATH to your Game.log, or SC_INSTALL_DIR to your LIVE or PTU folder, in the server's environment, then restart it.",
            default_install_folders_found: suggestedInstallDirs()
              .filter((dir) => fs.existsSync(dir))
              .map(shortPath),
            note: "These are suggestions only. Nothing is read until you configure a path.",
          });
        }
        const r = await gameLog.read();
        noteProvenance(r.parsed.session, r.modifiedAt);
        const byType: Record<string, number> = {};
        for (const e of r.parsed.events) byType[e.type] = (byType[e.type] ?? 0) + 1;
        return ok({
          configured: true,
          file: shortPath(r.file),
          size_mb: Math.round((r.bytes / 1048576) * 100) / 100,
          last_written: new Date(r.modifiedAt).toISOString(),
          session: sessionView(r.parsed.session, r.running),
          events_found: byType,
          lines: r.parsed.stats,
          only_the_end_was_read: r.truncated,
          note: "Lines the parser does not know are counted as ignored, not interpreted. The log format is not guaranteed by CIG.",
        });
      },
    },
    {
      name: "sc_log_recent_events",
      description:
        "Recent things the game wrote in Game.log, oldest first: session start and quit, login, jurisdiction and zone changes (armistice, monitored space, private property), contracts accepted or completed, new and completed objectives, shop purchases (shop, item, price), insurance claims, hangar requests. Use it to know where the player has been and what they just did. NOT in the log, so never reported: quantum travel, combat and kills, wallet balance, position. Use session 'previous' for the run before the current one. Read-only; names and ids of the player are never returned.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Events to return, the most recent ones (default 30, max 100).",
          },
          types: {
            type: "array",
            items: { type: "string", enum: EVENT_TYPES },
            description: "Only these event types.",
          },
          since_minutes: {
            type: "number",
            description: "Only events from the last N minutes (by the log's own clock, UTC).",
          },
          session: {
            type: "string",
            enum: ["current", "previous"],
            description: "'current' = Game.log (default); 'previous' = newest file in logbackups.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { limit, types, since_minutes, session } = z
          .object({
            limit: z.number().optional(),
            types: z.array(z.enum(EVENT_TYPES as [string, ...string[]])).optional(),
            since_minutes: z.number().optional(),
            session: z.enum(["current", "previous"]).optional(),
          })
          .parse(args || {});

        const r = await gameLog.read(session ?? "current");
        noteProvenance(r.parsed.session, r.modifiedAt);
        if (r.truncated)
          addNote(
            "Only the end of a large log was read; older events of this session may be missing.",
          );

        let events: LogEvent[] = r.parsed.events;
        if (types?.length) events = events.filter((e) => types.includes(e.type));
        if (since_minutes !== undefined) {
          const lastClock = r.parsed.events
            .map((e) => e.time)
            .filter(Boolean)
            .at(-1);
          // The log's own last timestamp is the reference, so an old log still answers sensibly.
          const ref = lastClock ? Date.parse(lastClock) : Date.now();
          events = events.filter(
            (e) => e.time && Date.parse(e.time) >= ref - since_minutes * 60_000,
          );
        }
        const total = events.length;
        const shown = events.slice(-Math.min(Math.max(Math.floor(limit ?? 30), 1), MAX_EVENTS));

        return ok({
          session: sessionView(r.parsed.session, r.running),
          total_matching: total,
          shown: shown.length,
          events: shown,
          lines: r.parsed.stats,
          only_the_end_was_read: r.truncated,
        });
      },
    },
  ];
}
