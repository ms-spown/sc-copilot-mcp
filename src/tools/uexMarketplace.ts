import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { setDataAgeUnknown, setDataDates } from "../core/provenance.js";
import { remoteText } from "../core/untrusted.js";
import { reportRowDates } from "../providers/uex/freshness.js";
import {
  averageViews,
  byNegotiations,
  HISTORY_CAP,
  type HistoryGroup,
  OPERATION_NOTE,
  pickTrendItem,
  priceCheck,
  summariseHistory,
  trendViews,
} from "../providers/uex/marketplace.js";
import { asRows, boundedLimit, toNumber, type Row } from "../providers/uex/rows.js";
import { fitSteps, halvings } from "./uexBounds.js";
import type { ToolDefinition, ToolResult } from "./types.js";

// Every string of an untrusted_text answer is cut at 200 characters (maxText in the catalog), our own notes
// and warnings included: keep each one under 200 characters (a test fails on any "[truncated" marker).

/**
 * The player marketplace price guide. The text of adverts is never returned (that is
 * uex_search_marketplace); this tool returns prices and the item's catalogue name only. It is
 * still declared untrusted_text in the catalog: item names are UEX's, but the data is player-driven.
 * UEX's `marketplace_averages` is deprecated (since 2026-04-12) and is not used.
 */
