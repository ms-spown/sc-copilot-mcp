import { z } from "zod";
import { MAX_OUTPUT_CHARS, formatOutputRaw } from "../core/format.js";
import { TELEMETRY_WARNING } from "../core/telemetryNotice.js";
import { addNote, recordFetch, setChannel, setGameVersion } from "../core/provenance.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import type { Weapons } from "../providers/telemetry/normalize.js";
import type { TelemetrySnapshot } from "../providers/telemetry/service.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The live telemetry tools. The stream is the game's own undocumented local feature, read only when the user
 * switched it on (SC_TELEMETRY=on) AND set the game-side variable. Nothing here sends anything to the game.
 *
 * - sc_live_status: always advertised. Says why there is no data, and how to turn it on.
 * - sc_live_state / sc_live_events: advertised only when SC_TELEMETRY=on.
 *
 * Tool results are part of the conversation, which goes to the model provider. So the UEC balance is returned only
 * when the caller asks for it (`include_balance`); the stream itself stays on this PC.
 */

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

/**
 * What one tool answer may weigh (it goes into the conversation): the global output budget of formatOutputRaw. The
 * decoder already caps every list; this is the second line. Over the budget formatOutputRaw would only trim a
 * top-level list or replace everything with "Result too large", so a list is cut here first, and the answer says so.
 */
export const MAX_RESPONSE_CHARS = MAX_OUTPUT_CHARS;
/** The decoder keeps 64 weapons at most (decode.ts); the tool never shows more either. */
const MAX_WEAPONS_SHOWN = 64;

function cutWeapons(w: Weapons, keep: number): Weapons & { truncated?: string } {
  return w.weapons.length <= keep
    ? w
    : {
        ...w,
        weapons: w.weapons.slice(0, keep),
        truncated: `more weapons than shown: the list is cut to ${keep}`,
      };
}

/** `value` as a tool result; while the text is too long, `shrink` returns a smaller value (null = give up). */
function okFitted<T>(value: T, shrink: (v: T) => T | null): ToolResult {
  let current: T | null = value;
  for (let i = 0; i < 12 && current !== null; i++) {
    const text = JSON.stringify(current, null, 2);
    if (text.length <= MAX_RESPONSE_CHARS) return { content: [{ type: "text", text }] };
    current = shrink(current);
  }
  return ok({ truncated: true, note: "The answer was too large to return and was dropped." });
}

export const HOW_TO_ENABLE = [
  "Two switches, both explicit. 1) Server side: SC_TELEMETRY=on in the sc-copilot entry of the MCP configuration. 2) Game side: GRPC_CLIENT_SERVER_ENABLED=true in the environment of StarCitizen.exe, inherited from the RSI Launcher: quit the launcher completely (tray icon too) and start it again.",
  "One command does both, as a dry run first: `npm run telemetry -- status`, then `npm run telemetry -- enable` (and `--apply` to write). `npm run telemetry -- disable --apply` undoes it.",
  TELEMETRY_WARNING.join(" "),
];

const LIMITS = [
  "The stream has no position, no camera, no shield level, no hull or heat, no ammo, no power distribution and no quantum fuel: do not infer them.",
  "Health 0 means down OR dead; the stream cannot tell them apart.",
  "A value is only as fresh as frame_age_ms says. Ground vehicles (Ursa, Cyclone) send no vehicle data.",
  "Fields missing from the stream are left out or listed as not available; they are never a real zero.",
];

/** Game version and channel from Game.log, when it is configured: telemetry itself does not say. */
function logContext(gameLog: GameLog | undefined) {
  let cached: { at: number; channel: "live" | "ptu" | "unknown"; version: string | null } | null =
    null;
  return async () => {
    if (!gameLog?.configured) return;
    const now = Date.now();
    if (!cached || now - cached.at > 60_000) {
      try {
        const r = await gameLog.read("current", 64 * 1024);
        const s = r.parsed.session;
        cached = {
          at: now,
          channel: s.channel,
          version: s.game_version
            ? `${s.game_version}${s.build ? ` (build ${s.build})` : ""}`
            : null,
        };
      } catch {
        cached = { at: now, channel: "unknown", version: null };
      }
    }
    setChannel(cached.channel);
    setGameVersion(cached.version);
  };
}

