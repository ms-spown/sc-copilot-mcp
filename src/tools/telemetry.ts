import { z } from "zod";
import { MAX_OUTPUT_CHARS, formatOutputRaw } from "../core/format.js";
import { hiddenNote, wantsBalance, type BalancePolicy } from "../core/balance.js";
import { TELEMETRY_WARNING } from "../core/telemetryNotice.js";
import { addNote, recordFetch, setChannel, setGameVersion } from "../core/provenance.js";
import {
  describeConnection,
  notInSession,
  type ConnectionInfo,
  type ConnectionTracker,
} from "../providers/gamelog/connection.js";
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
 * Tool results are part of the conversation, which goes to the model provider. The UEC balance is returned by default
 * (the player's choice, since 2.6); `include_balance: false` or SC_BALANCE=hidden leaves it out. The stream itself stays
 * on this PC.
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
  "States waiting and connected are NORMAL, never a fault: NEVER tell the player the game is not running or that something is wrong (this server cannot know whether the game runs). Say only that there is no data for now and why that is normal: menus, a loading screen, the character not yet spawned, or a game started without the game-side setting. Offer no troubleshooting unless the state is game_without_telemetry or incompatible.",
  'On foot only the character data exists (health, hunger, thirst, heart rate, atmosphere, balance). Ship data (speed, altitude, warning lights, power, weapons) arrives only while the player is SEATED in a ship, a few seconds after sitting down (6 to 9 s); ground vehicles (Ursa, Cyclone) send none. Say it as ordinary information ("no ship data until you are seated in a ship"), never as an error.',
  "The stream has no position, no camera, no shield level, no hull or heat, no ammo, no power distribution and no quantum fuel: do not infer them.",
  "Health 0 means down OR dead; the stream cannot tell them apart.",
  "A value is only as fresh as frame_age_ms says.",
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

function stripBalance(snapshot: TelemetrySnapshot, include: boolean, note: string) {
  const { state, uec_session, ...rest } = snapshot;
  const pilot = state.pilot ? { ...state.pilot } : state.pilot;
  if (pilot && !include) delete pilot.uec_balance;
  return {
    ...rest,
    ...(include && uec_session ? { uec_session } : {}),
    ...(include ? {} : { uec_balance: note }),
    state: { ...state, pilot },
  };
}

/** The connection read from Game.log, with what it means for the data: absent when the log cannot say. */
async function connectionReport(connection: ConnectionTracker | undefined) {
  let info: ConnectionInfo | null;
  try {
    info = (await connection?.current()) ?? null;
  } catch {
    info = null;
  }
  if (!info) return undefined;
  // The game's own `reason` text stays out of what the model reads: the code and the fixed meaning say it all.
  return {
    state: info.state,
    since: info.since,
    code: info.code,
    meaning: describeConnection(info),
  };
}

export function telemetryTools({
  telemetry,
  gameLog,
  connection,
  balance,
}: {
  telemetry?: Telemetry;
  gameLog?: GameLog;
  connection?: ConnectionTracker;
  balance?: BalancePolicy;
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
        "State of the optional live telemetry: off, waiting, game_without_telemetry, connected, live or incompatible, the cause, the age of the last frame and, when not live, how to enable it. Always safe to call; it never changes a setting. Off by default (needs SC_TELEMETRY=on AND a game-side variable); an undocumented game feature. When off, nothing is read. In waiting or connected there is simply no data yet (normal in menus and loading): never say the game is not running or that something is wrong, and offer no troubleshooting unless the state is game_without_telemetry or incompatible. On foot only character data exists. `connection` (from Game.log, when configured): online, menu, disconnected (for example kicked for inactivity) or closed; if not online the values are not current, say so.",
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
        const conn = await connectionReport(connection);
        return ok({
          enabled: true,
          ...status,
          ...(conn ? { connection: conn } : {}),
          ...(status.state === "live" ? {} : { how_to_enable: HOW_TO_ENABLE }),
          limits: LIMITS,
        });
      },
    },
    {
      name: "sc_live_state",
      description:
        "Snapshot of the running game from its local telemetry, only when the user enabled it: ship (name, speed, altitude, heading, hydrogen, boost, g-force, gear, flight modes, power flags, warning lights), weapons per seat, countermeasures, and the pilot (locomotion, health, hunger, thirst, heart rate, atmosphere). Say how old it is (frame_age_ms); fields not sent are left out, never zero. NOT in the stream: position, shield level, hull, heat, ammo, power distribution, quantum fuel. Health 0 is 'down or dead'. The UEC balance is given by default; include_balance=false hides it, and it stays hidden (include_balance=true is ignored) once the player hid it. available=false (waiting or connected) means no data yet, normal in menus and loading: never say the game is not running or that something is wrong. On foot only pilot data exists; ship data needs the player seated in a ship. When the game log is configured, `connection` says if the player is online, in the menus, disconnected (for example kicked for inactivity) or has quit: if it is not online, the values are the last ones held and are not current. Not advertised when telemetry is off.",
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
              "Include the aUEC balance and its change since the reader started. Default true; false hides it (the player's choice).",
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
        let snapshot = await telemetry.snapshot();
        if (!snapshot) {
          // The first request starts the reader: status(true) waits for its first outcome (bounded), then look again.
          const status = await telemetry.status(true);
          snapshot = await telemetry.snapshot();
          if (!snapshot) {
            return ok({
              available: false,
              reason:
                status.state === "live" || status.state === "connected"
                  ? "Connected to the game, no frame yet: the game sends none in menus or loading screens, only after the character has appeared. This is normal; do not present it as a problem."
                  : status.cause,
              status,
              limits: LIMITS,
            });
          }
        }
        recordFetch({ fetchedAt: Date.now() - snapshot.frame_age_ms, cache: "network" });
        addNote("Live telemetry: a frame is only as current as frame_age_ms says.");
        const money = wantsBalance(include_balance, balance);
        const view = stripBalance(snapshot, money, hiddenNote(balance));
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
        const conn = await connectionReport(connection);
        const out = notInSession(conn);
        const answer = {
          stream: {
            state: status.state,
            frame_age_ms: snapshot.frame_age_ms,
            received_at: snapshot.received_at,
          },
          // Present only when Game.log can say it. When the player is not in a server session, everything below is
          // the last thing the stream held, not the present.
          ...(conn ? { connection: conn } : {}),
          ...(wanted.has("ship") && state.ship ? { ship: state.ship } : {}),
          ...(wanted.has("pilot") && state.pilot ? { pilot: state.pilot } : {}),
          ...(wanted.has("weapons") && state.weapons
            ? { weapons: cutWeapons(state.weapons, MAX_WEAPONS_SHOWN) }
            : {}),
          derived: state.derived,
          conditions: out ? [] : state.conditions,
          ...(money && view.uec_session ? { uec_session: view.uec_session } : {}),
          ...(!money ? { uec_balance: view.uec_balance } : {}),
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
        "Recent events derived from the live telemetry (took off, landed, quantum jump, lock-on, hits taken, shields down, power lost, health low or 0, respawn, countermeasures, hunger), newest last, from an in-memory ring that starts when the reader starts. Each event says confidence: 'confirmed' (seen working in the field test) or 'unverified' (heuristic or never seen live). The game itself sends almost no events, so these are inferred and debounced; a missing event proves nothing. Use after_seq with the last_seq of a previous call to get only new ones. Balance-change events are left out while the amounts are hidden (the player's choice, or include_balance false) and the answer says so. Not advertised when telemetry is off.",
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
            description: "Include balance-change events (default true; false hides them).",
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
        const money = wantsBalance(include_balance, balance);
        const max = Math.min(Math.max(Math.floor(limit ?? 30), 1), 100);
        // Filter BEFORE the cap: limit=1 must give the newest event that is allowed, not an empty answer.
        const result = await telemetry.events(
          after_seq ?? 0,
          max,
          (e) =>
            (confidence !== "confirmed" || e.confidence === "confirmed") &&
            (money || e.type !== "uec_changed"),
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
          // Said when balance-change events were left out, as sc_live_state says it for the balance.
          ...(money ? {} : { balance_events_note: hiddenNote(balance) }),
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