export function uexMarketplaceTools({ uexClient }: { uexClient: HttpClient }): ToolDefinition[] {
  return [
    {
      name: "uex_get_marketplace_prices",
      description:
        "Price guide for the UEX player marketplace (items players trade for aUEC: scrips, gear, favours). With `item_name` or `id_item`: the average price per quality tier and per side (players offering vs wanting), the 30-day trend, and with include_history a summary of recent adverts (lowest, median, highest). Prices are normalised to numbers and kept apart by unit: a 'set', 'pack' or 'stack' price is a bundle, never comparable with a per-unit price. Without an item: the most traded items. Optional `check_price` places your price against the recent average. Player-driven data (untrusted_text). For the adverts themselves use uex_search_marketplace; for shop prices uex_get_item_prices.",
      inputSchema: {
        type: "object",
        properties: {
          item_name: {
            type: "string",
            description:
              "Item name or part of it (e.g. 'MG Scrip', 'Wikelo'). Must be unique or exact; several matches are listed.",
          },
          id_item: {
            type: "number",
            description: "UEX item id, when known (wins over item_name).",
          },
          operation: {
            type: "string",
            enum: ["buy", "sell"],
            description:
              "Optional: one side only. 'sell' = players offering the item (what you pay), 'buy' = players wanting it (what you are paid).",
          },
          quality_tier: {
            type: "number",
            description: "Optional: one quality tier (0 = unqualified).",
          },
          include_history: {
            type: "boolean",
            description:
              "Add a summary of recent adverts (price changes of the last 30 days). Heavy: UEX sends up to 1000 rows and the summary then covers only the newest ones, which it says. Default false.",
          },
          check_price: {
            type: "number",
            description:
              "Optional: a price per unit to place against the recent average (needs operation).",
          },
          limit: {
            type: "number",
            description: "Without an item: how many of the most traded items (default 15, max 50).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { item_name, id_item, operation, quality_tier, include_history, check_price, limit } =
          z
            .object({
              item_name: z.string().optional(),
              id_item: z.number().int().positive().optional(),
              operation: z.enum(["buy", "sell"]).optional(),
              quality_tier: z.number().int().min(0).optional(),
              include_history: z.boolean().optional(),
              check_price: z.number().positive().optional(),
              limit: z.number().optional(),
            })
            .parse(args || {});
        const now = Date.now();

        if (check_price !== undefined && !operation) {
          throw new Error(
            "check_price needs `operation` ('sell' to compare with what players ask, 'buy' with what they offer to pay).",
          );
        }

        // No item: the most traded items. The endpoint has no date field.
        if (id_item === undefined && !item_name?.trim()) {
          const rows = asRows((await fetchWithCache(uexClient, "/marketplace_trends")).data.data);
          const shown = byNegotiations(rows).slice(0, boundedLimit(limit, 15, 50));
          setDataAgeUnknown(
            "UEX's marketplace_trends has no date field; cache_age only says when this server fetched it",
          );
          const views = trendViews(shown);
          return fitSteps(halvings(views.length), (n, i) => ({
            mode: "most_traded_items",
            total_in_trends: rows.length,
            shown: Math.min(n, views.length),
            ...(i > 0
              ? {
                  truncated: `Cut to fit the output size: ${n} of the ${views.length} items asked for.`,
                }
              : {}),
            note: "UEX caps its trend list at 500 items. Trend prices carry no unit: an item sold in bundles can show a bundle price.",
            operation_note: OPERATION_NOTE,
            items: views.slice(0, n),
          }));
        }

        // Find the item: by id, or by name in UEX's trend list (the name filter is a substring match).
        let itemId = id_item;
        let trendRows: Row[];
        if (itemId !== undefined) {
          trendRows = asRows(
            (
              await fetchWithCache(uexClient, "/marketplace_trends", {
                params: { id_item: itemId },
              })
            ).data.data,
          );
        } else {
          const name = (item_name as string).trim();
          trendRows = asRows(
            (
              await fetchWithCache(uexClient, "/marketplace_trends", {
                params: { item_name: name },
              })
            ).data.data,
          );
          const found = pickTrendItem(trendRows, name);
          if (found.kind === "none") {
            throw new Error(
              `No traded item matches "${name}" in UEX's marketplace trends. Give id_item (from uex_get_item_prices) or another spelling.`,
            );
          }
          if (found.kind === "several") {
            const names = found.rows
              .slice(0, 10)
              .map((r) => `${String(r.item_name)} (id ${String(r.id_item)})`)
              .join("; ");
            throw new Error(
              `"${name}" matches several items (${remoteText(names, "uex")}). Say which one, or give id_item.`,
            );
          }
          itemId = toNumber(found.row.id_item) ?? undefined;
          trendRows = [found.row];
        }
        if (itemId === undefined) throw new Error("UEX gave no id for that item.");

        // Filtered here as well as asked of UEX: the averages endpoint is only known to take the item filter.
        const wanted = (r: Row) =>
          (operation === undefined || r.operation === operation) &&
          (quality_tier === undefined || toNumber(r.quality_tier) === quality_tier);
        const averagesRows = asRows(
          (
            await fetchWithCache(uexClient, "/marketplace_prices_averages", {
              params: { id_item: itemId },
            })
          ).data.data,
        ).filter(wanted);
        const averages = averageViews(averagesRows, now);
        reportRowDates(averagesRows, "marketplace average rows");

        let history:
          | {
              rows_received: number;
              truncated: boolean;
              truncated_note?: string;
              window: string;
              groups: HistoryGroup[];
            }
          | undefined = undefined;
        if (include_history) {
          const received = asRows(
            (
              await fetchWithCache(uexClient, "/marketplace_prices_history", {
                params: { id_item: itemId, operation, quality_tier },
              })
            ).data.data,
          );
          const histRows = received.filter(wanted);
          const summary = summariseHistory(histRows, received.length);
          if (summary.newest_ms !== null && summary.oldest_ms !== null) {
            setDataDates(
              summary.oldest_ms,
              summary.newest_ms,
              `UEX date_added of the ${histRows.length} marketplace history rows (when each advert was posted)`,
            );
          }
          history = {
            rows_received: summary.rows_received,
            truncated: summary.truncated,
            ...(summary.truncated
              ? {
                  truncated_note: `UEX returned its maximum of ${HISTORY_CAP} rows (newest first): older adverts are missing and these statistics cover the newest ones only. Add operation or quality_tier to narrow it.`,
                }
              : {}),
            window: "UEX's default: the last 30 days.",
            groups: summary.groups,
          };
        }

        const trend = trendViews(trendRows);
        const groups = history?.groups ?? [];
        // A category-wide average list or a history with many groups can be long: cut both together, say so.
        return fitSteps(halvings(Math.max(averages.length, groups.length, 1)), (n, i) => ({
          item: trend[0]?.item ?? averagesRows[0]?.item_name ?? null,
          id_item: itemId,
          operation_note: OPERATION_NOTE,
          unit_note:
            "unit = price per item. Any other unit (set, pack, stack, crate) is a bundle of an unstated number of items: never compare it with a per-unit price.",
          ...(i > 0
            ? {
                truncated: `Cut to fit the output size: ${Math.min(n, averages.length)} of ${averages.length} average lines${history ? ` and ${Math.min(n, groups.length)} of ${groups.length} history groups` : ""} shown. Add operation or quality_tier to narrow it.`,
              }
            : {}),
          averages: averages.slice(0, n),
          ...(averages.length === 0
            ? { note: "UEX has no average for this item with those filters." }
            : {}),
          trend: trend[0] ?? null,
          ...(check_price !== undefined && operation
            ? { price_check: priceCheck(averages, check_price, operation, quality_tier ?? 0) }
            : {}),
          ...(history ? { history: { ...history, groups: groups.slice(0, n) } } : {}),
        }));
      },
    },
  ];
}