function stripBalance(snapshot: TelemetrySnapshot, include: boolean) {
  const { state, uec_session, ...rest } = snapshot;
  const pilot = state.pilot ? { ...state.pilot } : state.pilot;
  if (pilot && !include) delete pilot.uec_balance;
  return {
    ...rest,
    ...(include && uec_session ? { uec_session } : {}),
    ...(include
      ? {}
      : { uec_balance: "withheld: call again with include_balance=true if the player agrees" }),
    state: { ...state, pilot },
  };
}

export function telemetryTools({
  telemetry,
  gameLog,
}: {
  telemetry?: Telemetry;
  gameLog?: GameLog;
}): ToolDefinition[] {
  const enabled = () => telemetry?.enabled === true;
  const addLogContext = logContext(gameLog);
  const off = (): ToolResult => ({
    content: [
      {
        type: "text",
        text: "Live telemetry is switched off on the server (SC_TELEMETRY is not 'on'). Call sc_live_status for how to enable it. Nothing was read from the game.",
      },
    ],
    isError: true,
  });

  return [
    {
      name: "sc_live_status",
      description:
        "State of the optional live telemetry from the running game: off, waiting, game_without_telemetry, connected, live or incompatible, the cause in one sentence, the age of the last frame, and, when it is off or not working, exactly how to enable it. Always safe to call. Telemetry is OFF by default (it needs SC_TELEMETRY=on on the server AND a game-side variable) and is an undocumented game feature; this tool never changes any setting. When it is off, nothing is read and no connection is made.",
      inputSchema: { type: "object", properties: {} },
      handler: async (): Promise<ToolResult> => {
        if (!telemetry || !enabled()) {
          return ok({
            state: "off",
            enabled: false,
            cause:
              "Telemetry is switched off on the server side (SC_TELEMETRY is not 'on'). No connection is attempted.",
            how_to_enable: HOW_TO_ENABLE,
          });
        }
        await addLogContext();
        const status = await telemetry.status(true);
        if (status.last_frame_age_ms !== undefined) {
          recordFetch({ fetchedAt: Date.now() - status.last_frame_age_ms, cache: "network" });
        }
        return ok({
          enabled: true,
          ...status,
          ...(status.state === "live" ? {} : { how_to_enable: HOW_TO_ENABLE }),
          limits: LIMITS,
        });
      },
    },
    {
      name: "sc_live_state",
      description:
        "Snapshot of the running game from its local telemetry, only when the user enabled it: ship (name, speed, vertical speed, altitude and heading when inside a planet's frame, hydrogen, boost, g-force, landing gear, flight modes, nine power flags, warning lights), weapons per seat and countermeasure counts, and the pilot (locomotion, health, hunger, thirst, heart rate, atmosphere). Every answer carries frame_age_ms: say how old it is and do not present an old frame as current. Fields the game does not send are left out or listed, never shown as zero. NOT in the stream: position, shield level, hull, heat, ammo, power distribution, quantum fuel. Health 0 is 'down or dead'. The UEC balance is withheld unless include_balance is true (ask the player first). Not advertised when telemetry is off.",
      inputSchema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: { type: "string", enum: ["ship", "pilot", "weapons"] },
            description: "Only these parts (default all). Smaller answers cost less.",
          },
          include_balance: {
            type: "boolean",
            description:
              "Include the aUEC balance and its change since the reader started. Default false: the result goes into the conversation.",
          },
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!telemetry || !enabled()) return off();
        const { sections, include_balance } = z
          .object({
            sections: z
              .array(z.enum(["ship", "pilot", "weapons"]))
              .min(1)
              .optional(),
            include_balance: z.boolean().optional(),
          })
          .parse(args || {});
        await addLogContext();
        const snapshot = await telemetry.snapshot();
        if (!snapshot) {
          const status = await telemetry.status(true);
          return ok({
            available: false,
            reason:
              status.state === "live" || status.state === "connected"
                ? "Connected, but no frame yet: the game sends none in menus or loading screens, only after the character has spawned."
                : status.cause,
            status,
          });
        }
        recordFetch({ fetchedAt: Date.now() - snapshot.frame_age_ms, cache: "network" });
        addNote("Live telemetry: a frame is only as current as frame_age_ms says.");
        const view = stripBalance(snapshot, include_balance === true);
        const { state } = view;
        const wanted = new Set(sections ?? ["ship", "pilot", "weapons"]);
        const status = await telemetry.status(false);
        const unavailable: string[] = [];
        if (wanted.has("ship") && !state.ship)
          unavailable.push(
            "ship (no vehicle data in the frame: on foot, in a ground vehicle, or not yet sent)",
          );
        if (wanted.has("weapons") && !state.weapons)
          unavailable.push("weapons (no weapons frame: not seated at a weapons seat)");
        if (wanted.has("pilot") && !state.pilot) unavailable.push("pilot");
        const answer = {
          stream: {
            state: status.state,
            frame_age_ms: snapshot.frame_age_ms,
            received_at: snapshot.received_at,
          },
          ...(wanted.has("ship") && state.ship ? { ship: state.ship } : {}),
          ...(wanted.has("pilot") && state.pilot ? { pilot: state.pilot } : {}),
          ...(wanted.has("weapons") && state.weapons
            ? { weapons: cutWeapons(state.weapons, MAX_WEAPONS_SHOWN) }
            : {}),
          derived: state.derived,
          ...(include_balance && view.uec_session ? { uec_session: view.uec_session } : {}),
          ...(!include_balance ? { uec_balance: view.uec_balance } : {}),
          not_available: unavailable,
          sections_unreadable: state.broken,
          limits: LIMITS,
        };
        return okFitted<Record<string, unknown>>(answer, (a) => {
          const w = a["weapons"] as Weapons | undefined;
          if (!w || w.weapons.length === 0) return null;
          return { ...a, weapons: cutWeapons(w, Math.floor(w.weapons.length / 2)) };
        });
      },
    },
    {
      name: "sc_live_events",
      description:
        "Recent events derived from the live telemetry (took off, landed, quantum jump, lock-on, hits taken, shields down, power lost, health low or 0, respawn, countermeasures, hunger), newest last, from an in-memory ring that starts when the reader starts. Each event says confidence: 'confirmed' (seen working in the field test) or 'unverified' (heuristic or never seen live). The game itself sends almost no events, so these are inferred and debounced; a missing event proves nothing. Use after_seq with the last_seq of a previous call to get only new ones. Balance-change events are withheld unless include_balance is true. Not advertised when telemetry is off.",
      inputSchema: {
        type: "object",
        properties: {
          after_seq: { type: "number", description: "Only events with a higher seq (default 0)." },
          limit: {
            type: "number",
            description: "At most this many, the newest (default 30, max 100).",
          },
          confidence: {
            type: "string",
            enum: ["confirmed", "all"],
            description: "'confirmed' hides unverified events (default all).",
          },
          include_balance: {
            type: "boolean",
            description: "Include balance-change events (default false).",
          },
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!telemetry || !enabled()) return off();
        const { after_seq, limit, confidence, include_balance } = z
          .object({
            after_seq: z.number().optional(),
            limit: z.number().optional(),
            confidence: z.enum(["confirmed", "all"]).optional(),
            include_balance: z.boolean().optional(),
          })
          .parse(args || {});
        await addLogContext();
        const max = Math.min(Math.max(Math.floor(limit ?? 30), 1), 100);
        // Filter BEFORE the cap: limit=1 must give the newest event that is allowed, not an empty answer.
        const result = await telemetry.events(
          after_seq ?? 0,
          max,
          (e) =>
            (confidence !== "confirmed" || e.confidence === "confirmed") &&
            (include_balance === true || e.type !== "uec_changed"),
        );
        const status = await telemetry.status(false);
        const events = result.events;
        if (status.last_frame_age_ms !== undefined) {
          recordFetch({ fetchedAt: Date.now() - status.last_frame_age_ms, cache: "network" });
        }
        const answer = {
          stream: { state: status.state, last_frame_age_ms: status.last_frame_age_ms },
          events,
          last_seq: result.last_seq,
          note: "Events exist only since the reader started in this server process, and only while the game was sending frames.",
        };
        return okFitted<Record<string, unknown> & { events: typeof events }>(answer, (a) =>
          a.events.length === 0
            ? null
            : {
                ...a,
                // Keep the newest: last_seq and after_seq let the caller ask for the rest.
                events: a.events.slice(Math.floor(a.events.length / 2)),
                truncated:
                  "Too many events for one answer: the newest are shown. Use a smaller limit.",
              },
        );
      },
    },
  ];
}
