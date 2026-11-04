import { z } from "zod";
import {
  DASHBOARD_URI,
  PLAN_PRICE_POINTS_MAX,
  PLAN_TEXT_MAX,
  UI_MIME_TYPE,
} from "../dashboard/constants.js";
import { dashboardHtml } from "../dashboard/page.js";
import { parsePlan } from "../dashboard/plan.js";
import { ledgerLogFrom, LedgerService } from "../dashboard/ledgerService.js";
import { DashboardService } from "../dashboard/service.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import { ShipSpecsResolver } from "../dashboard/specs.js";
import type { HttpClient } from "../core/http.js";
import type { ConnectionTracker } from "../providers/gamelog/connection.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import { NOT_IN_STREAM } from "../providers/telemetry/normalize.js";
import type { ResourceDefinition, ToolDefinition, ToolResult } from "./types.js";

/**
 * The live dashboard: an MCP App. `sc_live_dashboard` is the tool the model calls; Claude Desktop then renders the
 * View (one self-contained page, served as the resource below, whose address starts with ui:) in the conversation. The View refreshes itself
 * through `sc_live_poll` and writes its session markers through `sc_live_mark`; both are reserved to the View
 * (`visibility: ["app"]`) and the model is told not to call them.
 *
 * All three are listed only when SC_TELEMETRY=on AND the client declared the UI extension: Claude Code and other
 * text clients never see them. Nothing here writes to the game or to disk.
 */

const OPEN_META = { ui: { resourceUri: DASHBOARD_URI }, "ui/resourceUri": DASHBOARD_URI };
const APP_ONLY_META = { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } };

/** Told to the model with every opening: a second copy is clutter, and the old one keeps updating. */
export const OPEN_HINT =
  "If a dashboard is already open in this conversation, do not open another one unless the player explicitly asks for it: the open one updates by itself.";

const off = (): ToolResult => ({
  content: [
    {
      type: "text",
      text: "Live telemetry is switched off on the server (SC_TELEMETRY is not 'on'). Call sc_live_status for how to enable it. Nothing was read from the game.",
    },
  ],
  isError: true,
});

export function dashboardResources({ telemetry }: { telemetry?: Telemetry }): ResourceDefinition[] {
  return [
    {
      uri: DASHBOARD_URI,
      name: "Live dashboard",
      description:
        "The live dashboard View for the game's local telemetry. Served only while live telemetry is switched on.",
      mimeType: UI_MIME_TYPE,
      advertised: () => telemetry?.enabled === true,
      contentMeta: { ui: { prefersBorder: false } },
      text: dashboardHtml,
    },
  ];
}

