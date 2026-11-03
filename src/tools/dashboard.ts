import { z } from "zod";
import { DASHBOARD_URI, PLAN_TEXT_MAX, UI_MIME_TYPE } from "../dashboard/constants.js";
import { dashboardHtml } from "../dashboard/page.js";
import { parsePlan } from "../dashboard/plan.js";
import { DashboardService } from "../dashboard/service.js";
import type { Telemetry } from "../providers/telemetry/index.js";
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

export function dashboardTools({ telemetry }: { telemetry?: Telemetry }): ToolDefinition[] {
  const service = new DashboardService(telemetry);
  const enabled = () => telemetry?.enabled === true;

  return [
    {
      name: "sc_live_dashboard",
      description:
        "Opens the live dashboard of the running game in the conversation (ship, speed, hydrogen, health, warning lights, events, session pace; the aUEC balance stays hidden until the player clicks). Call it when the player asks to see their ship or session live. Rendered by Claude Desktop only. The View refreshes itself: never call sc_live_poll or sc_live_mark. When the player asks a question while it is open, answer with sc_live_state. The stream has no cargo, position or shield level. Waiting or connected means no data yet (menus, loading): never say the game is not running or that something is wrong, no troubleshooting unless it shows a game launched without telemetry or an unknown format. On foot only character data exists; ship instruments need the player seated in a ship. Optional plan: after uex_get_trade_routes, pass the route so the View compares planned and measured profit.",
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
              expected_profit_auec: { type: "number", description: "Planned profit, in aUEC." },
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
        return {
          content: [
            {
              type: "text",
              text: "The live dashboard is open in the conversation and updates by itself. For questions, call sc_live_state. Do not call sc_live_poll.",
            },
          ],
          structuredContent: {
            view: "sc_live_dashboard",
            opened_at: new Date().toISOString(),
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
        },
      },
      advertised: enabled,
      requiresUi: true,
      meta: APP_ONLY_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        const { include_balance } = z
          .object({ include_balance: z.boolean().optional() })
          .parse(args || {});
        const result = await service.poll(include_balance === true && enabled());
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
        "For the dashboard View only, not for the model: sets a session marker (start, end) or restarts the balance change, in this server's memory. Nothing is written to disk and nothing is sent to the game. Start also resets the session counters. Does nothing while telemetry is off.",
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
