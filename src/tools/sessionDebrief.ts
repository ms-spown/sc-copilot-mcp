import { z } from "zod";
import { sanitizeUntrusted } from "../core/untrusted.js";
import { DEBRIEF_MAX_TEXT, DEBRIEF_LIMITS } from "../providers/sessions/debrief.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import { MONEY_WITHHELD_NOTE } from "../providers/sessions/stats.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * sc_session_debrief: the report of a saved play session (or of the newest few) as Markdown and/or CSV, to TAKE OUT of
 * the server (share with a crew, keep a log, paste into a spreadsheet). The text is built by providers/sessions/debrief.ts
 * (pure); this file only chooses which sessions and what the caller may see.
 *
 * Why a tool of its own and not a `format` on sc_session_current: its answers are long strings, and every string of a
 * session-file answer is cut at 200 characters by the registry (catalog.ts `maxText`), a limit that must stay for the
 * others; this one declares a larger bound sized to the report's own caps (DEBRIEF_MAX_TEXT).
 *
 * Money: every aUEC figure comes from the player's balance. Without include_balance the report has none (counts,
 * durations, SCU, labels) and says so. With it, amounts appear, but the balance at the start and at the last sighting only
 * with include_start_balance too (the report is meant to be shared: that is the player's separate choice).
 */

const OFF =
  "Sessions are off: they need live telemetry (SC_TELEMETRY=on in the server's entry) and are switched off by SC_SESSIONS=off. Nothing is read or written.";

const NOTE_FOR_THE_MODEL =
  "Give the report to the player as it is (the CSV in a code block). Add no figure, round nothing, invent no trend; unknown stays unknown. Say when amounts are withheld and ask before include_balance. The player decides where it goes: send it nowhere.";

export function sessionDebriefTools({ sessions }: { sessions?: SessionManager }): ToolDefinition[] {
  const enabled = () => sessions?.enabled === true;
  return [
    {
      name: "sc_session_debrief",
      description:
        "The report of the player's saved play session, to SHARE or KEEP (crew, org, spreadsheet): Markdown with header (time, active time, game version, breaks), key numbers (trips, per hour, gross margin, fees, best trip, efficiency against the plan, route reliability with runs and confidence), a trips table with measured/computed/estimated/unknown tags, what is unexplained, and a plain footer; and/or a CSV of the trips (English columns). Text in French. Without include_balance there is NO aUEC amount (counts, times, SCU, labels only) and the report says so; with it amounts appear, but never the balance at start and end unless include_start_balance is true too: ask the player, the report is meant to be shared. format: markdown (default), csv or both. id: a past session; last: the newest N (1 to 10). A long CSV is better downloaded from the dashboard. Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["markdown", "csv", "both"],
            description: "Default markdown. csv is the trips only.",
          },
          include_balance: {
            type: "boolean",
            description:
              "Include aUEC figures (results, margins, fees, rate). Default false. Ask the player first: the answer goes into the conversation.",
          },
          include_start_balance: {
            type: "boolean",
            description:
              "With include_balance only: also the balance at the start and at the last sighting. Default false. The player must ask for it.",
          },
          id: { type: "string", maxLength: 48, description: "A session id from sc_session_list." },
          last: {
            type: "number",
            description: `The newest N sessions that hold something (1 to ${DEBRIEF_LIMITS.sessions}). Default 1. Not with id.`,
          },
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) {
          return { content: [{ type: "text", text: OFF }], isError: true };
        }
        const parsed = z
          .object({
            format: z.enum(["markdown", "csv", "both"]).optional(),
            include_balance: z.boolean().optional(),
            include_start_balance: z.boolean().optional(),
            id: z.string().max(48).optional(),
            last: z.number().int().min(1).max(DEBRIEF_LIMITS.sessions).optional(),
          })
          .parse(args || {});
        if (parsed.id !== undefined && parsed.last !== undefined) {
          return {
            content: [{ type: "text", text: "Pass id or last, not both." }],
            isError: true,
          };
        }
        const format = parsed.format ?? "markdown";
        const money = parsed.include_balance === true;
        const balancesAsked = parsed.include_start_balance === true;
        const d = await sessions.debrief({
          ...(parsed.id !== undefined ? { id: parsed.id } : {}),
          ...(parsed.last !== undefined ? { last: parsed.last } : {}),
          includeMoney: money,
          includeBalances: money && balancesAsked,
        });
        const persistence = { status: sessions.notice ?? "ok" };
        if (!d) {
          return build({
            report: null,
            message: parsed.id
              ? "No session with this id. Call sc_session_list for the ids."
              : "No session to report yet. One starts when the game is seen running with telemetry on, or with sc_session_new.",
            persistence,
          });
        }
        return build({
          format,
          sessions: d.sessions,
          trips_total: d.trips_total,
          markdown_rows: d.markdown_rows,
          csv_rows: d.csv_rows,
          truncated: d.truncated,
          money_included: d.money_included,
          balances_included: d.balances_included,
          ...(format !== "csv" ? { markdown: d.markdown } : {}),
          ...(format !== "markdown" ? { csv: d.csv } : {}),
          ...(money ? {} : { money_note: MONEY_WITHHELD_NOTE }),
          ...(balancesAsked && !money
            ? {
                balances_note:
                  "include_start_balance was ignored: the balances are given only together with include_balance.",
              }
            : {}),
          note_for_the_model: NOTE_FOR_THE_MODEL,
          persistence,
        });
      },
    },
  ];
}

/** The answer: the text for the model (`content`) and the same data for the dashboard (`structuredContent`). */
function build(value: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    // The registry cleans `content`; the structured copy is cleaned here with the same rule and the report's own bound.
    structuredContent: sanitizeUntrusted(value, DEBRIEF_MAX_TEXT) as Record<string, unknown>,
  };
}