export function dashboardTools({
  telemetry,
  scwClient,
  connection,
  gameLog,
  sessions,
}: {
  telemetry?: Telemetry;
  scwClient?: HttpClient;
  connection?: ConnectionTracker;
  gameLog?: GameLog;
  sessions?: SessionManager;
}): ToolDefinition[] {
  // The game log only serves the transport ledger: read-only, opt-in, refreshed at most every 5 s in the background.
  // With saved sessions on, the session manager owns the ONE ledger reader and the dashboard shares it.
  const ledger =
    sessions?.ledger ?? (gameLog ? new LedgerService(ledgerLogFrom(gameLog)) : undefined);
  // The wiki client only serves the ship sheet lookup (background, one search per ship, never while telemetry is off).
  const service = new DashboardService(
    telemetry,
    Date.now,
    scwClient ? new ShipSpecsResolver(scwClient) : undefined,
    connection,
    ledger,
    // The trade journal of the same log reads (providers/gamelog/trade.ts), for the commerce card.
    ledger ? () => ledger.trades() : undefined,
    sessions,
  );
  const enabled = () => telemetry?.enabled === true;

  return [
    {
      name: "sc_live_dashboard",
      description:
        "Opens the live dashboard of the running game in the conversation (ship, speed, hydrogen, health, warning lights, events, session pace; the aUEC balance stays hidden until the player clicks). Call it when the player asks to see their ship or session live. If a dashboard is already open in this conversation, do not open it again unless the player explicitly asks for a new one: it updates by itself, and each extra copy stays on screen (only the most recent one calls the server, the others show a banner). Rendered by Claude Desktop only. The View refreshes itself: never call sc_live_poll or sc_live_mark. When the player asks a question while it is open, answer with sc_live_state. The stream has no cargo, position or shield level. Waiting or connected means no data yet (menus, loading): never say the game is not running or that something is wrong, no troubleshooting unless it shows a game launched without telemetry or an unknown format. On foot only character data exists; ship instruments need the player seated in a ship. Optional plan: after uex_get_trade_routes, pass the route (expected_profit_auec is the PROFIT, not the turnover; unit prices and recent price points are welcome) so the View compares planned profit with the measured result of the trade run.",
      inputSchema: {
        type: "object",
        properties: {
          plan: {
            type: "object",
            description:
              "Optional route plan to show next to the measured balance change. Cargo is not measured by the game: the balance change is the only measure.",
            properties: {
              commodity: { type: "string", maxLength: PLAN_TEXT_MAX },
              buy_terminal: { type: "string", maxLength: PLAN_TEXT_MAX },
              sell_terminal: { type: "string", maxLength: PLAN_TEXT_MAX },
              scu: { type: "number", description: "Cargo size planned, in SCU." },
              expected_profit_auec: {
                type: "number",
                description:
                  "Planned PROFIT in aUEC (sales minus purchases at the planned prices, before any fee). Not a turnover.",
              },
              buy_unit_price: {
                type: "number",
                description: "Planned buying price, aUEC per SCU.",
              },
              sell_unit_price: {
                type: "number",
                description: "Planned selling price, aUEC per SCU.",
              },
              est_trip_minutes: {
                type: "number",
                description: "Estimated trip time of the route, in minutes.",
              },
              safety_note: { type: "string", maxLength: PLAN_TEXT_MAX },
              price_points: {
                type: "array",
                maxItems: PLAN_PRICE_POINTS_MAX,
                items: { type: "number" },
                description:
                  "Recent prices per SCU, oldest first (at most 30), taken from the UEX price tools, for the price curve. The dashboard never calls UEX.",
              },
              price_points_for: {
                type: "string",
                enum: ["buy", "sell"],
                description: "Which price the points are (sell when absent).",
              },
              price_points_label: {
                type: "string",
                maxLength: PLAN_TEXT_MAX,
                description: "The period of the points in words, for example '7 derniers jours'.",
              },
              note: { type: "string", maxLength: PLAN_TEXT_MAX },
            },
          },
        },
      },
      advertised: enabled,
      requiresUi: true,
      meta: OPEN_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        if (!enabled()) return off();
        const { plan } = z.object({ plan: z.unknown().optional() }).parse(args || {});
        const clean = parsePlan(plan);
        // Memory only: lets the transport ledger put the planned profit next to the measured one.
        service.setPlan(clean);
        sessions?.setPlan(clean);
        return {
          content: [
            {
              type: "text",
              text: `The live dashboard is open in the conversation and updates by itself. For questions, call sc_live_state. Do not call sc_live_poll. ${OPEN_HINT}`,
            },
          ],
          structuredContent: {
            view: "sc_live_dashboard",
            opened_at: new Date().toISOString(),
            hint: OPEN_HINT,
            not_in_stream: NOT_IN_STREAM,
            ...(clean ? { plan: clean } : {}),
          },
        };
      },
    },
    {
      name: "sc_live_poll",
      description:
        "For the dashboard View only, not for the model: current telemetry state, recent events and session counters as structured content, refreshed by the View about once a second (answers are shared for half a second). Never starts the reader while telemetry is off. The balance is included only if include_balance is true, which the View sets after the player clicks. Use sc_live_state instead.",
      inputSchema: {
        type: "object",
        properties: {
          include_balance: {
            type: "boolean",
            description: "Include the aUEC balance and its change. Default false.",
          },
          include_static: {
            type: "boolean",
            description: "Include the list of what the stream never contains. The View asks once.",
          },
          since_seq: {
            type: "number",
            description: "The newest event number the View holds: only newer events come back.",
          },
          have: {
            type: "object",
            description:
              "Hashes (the `hash` of a previous answer) of the sections the View holds; a section with the same hash is left out and listed in `unchanged`.",
            properties: {
              ship: { type: "string", maxLength: 16 },
              pilot: { type: "string", maxLength: 16 },
              weapons: { type: "string", maxLength: 16 },
              specs: { type: "string", maxLength: 16 },
              ledger: { type: "string", maxLength: 16 },
            },
          },
        },
      },
      advertised: enabled,
      requiresUi: true,
      meta: APP_ONLY_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        const hash = z.string().regex(/^[0-9a-f]{1,16}$/);
        const { include_balance, include_static, since_seq, have } = z
          .object({
            include_balance: z.boolean().optional(),
            include_static: z.boolean().optional(),
            since_seq: z.number().int().min(0).max(1e12).optional(),
            have: z
              .object({
                ship: hash.optional(),
                pilot: hash.optional(),
                weapons: hash.optional(),
                specs: hash.optional(),
                ledger: hash.optional(),
              })
              .optional(),
          })
          .parse(args || {});
        const result = await service.poll({
          includeBalance: include_balance === true && enabled(),
          ...(include_static === true ? { includeStatic: true } : {}),
          ...(since_seq !== undefined ? { sinceSeq: since_seq } : {}),
          ...(have ? { have } : {}),
        });
        return {
          // Fixed text on purpose: the data is in structuredContent, and no balance can leak into the text.
          content: [{ type: "text", text: `live dashboard poll: ${result.state}` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      },
    },
    {
      name: "sc_live_mark",
      description:
        "For the dashboard View only, not for the model: sets a session marker (start, end) or restarts the balance change. They drive the View's own flight counters and balance restart, in this server's memory; they do NOT start or end the saved play session (that is sc_session_new and sc_session_end). Nothing is written to disk and nothing is sent to the game. Start also resets the counters. Does nothing while telemetry is off.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "end", "reset_delta"],
            description: "start or end a session, or restart the balance change from now.",
          },
        },
        required: ["action"],
      },
      advertised: enabled,
      requiresUi: true,
      meta: APP_ONLY_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        const { action } = z
          .object({ action: z.enum(["start", "end", "reset_delta"]) })
          .parse(args || {});
        const result = await service.mark(action);
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      },
    },
  ];
}
