import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { MAX_OUTPUT_CHARS } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import { setDataDates } from "../core/provenance.js";
import { ageDays, label, toNumber, unwrapData, type Row } from "../providers/uex/normalize.js";
import { reportRowDates, rowTimestamp } from "../providers/uex/freshness.js";
import { summarizeHistory } from "../providers/uex/history.js";
import {
  BUILT_IN_LEGEND,
  assessRow,
  parseLegend,
  worstSeverity,
  type Legend,
} from "../providers/uex/marketStatus.js";
import { pickRow } from "../providers/uex/resolve.js";
import { forModelTool, planTrips, TripPlanError } from "../providers/uex/tripPlanner.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * UEX trade intelligence: how a price has moved, whether a terminal is saturated or running dry,
 * and a planner that ranks trade options by profit per hour. The planner itself lives in
 * providers/uex/tripPlanner.ts (no MCP in it); this file only reads arguments and shapes answers.
 *
 * Every row says how old its data is, in its own `age_days`, and `stale` once it is past the limit.
 * A UEX estimate is never presented as a player report.
 */

const SAFE_CHARS = MAX_OUTPUT_CHARS - 4000;

/**
 * Serialise a payload that has one list, shrinking the list until the text fits the output budget.
 * Not formatOutput: it would strip the zeros and `*_min` / `*_max` names that are real data here.
 */
