import { z } from "zod";
import { formatOutputRaw } from "../core/format.js";
import { sanitizeUntrusted } from "../core/untrusted.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import { MONEY_WITHHELD_NOTE, withoutMoney } from "../providers/sessions/stats.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The session tools. A session is the player's own summary of a play period, kept in ONE local file by this server
 * (providers/sessions): when it began, the balance at its start and at its last sighting, the trips made and what they
 * earned. They exist only with SC_TELEMETRY=on and are left unlisted when SC_SESSIONS=off.
 *
 * - sc_session_current, sc_session_list and sc_session_stats only read. Every aUEC figure (balances, results, turnover,
 *   rates) is withheld unless the caller passes include_balance=true, which the model does only after the player agreed:
 *   a tool result is part of the conversation. Counts, durations and place names are not withheld.
 * - sc_session_new and sc_session_end write ONLY this server's own session file (same precedent as the fleet tools):
 *   nothing is sent to the game or to a network.
 *
 * The same results are returned as `structuredContent`, which the dashboard View reads (the host does not add it to the
 * model's context). It holds exactly what the text holds: no extra figure.
 */

const result = (value: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
  // The registry cleans and fences `content`; the structured copy (for the dashboard) is cleaned here the same way.
  structuredContent: sanitizeUntrusted(value, 200) as Record<string, unknown>,
  ...(isError ? { isError: true } : {}),
});

const OFF =
  "Sessions are off: they need live telemetry (SC_TELEMETRY=on in the server's entry) and are switched off by SC_SESSIONS=off. Nothing is read or written.";

const includeBalanceProp = {
  type: "boolean",
  description:
    "Include aUEC figures (balances, results, turnover, rate per hour). Default false. Ask the player first: the answer goes into the conversation.",
};

const PROPOSE_HINT =
  "To propose the next run: compare last_known and recent_trips with uex_get_trade_routes (and prices), and explain the reasoning in plain words. Say which figures are measured and which are estimates.";

/** Said when a change is only in memory (the disk refused it, or the file is from a newer version). */
const saveWarning = (saved: boolean) =>
  saved
    ? ""
    : " WARNING: this change is NOT saved to disk (see persistence.status); it is kept in memory and saved at the next change that succeeds.";

