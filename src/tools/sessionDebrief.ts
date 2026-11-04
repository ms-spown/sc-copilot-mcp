import { z } from "zod";
import { wantsBalance, type BalancePolicy } from "../core/balance.js";
import { sanitizeUntrusted } from "../core/untrusted.js";
import { DASHBOARD_URI } from "../dashboard/constants.js";
import {
  DEBRIEF_EXPORT_MAX_TEXT,
  DEBRIEF_FOR_EXPORT,
  DEBRIEF_FOR_MODEL,
  DEBRIEF_LIMITS,
  DEBRIEF_MODEL_MAX_TEXT,
  type Debrief,
} from "../providers/sessions/debrief.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import { MONEY_WITHHELD_NOTE } from "../providers/sessions/stats.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The session report (providers/sessions/debrief.ts, pure) as two tools, because the model and the player do not need the
 * same size:
 *
 * - `sc_session_debrief` is for the MODEL: a report is part of the conversation (and goes to the provider), so it is small:
 *   at most about 28 000 characters of text, Markdown by default, a CSV only when asked and then 100 rows at most. Its
 *   `structuredContent` holds metadata only (the text is not sent twice).
 * - `sc_session_export` is for the dashboard (app-only, never meant for the model): the WHOLE report of one session, Markdown
 *   and CSV, for the "Copier le bilan" and download controls, bounded at a sane maximum (DEBRIEF_FOR_EXPORT).
 *
 * Why tools of their own and not a `format` on sc_session_current: every string of a session-file answer is cut at 200
 * characters by the registry (catalog.ts `maxText`), a limit that must stay for the others.
 *
 * Money: every aUEC figure comes from the player's balance. With include_balance=false (or SC_BALANCE=hidden and no
 * explicit choice) the report has none (counts, durations, SCU, labels) and says so. Otherwise amounts appear, but the
 * balance at the start and at the last sighting only with include_start_balance too (the report is meant to be shared:
 * that stays the player's separate, explicit choice, false by default).
 */

const OFF =
  "Sessions are off: they need live telemetry (SC_TELEMETRY=on in the server's entry) and are switched off by SC_SESSIONS=off. Nothing is read or written.";

const APP_ONLY_META = { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } };

const includeBalanceProp = {
  type: "boolean",
  description:
    "Include aUEC figures (results, margins, fees, rate). Default true; false hides them (the player's choice).",
};
const includeStartBalanceProp = {
  type: "boolean",
  description:
    "With include_balance only: also the balance at the start and at the last sighting. Default false. The player must ask for it.",
};
const delimiterProp = {
  type: "string",
  enum: [",", ";"],
  description:
    'CSV separator: "," (default) or ";" (Excel in French opens it in columns; decimal comma).',
};

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** The sessions to report on, from the arguments; `error` when they contradict. */
function pick(parsed: { id?: string | undefined; last?: number | undefined }) {
  if (parsed.id !== undefined && parsed.last !== undefined) return "Pass id or last, not both.";
  return {
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.last !== undefined ? { last: parsed.last } : {}),
  };
}

const meta = (d: Debrief) => ({
  sessions: d.sessions,
  trips_total: d.trips_total,
  markdown_omitted: d.markdown_omitted,
  csv_omitted: d.csv_omitted,
  truncated: d.truncated,
  money_included: d.money_included,
  balances_included: d.balances_included,
  csv_delimiter: d.csv_delimiter,
});

