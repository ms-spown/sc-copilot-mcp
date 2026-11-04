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
import { loadPlaces } from "../providers/uex/places.js";
import { fetchShipSheet } from "../providers/uex/shipSheet.js";
import { planTrips, type TripPlanResult, type TripRequest } from "../providers/uex/tripPlanner.js";
import {
  failure,
  resolveOriginHint,
  suggestInputSchema,
  SUGGEST_DEADLINE_MS,
  TradeSuggestService,
  type FlownShip,
} from "../dashboard/tradeSuggest.js";
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

/** Parts of the trade suggestions that tests replace (the planner, the clock). Production passes nothing. */
export interface DashboardOverrides {
  plan?: (req: TripRequest) => Promise<TripPlanResult>;
  now?: () => number;
  minIntervalMs?: number;
}

const SHIP_MEMO_MS = 10 * 60_000;

export function dashboardTools(
  {
    telemetry,
    scwClient,
    uexClient,
    connection,
    gameLog,
    sessions,
  }: {
    telemetry?: Telemetry;
    scwClient?: HttpClient;
    uexClient?: HttpClient;
    connection?: ConnectionTracker;
    gameLog?: GameLog;
    sessions?: SessionManager;
  },
  overrides: DashboardOverrides = {},
): ToolDefinition[] {
  // The game log only serves the transport ledger: read-only, opt-in, refreshed at most every 5 s in the background.
  // With saved sessions on, the session manager owns the ONE ledger reader and the dashboard shares it.
  const ledger =
    sessions?.ledger ?? (gameLog ? new LedgerService(ledgerLogFrom(gameLog)) : undefined);
  // The wiki client only serves the ship sheet lookup (background, one search per ship, never while telemetry is off).
  const specsResolver = scwClient ? new ShipSpecsResolver(scwClient) : undefined;
  const service = new DashboardService(
    telemetry,
    Date.now,
    specsResolver,
    connection,
    ledger,
    // The trade journal of the same log reads (providers/gamelog/trade.ts), for the commerce card.
    ledger ? () => ledger.trades() : undefined,
    sessions,
  );
  const enabled = () => telemetry?.enabled === true;

  // The flown ship for the trade suggestions: its class comes from the stream, its wiki sheet from the resolver the
  // poll already uses, its quantum speed and hold from the same lookup uex_plan_trade makes. Server state only: the
  // View never names a ship. Memoised, because the answer for one ship does not change within minutes.
  // The promise is what is remembered: N simultaneous calls make one lookup, not N.
  const shipMemo = new Map<string, { at: number; ship: Promise<FlownShip | null> }>();
  const flownShip = async (): Promise<FlownShip | null> => {
    const snapshot = await telemetry?.snapshot();
    const className = snapshot?.state.ship?.class_name;
    if (!className || !specsResolver || !uexClient || !scwClient) return null;
    const sheet = specsResolver.current(className);
    if (!sheet || sheet.status !== "ready" || !sheet.name) return null;
    const held = shipMemo.get(sheet.name);
    if (held && Date.now() - held.at < SHIP_MEMO_MS) return held.ship;
    const name = sheet.name;
    const wikiCargo = sheet.cargo_scu ?? null;
    const lookup = (async (): Promise<FlownShip | null> => {
      try {
        const found = await fetchShipSheet(uexClient, scwClient, name);
        return {
          name,
          cargoScu: found.cargo_scu ?? wikiCargo,
          quantumSpeedMs: found.quantum_speed_ms,
        };
      } catch {
        // A sheet that cannot be matched in UEX still gives a hold; the planner then says the speed is unknown.
        return { name, cargoScu: wikiCargo, quantumSpeedMs: null };
      }
    })();
    shipMemo.set(name, { at: Date.now(), ship: lookup });
    return lookup;
  };
  const suggestions = new TradeSuggestService({
    plan:
      overrides.plan ??
      ((req) => {
        if (!uexClient || !scwClient) throw new Error("UEX is not available.");
        return planTrips({ uexClient, scwClient, deadlineMs: SUGGEST_DEADLINE_MS }, req);
      }),
    ship: flownShip,
    resolveOrigin: async (text) => {
      try {
        if (!uexClient) return { terminalName: text.trim() };
        return resolveOriginHint(await loadPlaces(uexClient), text);
      } catch {
        return { terminalName: text.trim() };
      }
    },
    // The same two places as the plan Claude passes when it opens the dashboard: the commerce card's figures and the
    // persistent session, which marks the trip that follows with the planned profit. A plan built from the player's
    // balance (its quantity and profit give the budget away) reaches the saved session only while the balance is shown.
    applyPlan: (plan, info) => {
      service.setPlan(plan);
      if (!info.private || info.withBalance) sessions?.setPlan(plan);
    },
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.minIntervalMs !== undefined ? { minIntervalMs: overrides.minIntervalMs } : {}),
  });

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
                  "Recent prices per SCU, oldest first (at most 30), taken from the UEX price tools, for the price curve. The price curve never comes from a dashboard call to UEX.",
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
    {
      name: "sc_trade_suggest",
      description:
        "For the dashboard View only, not for the model: ranks trade routes for the commerce card's buttons (most profitable per hour, fastest, safest by a heuristic, or best per trip) with the UEX trade planner, or applies one of the options it returned as the dashboard's plan (action apply, by id). Answers at most 5 options and 3 chains, throttled (one new planner run per 8 seconds, identical requests served from a short cache), never the player's balance. Use uex_plan_trade instead.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search", "apply"],
            description: "search for routes, or apply an option of a previous answer as the plan.",
          },
          objective: {
            type: "string",
            enum: ["profit_per_hour", "profit", "speed", "safety"],
            description: "What best means (search). Default profit_per_hour.",
          },
          avoid_pyro: { type: "boolean", description: "Leave every Pyro terminal out (search)." },
          armistice_only: {
            type: "boolean",
            description: "Only stops UEX flags as armistice zones (search).",
          },
          min_reports: {
            type: "number",
            description: "Require at least this many player reports at every end (search).",
          },
          round_trip_only: { type: "boolean", description: "Hide the open A>B>C chains (search)." },
          budget: { type: "number", description: "aUEC available for one purchase (search)." },
          budget_private: {
            type: "boolean",
            description:
              "The budget comes from the player's balance: no cost in the answer (search).",
          },
          cargo_scu: { type: "number", description: "Hold size in SCU (search)." },
          origin: {
            type: "string",
            maxLength: 80,
            description: "Where to start: a terminal, planet or system name (search).",
          },
          use_ship: {
            type: "boolean",
            description: "Use the flown ship's quantum speed and hold (search). Default true.",
          },
          next_run: {
            type: "string",
            maxLength: 40,
            description:
              "The id of the completed run this suggestion is for: computed once per run (search).",
          },
          id: {
            type: "string",
            description: "The random id of an option, to apply as the plan (apply).",
          },
          with_balance: {
            type: "boolean",
            description:
              "The balance is shown: a plan built from it may reach the saved session (apply).",
          },
        },
        required: ["action"],
      },
      advertised: enabled,
      requiresUi: true,
      meta: APP_ONLY_META,
      handler: async (args: unknown): Promise<ToolResult> => {
        const parsed = suggestInputSchema.safeParse(args ?? {});
        if (!parsed.success) {
          // A rejected input is a plain error result (the View checks isError), never a thrown exception.
          return {
            content: [{ type: "text", text: "sc_trade_suggest: invalid input." }],
            isError: true,
          };
        }
        if (!enabled()) {
          return {
            content: [{ type: "text", text: "sc_trade_suggest: telemetry is off." }],
            isError: true,
          };
        }
        let answer;
        try {
          answer = await suggestions.handle(parsed.data);
        } catch (error) {
          answer = failure(error);
        }
        return {
          // Fixed text on purpose, like the poll: the data is in structuredContent and nothing derived from the
          // balance can reach the conversation through the text.
          content: [{ type: "text", text: `trade suggestion: ${answer.state}` }],
          structuredContent: answer as unknown as Record<string, unknown>,
        };
      },
    },
  ];
}