function fitted(build: (keep: number) => Record<string, unknown>, total: number): string {
  for (let keep = total; keep >= 1; keep--) {
    const text = JSON.stringify(
      keep < total
        ? {
            ...build(keep),
            truncated: `showing ${keep} of ${total}; narrow the query for the rest`,
          }
        : build(keep),
      null,
      2,
    );
    if (text.length <= SAFE_CHARS) return text;
  }
  return JSON.stringify(build(0), null, 2);
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const json = (value: unknown): ToolResult => ok(JSON.stringify(value, null, 2));

export function uexIntelTools({
  uexClient,
  scwClient,
}: {
  uexClient: HttpClient;
  scwClient: HttpClient;
}): ToolDefinition[] {
  return [
    {
      name: "uex_get_price_history",
      description:
        "How the price of ONE commodity at ONE terminal has moved, from UEX report snapshots: the points, low, high, mean, volatility (std dev / mean), where the latest price sits in that range, and a plain verdict (high, low or normal for this terminal) with the number of points it rests on. UEX keeps only about 10 snapshots over a few weeks, so the answer always says it is a SHORT history and gives no verdict under 4 points. Both sides are given when the terminal buys and sells it (sell = what it pays you, buy = what it charges you). Needs exact commodity and terminal names. No data for the pair is returned as an explicit no_data answer.",
      inputSchema: {
        type: "object",
        properties: {
          commodity_name: {
            type: "string",
            description: "Exact commodity name (e.g. 'Medical Supplies').",
          },
          terminal_name: {
            type: "string",
            description: "Terminal name or nickname (e.g. 'CBD Lorville' or 'TDD Area 18').",
          },
        },
        required: ["commodity_name", "terminal_name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { commodity_name, terminal_name } = z
          .object({ commodity_name: z.string().min(1), terminal_name: z.string().min(1) })
          .parse(args);
        const commodities = unwrapData((await fetchWithCache(uexClient, "/commodities")).data);
        const terminals = unwrapData((await fetchWithCache(uexClient, "/terminals")).data);
        const commodity = pickRow(
          commodities.kind === "rows" ? commodities.rows : [],
          commodity_name,
          "commodity",
          (r) => [r.name, r.slug, r.code],
        );
        const terminal = pickRow(
          terminals.kind === "rows" ? terminals.rows : [],
          terminal_name,
          "terminal",
          (r) => [r.name, r.nickname, r.fullname, r.displayname],
        );
        const res = await fetchWithCache(uexClient, "/commodities_prices_history", {
          params: { id_terminal: terminal.id, id_commodity: commodity.id },
        });
        const target = {
          commodity: label(commodity.name, 60),
          terminal: label(terminal.nickname ?? terminal.name, 80),
          system: label(terminal.star_system_name, 40),
        };
        const data = unwrapData(res.data);
        if (data.kind !== "rows") {
          return json({
            status: "no_data",
            ...target,
            why: `${data.kind === "no_data" ? data.why : "UEX answered a record, not a list"}: UEX has no price snapshot for this commodity at this terminal.`,
            hint: "Check that the terminal trades this commodity (uex_get_commodity_prices).",
          });
        }
        const now = Date.now();
        const summary = summarizeHistory(data.rows, now);
        if (summary.oldest !== null && summary.newest !== null) {
          setDataDates(
            summary.oldest,
            summary.newest,
            `UEX date_added of the ${data.rows.length} history snapshots (on a history row date_added is the snapshot time)`,
          );
        }
        return json({
          status: "ok",
          ...target,
          rows_from_uex: summary.rows_from_uex,
          span_days: summary.span_days,
          short_history: true,
          short_history_notice: summary.short_history_notice,
          sides: summary.sides,
          estimate_note:
            "History rows do not say whether a price was reported by a player or is a UEX estimate; use uex_get_commodity_prices (is_estimate) for the current price.",
        });
      },
    },

    {
      name: "uex_get_market_status",
      description:
        "Saturation and shortage warnings for a commodity or a terminal, from UEX stock levels. For each terminal row: the price, the SCU available to buy or in stock, the level label on each side (UEX legend from commodities_status), and warnings: out of stock or low stock when buying (you may not fill the hold), no demand or near saturation when selling (it will not pay, or the price falls fast). The legend is NOT symmetric: for selling, level 7 means NO DEMAND. Give commodity_name, terminal_name or both. Each row has updated_at, age_days and stale; a price nobody reported is flagged is_estimate. Worst warnings first.",
      inputSchema: {
        type: "object",
        properties: {
          commodity_name: {
            type: "string",
            description: "Exact commodity name (e.g. 'Laranite').",
          },
          terminal_name: {
            type: "string",
            description: "Terminal name or nickname (e.g. 'ARC-L1').",
          },
          star_system_name: {
            type: "string",
            description: "Optional: keep one system (e.g. 'Stanton').",
          },
          only_warnings: {
            type: "boolean",
            description:
              "Only rows that carry a critical or warning level (default false: all rows).",
          },
          max_age_days: {
            type: "number",
            description:
              "A row older than this is flagged stale (default 7). Rows are never hidden for age.",
          },
          limit: { type: "number", description: "Rows to return (default 25, max 100)." },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const a = z
          .object({
            commodity_name: z.string().optional(),
            terminal_name: z.string().optional(),
            star_system_name: z.string().optional(),
            only_warnings: z.boolean().optional(),
            max_age_days: z.number().positive().optional(),
            limit: z.number().optional(),
          })
          .parse(args || {});
        if (!a.commodity_name && !a.terminal_name) {
          throw new Error(
            "uex_get_market_status needs commodity_name, terminal_name or both: without one UEX would return every price.",
          );
        }
        const params: Record<string, unknown> = {};
        if (a.commodity_name) {
          const rows = unwrapData((await fetchWithCache(uexClient, "/commodities")).data);
          params.id_commodity = pickRow(
            rows.kind === "rows" ? rows.rows : [],
            a.commodity_name,
            "commodity",
            (r) => [r.name, r.slug, r.code],
          ).id;
        }
        if (a.terminal_name) {
          const rows = unwrapData((await fetchWithCache(uexClient, "/terminals")).data);
          params.id_terminal = pickRow(
            rows.kind === "rows" ? rows.rows : [],
            a.terminal_name,
            "terminal",
            (r) => [r.name, r.nickname, r.fullname, r.displayname],
          ).id;
        }
        let legend: Legend = BUILT_IN_LEGEND;
        try {
          legend = parseLegend(
            (await fetchWithCache(uexClient, "/commodities_status", undefined, { record: false }))
              .data?.data,
          );
        } catch {
          // The built-in legend (same codes) stands in; the answer says which one was used.
        }
        const res = await fetchWithCache(uexClient, "/commodities_prices", { params });
        const data = unwrapData(res.data);
        if (data.kind !== "rows") {
          return json({
            status: "no_data",
            why: data.kind === "no_data" ? data.why : "UEX answered a record, not a list",
            rows: [],
          });
        }
        const now = Date.now();
        const maxAge = a.max_age_days ?? 7;
        let rows = data.rows;
        if (a.star_system_name) {
          const wanted = a.star_system_name.trim().toLowerCase();
          rows = rows.filter((r) => String(r.star_system_name ?? "").toLowerCase() === wanted);
        }
        const views = rows
          .map((r: Row) => {
            const status = assessRow(r, legend);
            const ts = rowTimestamp(r);
            const age = ageDays(ts, now);
            const estimate = (price: number | null, reports: unknown) =>
              price === null ? null : toNumber(reports) === 0;
            return {
              commodity: label(r.commodity_name, 60),
              terminal: label(r.terminal_name, 80),
              system: label(r.star_system_name, 40),
              buy: {
                ...status.buy,
                is_estimate: estimate(status.buy.price, r.price_buy_users_rows),
              },
              sell: {
                ...status.sell,
                is_estimate: estimate(status.sell.price, r.price_sell_users_rows),
              },
              warnings: status.warnings,
              updated_at: ts === null ? null : new Date(ts).toISOString(),
              age_days: age,
              stale: age === null || age > maxAge,
              game_version: label(r.game_version, 30),
              worst: worstSeverity(status.warnings),
            };
          })
          .filter((v) => !a.only_warnings || v.warnings.some((w) => w.severity !== "info"))
          .sort((x, y) => x.worst - y.worst || (x.age_days ?? 1e9) - (y.age_days ?? 1e9));
        reportRowDates(rows, "price rows");
        const cap = Math.min(Math.max(Math.floor(a.limit ?? 25), 1), 100);
        const wanted = views.slice(0, cap).map((v) => {
          const copy: Partial<typeof v> = { ...v };
          delete copy.worst;
          return copy;
        });
        const count = (sev: string) =>
          views.filter((v) => v.warnings.some((w) => w.severity === sev)).length;
        return ok(
          fitted(
            (n) => ({
              status: "ok",
              rows_from_uex: data.rows.length,
              matching: views.length,
              critical_rows: count("critical"),
              warning_rows: count("warning"),
              legend_source: legend.source,
              legend_note:
                "BUY side: 1 = out of stock, 7 = full stock. SELL side: 1 = the terminal wants it, 7 = maximum inventory = NO DEMAND.",
              stale_after_days: maxAge,
              rows: wanted.slice(0, n),
            }),
            wanted.length,
          ),
        );
      },
    },

    {
      name: "uex_plan_trade",
      description:
        "Rank trade options by estimated PROFIT PER HOUR (or profit, speed, or a safety heuristic) from UEX prices, the wiki ship sheet and UEX distances, sized to the hold (ship_name or cargo_scu) and budget. `options` come back to where they start: one-way routes (when you give a commodity, terminal or planet) and round trips A>B>A. `chains` A>B>C have no return leg priced: ranked apart, never against options. Gives profit per SCU, per run and per hour; travel time is an ESTIMATE (quantum flight + fixed stop time), fuel is left out and why. The order follows the objective; each option is tagged [ESTIMATE] when UEX has no player report for a price (report_counts); min_reports requires reports. Prices past max_age_days are excluded. Safety is a labelled heuristic, never a promise.",
      inputSchema: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            enum: ["profit_per_hour", "profit", "speed", "safety"],
            description:
              "profit_per_hour (default), profit (per run), speed (shortest run), safety (fewest risk factors of the heuristic).",
          },
          ship_name: {
            type: "string",
            description:
              "Ship to haul with (e.g. 'Caterpillar'): cargo from UEX, quantum speed from the wiki sheet.",
          },
          cargo_scu: { type: "number", description: "Hold size in SCU (wins over the ship's)." },
          quantum_speed_ms: {
            type: "number",
            description:
              "Quantum speed in m/s when there is no ship (e.g. 238314300 for a Cutlass Black).",
          },
          budget: { type: "number", description: "aUEC available for one purchase." },
          commodity_name: { type: "string", description: "Only this commodity (exact name)." },
          origin_terminal_name: { type: "string", description: "Start at this terminal." },
          origin_planet_name: { type: "string", description: "Start on this planet (exact name)." },
          origin_system_name: {
            type: "string",
            description: "Stay in this system (e.g. 'Stanton').",
          },
          avoid_pyro: { type: "boolean", description: "Leave every Pyro terminal out." },
          armistice_only: {
            type: "boolean",
            description: "Only stops that UEX flags as armistice zones (unknown counts as no).",
          },
          max_legs: {
            type: "number",
            enum: [1, 2],
            description:
              "1 = one-way routes only (needs an origin); 2 (default) = also round trips and two-leg chains.",
          },
          max_age_days: {
            type: "number",
            description: "Leave out prices older than this (default 7).",
          },
          include_stale: {
            type: "boolean",
            description: "Keep old prices, flagged stale (default false).",
          },
          min_reports: {
            type: "number",
            description: "Drop options with fewer player reports than this at an end (default 0).",
          },
          stop_minutes: {
            type: "number",
            description: "Assumed minutes per stop (landing, terminal, takeoff). Default 8.",
          },
          limit: { type: "number", description: "Options to return (default 8, max 20)." },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const a = z
          .object({
            objective: z.enum(["profit_per_hour", "profit", "speed", "safety"]).optional(),
            ship_name: z.string().optional(),
            cargo_scu: z.number().optional(),
            quantum_speed_ms: z.number().optional(),
            budget: z.number().optional(),
            commodity_name: z.string().optional(),
            origin_terminal_name: z.string().optional(),
            origin_planet_name: z.string().optional(),
            origin_system_name: z.string().optional(),
            avoid_pyro: z.boolean().optional(),
            armistice_only: z.boolean().optional(),
            max_legs: z.union([z.literal(1), z.literal(2)]).optional(),
            max_age_days: z.number().optional(),
            include_stale: z.boolean().optional(),
            min_reports: z.number().optional(),
            stop_minutes: z.number().optional(),
            limit: z.number().optional(),
          })
          .parse(args || {});
        let result;
        try {
          result = await planTrips(
            { uexClient, scwClient },
            {
              objective: a.objective,
              shipName: a.ship_name,
              cargoScu: a.cargo_scu,
              quantumSpeedMs: a.quantum_speed_ms,
              budget: a.budget,
              origin: {
                terminalName: a.origin_terminal_name,
                planetName: a.origin_planet_name,
                systemName: a.origin_system_name,
                commodityName: a.commodity_name,
              },
              avoidPyro: a.avoid_pyro,
              armisticeOnly: a.armistice_only,
              maxLegs: a.max_legs,
              maxAgeDays: a.max_age_days,
              includeStale: a.include_stale,
              minReports: a.min_reports,
              stopMinutes: a.stop_minutes,
              limit: a.limit,
            },
          );
        } catch (error) {
          if (error instanceof TripPlanError) throw new Error(error.message, { cause: error });
          throw error;
        }
        const { options, chains, ...rest } = forModelTool(result);
        return ok(
          fitted(
            (n) => ({
              ...rest,
              options_returned: Math.min(n, options.length),
              options: options.slice(0, n),
              chains_returned: Math.min(n, chains.length),
              chains: chains.slice(0, n),
            }),
            Math.max(options.length, chains.length),
          ),
        );
      },
    },
  ];
}