export function sessionDebriefTools({
  sessions,
  balance,
}: {
  sessions?: SessionManager;
  balance?: BalancePolicy;
}): ToolDefinition[] {
  const enabled = () => sessions?.enabled === true;
  return [
    {
      name: "sc_session_debrief",
      description:
        "The report of the player's saved play session (or the newest N), to share or keep: Markdown (default; header, key numbers, trips table with measured/computed/estimated/unknown tags, what is unexplained, footer) or the trips as CSV (format csv, 100 rows at most). Text in French, about 28,000 characters at most, older trips cut with a count. With include_balance=false there is NO aUEC amount (counts, times, SCU, labels) and the report says so; otherwise amounts appear, but the start and end balances only with include_start_balance too: ask the player, the report is meant to be shared. Give the Markdown as it is, add no figure, send it nowhere. The player downloads the full Markdown and CSV from the session bar of the dashboard: mention it. id: a past session; last: the newest N (1 to 10). Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["markdown", "csv"],
            description: "Default markdown. csv is the trips only.",
          },
          include_balance: includeBalanceProp,
          include_start_balance: includeStartBalanceProp,
          csv_delimiter: delimiterProp,
          id: { type: "string", maxLength: 48, description: "A session id from sc_session_list." },
          last: {
            type: "number",
            description: `The newest N sessions that hold something (1 to ${DEBRIEF_LIMITS.sessions}). Default 1. Not with id.`,
          },
        },
      },
      advertised: enabled,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return textResult(OFF);
        const parsed = z
          .object({
            format: z.enum(["markdown", "csv"]).optional(),
            include_balance: z.boolean().optional(),
            include_start_balance: z.boolean().optional(),
            csv_delimiter: z.enum([",", ";"]).optional(),
            id: z.string().max(48).optional(),
            last: z.number().int().min(1).max(DEBRIEF_LIMITS.sessions).optional(),
          })
          .parse(args || {});
        const which = pick(parsed);
        if (typeof which === "string") return textResult(which);
        const format = parsed.format ?? "markdown";
        const money = wantsBalance(parsed.include_balance, balance);
        const balancesAsked = parsed.include_start_balance === true;
        const d = await sessions.debrief({
          ...which,
          includeMoney: money,
          includeBalances: money && balancesAsked,
          limits: {
            ...DEBRIEF_FOR_MODEL,
            ...(parsed.csv_delimiter ? { csvDelimiter: parsed.csv_delimiter } : {}),
          },
        });
        const persistence = { status: sessions.notice ?? "ok" };
        if (!d) {
          return answer(
            {
              report: null,
              message: parsed.id
                ? "No session with this id. Call sc_session_list for the ids."
                : "No session to report yet. One starts when the game is seen running with telemetry on, or with sc_session_new.",
              persistence,
            },
            {},
          );
        }
        const omitted = format === "csv" ? d.csv_omitted : d.markdown_omitted;
        const value = {
          format,
          ...meta(d),
          ...(format === "markdown" ? { markdown: d.markdown } : { csv: d.csv }),
          ...(money ? {} : { money_note: MONEY_WITHHELD_NOTE }),
          ...(balancesAsked && !money
            ? {
                balances_note:
                  "include_start_balance was ignored: the balances are given only together with include_balance.",
              }
            : {}),
          ...(omitted > 0
            ? {
                truncation_note: `${omitted} older trips are not in this text. The player downloads the full report from the session bar of the dashboard.`,
              }
            : {}),
          persistence,
        };
        // The text goes to the model once; the structured copy has the metadata only.
        const { markdown: _m, csv: _c, ...structured } = value as Record<string, unknown>;
        void [_m, _c];
        return answer(value, structured);
      },
    },
    {
      name: "sc_session_export",
      description:
        "For the dashboard only, not for the model: the whole report of one saved session, as Markdown or as CSV (kind), for the 'Copier le bilan' and download controls. Refused to a client that did not declare the UI extension. Same privacy rules as sc_session_debrief. Needs SC_TELEMETRY=on.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 48, description: "A session id." },
          kind: { type: "string", enum: ["md", "csv"], description: "The text wanted." },
          include_balance: includeBalanceProp,
          include_start_balance: includeStartBalanceProp,
          csv_delimiter: delimiterProp,
        },
        required: ["id", "kind"],
      },
      advertised: enabled,
      requiresUi: true,
      meta: APP_ONLY_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!sessions || !sessions.enabled) return textResult(OFF);
        const parsed = z
          .object({
            id: z.string().min(1).max(48),
            kind: z.enum(["md", "csv"]),
            include_balance: z.boolean().optional(),
            include_start_balance: z.boolean().optional(),
            csv_delimiter: z.enum([",", ";"]).optional(),
          })
          .strict()
          .parse(args || {});
        const money = wantsBalance(parsed.include_balance, balance);
        const d = await sessions.debrief({
          id: parsed.id,
          includeMoney: money,
          includeBalances: money && parsed.include_start_balance === true,
          limits: {
            ...DEBRIEF_FOR_EXPORT,
            ...(parsed.csv_delimiter ? { csvDelimiter: parsed.csv_delimiter } : {}),
          },
        });
        if (!d) return textResult("No session with this id.");
        // Only the text asked for: half the size, and nothing the View will not show.
        const structured = {
          ...meta(d),
          ...(parsed.kind === "md" ? { markdown: d.markdown } : { csv: d.csv }),
        };
        return {
          content: [
            {
              type: "text",
              text: `Session report ready (${d.trips_total} trips). It is for the dashboard.`,
            },
          ],
          structuredContent: sanitizeUntrusted(structured, DEBRIEF_EXPORT_MAX_TEXT) as Record<
            string,
            unknown
          >,
        };
      },
    },
  ];
}

/** The answer: the text for the model (`content`) and its metadata (`structuredContent`). */
function answer(value: Record<string, unknown>, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: sanitizeUntrusted(
      Object.keys(structured).length > 0 ? structured : value,
      DEBRIEF_MODEL_MAX_TEXT,
    ) as Record<string, unknown>,
  };
}