export function sessionTools({ sessions }: { sessions?: SessionManager }): ToolDefinition[] {
  const enabled = () => sessions?.enabled === true;
  const off = (): ToolResult => ({ content: [{ type: "text", text: OFF }], isError: true });

  return [
    {
      name: "sc_session_current",
      description:
        "The player's current play session, saved on this PC: start time, active time, trips made, last known place and goods (from Game.log, an estimate), the latest trips and, only with include_balance, balance at start and now, result so far, rate per hour and efficiency against the planned route. Use it to ACCOMPANY and PROPOSE the next run (then compare with uex_get_trade_routes). It survives a game crash or a PC reboot and is found again from any conversation. Pass id to open a past session (read-only). Counts and durations are always given; aUEC figures need include_balance=true, which you ask the player for first. Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          include_balance: includeBalanceProp,
          id: { type: "string", maxLength: 48, description: "A session id from sc_session_list." },
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return off();
        const { include_balance, id } = z
          .object({
            include_balance: z.boolean().optional(),
            id: z.string().max(48).optional(),
          })
          .parse(args || {});
        const money = include_balance === true;
        const found = await sessions.session(id, money);
        if (!found) {
          return result({
            session: null,
            message: id
              ? "No session with this id. Call sc_session_list for the ids."
              : "No session yet. One starts when the game is seen running with telemetry on, or with sc_session_new.",
            persistence: { status: sessions.notice ?? "ok" },
          });
        }
        const s = found.session;
        return result({
          session: s,
          is_current: !id && found.open && !found.stale,
          state: found.open ? (found.stale ? "open_but_quiet" : "open") : "ended",
          last_known: s
            ? {
                location: s.last_location,
                commodity: s.last_commodity,
                basis: "the last step Game.log counted as done: an estimate, not a position",
              }
            : null,
          recent_trips: found.recent_trips,
          interruptions: found.interruptions,
          note_for_the_model: PROPOSE_HINT,
          ...(money ? {} : { money_note: MONEY_WITHHELD_NOTE }),
          persistence: {
            status: sessions.notice ?? "ok",
            new_session_after_hours: sessions.gapHours,
          },
        });
      },
    },
    {
      name: "sc_session_list",
      description:
        "The player's saved play sessions, newest first, with their key numbers: start, active time, trips and, only with include_balance, net result and rate per hour. For going back to a past session (open one with sc_session_current and its id). Counts and durations are always given; aUEC figures need include_balance=true, which you ask the player for first. Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many sessions, 1 to 50. Default 20." },
          include_balance: includeBalanceProp,
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return off();
        const { limit, include_balance } = z
          .object({
            limit: z.number().int().min(1).max(50).optional(),
            include_balance: z.boolean().optional(),
          })
          .parse(args || {});
        const money = include_balance === true;
        const out = await sessions.list(limit ?? 20, money);
        return result({
          ...out,
          ...(money ? {} : { money_note: MONEY_WITHHELD_NOTE }),
          persistence: { status: sessions.notice ?? "ok" },
        });
      },
    },
    {
      name: "sc_session_stats",
      description:
        "Statistics across the player's saved sessions: totals, average rate per hour, trend, best and worst session, best routes and goods (when known), efficiency against planned routes, and how many transactions the game refused because the price moved (price_refusals, a count). Estimates and measures are labelled, an unknown figure is null, never zero. Sessions with too little active time give no rate. route_reliability (with include_balance only): per goods and route, realised against planned margin and fee rate from the player's own saved runs, always with the number of runs and a confidence label; few runs means low confidence; an estimate that claims no cause. aUEC figures need include_balance=true, which you ask the player for first; counts and times are always given. Use last to limit to the newest N sessions. Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          last: {
            type: "number",
            description: "Only the newest N sessions (1 to 200). Default: all.",
          },
          include_balance: includeBalanceProp,
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return off();
        const { last, include_balance } = z
          .object({
            last: z.number().int().min(1).max(200).optional(),
            include_balance: z.boolean().optional(),
          })
          .parse(args || {});
        const money = include_balance === true;
        const stats = await sessions.stats(last, money);
        return result({
          ...stats,
          ...(money ? {} : { money_note: MONEY_WITHHELD_NOTE }),
          persistence: { status: sessions.notice ?? "ok" },
        });
      },
    },
    {
      name: "sc_session_new",
      description:
        "Starts a new play session now (the player pressed or asked for 'Nouvelle session'): the current one is closed with its numbers kept, the new one starts from the balance just seen. Writes only this server's own session file; nothing is sent to the game. Use only when the player asks. Optional note (500 characters).",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", maxLength: 500 } },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return off();
        const { note } = z.object({ note: z.string().max(500).optional() }).parse(args || {});
        const made = await sessions.newSession(note);
        return result({
          ok: true,
          message: `Session ${made.summary.number} started.${made.previous !== null ? ` Session ${made.previous} was closed.` : ""}${saveWarning(made.saved)}`,
          session: withoutMoney(made.summary),
          persistence: { saved: made.saved, status: sessions.notice ?? "ok" },
        });
      },
    },
    {
      name: "sc_session_end",
      description:
        "Ends the current play session now (the player asked to finish it); its numbers stay in the history. The next play period starts a new one once the game is seen starting afresh. Writes only this server's own session file. Use only when the player asks. Optional note (500 characters).",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", maxLength: 500 } },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return off();
        const { note } = z.object({ note: z.string().max(500).optional() }).parse(args || {});
        const ended = await sessions.endSession(note);
        return result({
          ok: ended.ended,
          message: ended.ended
            ? `Session ${ended.summary?.number} ended.${saveWarning(ended.saved)}`
            : "No session was open (an empty one is simply dropped).",
          persistence: { saved: ended.saved, status: sessions.notice ?? "ok" },
          ...(ended.summary ? { session: withoutMoney(ended.summary) } : {}),
        });
      },
    },
  ];
}
