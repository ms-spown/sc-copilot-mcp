import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { remoteText } from "../core/untrusted.js";
import { reportRowDates } from "../providers/uex/freshness.js";
import {
  capacityByTerminal,
  groupOres,
  matchOre,
  methodRows,
  oreSalePrices,
  rankOres,
  rankRefineries,
  refinedReferencePrice,
  REFINING_STALE_DAYS,
} from "../providers/uex/refining.js";
import { asRows, boundedLimit, median } from "../providers/uex/rows.js";
import { fitSteps, halvings } from "./uexBounds.js";
import type { ToolDefinition, ToolResult } from "./types.js";

// Every string of an untrusted_text answer is cut at 200 characters (maxText in the catalog), our own notes
// included: each sentence below is its own string so that no caveat is cut in half. A test checks it.
const NOT_IN_UEX = [
  "UEX has no conversion ratio from SCU of ore to SCU of refined product.",
  "It has no refining cost in aUEC and no processing time in minutes.",
  "So NO aUEC profit is computed here: this is a ranking from the yield bonus players reported.",
];

/**
 * Refining margins, from UEX only. The yield data is a bonus per (ore, refinery) reported by players;
 * the refineries_audits endpoint is NOT used: its rows carry a player's handle.
 */
export function uexRefiningTools({ uexClient }: { uexClient: HttpClient }): ToolDefinition[] {
  return [
    {
      name: "uex_get_refining_margins",
      description:
        "Which refinery is best for an ore, or which ore is worth refining most, from UEX data. With `ore` (e.g. 'Laranite', 'Quantainium'): refineries ranked by the yield bonus (percent) players reported, with each refinery's capacity value (unit unverified), the ore's sale prices at refinery ore-sales terminals and the refined product's reference sell price. Without `ore`: ores ranked by an INDEX (refined price x yield at the best refinery, best = 100), not aUEC. UEX has no ore-to-refined conversion ratio and no refining cost, so this is a RANKING, never an aUEC profit; check data_age_days and stale. Pair with scmdb_search_mining for the ore itself.",
      inputSchema: {
        type: "object",
        properties: {
          ore: {
            type: "string",
            description:
              "Ore to refine (e.g. 'Laranite', 'Gold', 'Quantainium'; '(Raw)' or '(Ore)' is optional). Omit to rank all ores.",
          },
          star_system_name: {
            type: "string",
            description:
              "Optional: only refineries in this star system (exact name, e.g. 'Stanton', 'Pyro', 'Nyx').",
          },
          limit: {
            type: "number",
            description: "Rows to return (default 10, max 30): refineries, or ores without `ore`.",
          },
          include_methods: {
            type: "boolean",
            description:
              "With `ore`: add the refining methods with UEX's 1 to 3 ratings for yield, cost and speed (default true). The ratings are not numbers of aUEC or minutes.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { ore, star_system_name, limit, include_methods } = z
          .object({
            ore: z.string().optional(),
            star_system_name: z.string().optional(),
            limit: z.number().optional(),
            include_methods: z.boolean().optional(),
          })
          .parse(args || {});
        const now = Date.now();
        const cap = boundedLimit(limit, 10, 30);

        const [yieldsRes, commoditiesRes, rawRes] = await Promise.all([
          fetchWithCache(uexClient, "/refineries_yields"),
          fetchWithCache(uexClient, "/commodities"),
          fetchWithCache(uexClient, "/commodities_raw_prices_all"),
        ]);
        const ores = groupOres(asRows(yieldsRes.data.data), asRows(commoditiesRes.data.data));
        const rawPrices = asRows(rawRes.data.data);
        if (ores.length === 0) {
          throw new Error(
            "UEX returned no refinery yield reports (refineries_yields is empty), so nothing can be ranked.",
          );
        }

        if (!ore?.trim()) {
          const { ranked, not_ranked } = rankOres(ores, rawPrices, now, star_system_name);
          const shown = ranked.slice(0, cap);
          const usedOres = new Set(shown.map((r) => r.ore));
          reportRowDates(
            ores.filter((o) => usedOres.has(o.name)).flatMap((o) => o.yields),
            "refinery yield reports",
          );
          return fitSteps(halvings(shown.length), (n, i) => ({
            mode: "ores_ranked_by_index",
            ...(i > 0
              ? {
                  truncated: `Cut to fit the output size: ${n} of the ${shown.length} ores asked for.`,
                }
              : {}),
            index_meaning: [
              "Refined product's reference sell price x (1 + best yield bonus / 100), scaled so the best ore is 100.",
              "It compares ores; it is NOT aUEC and NOT a margin.",
              "The ore-to-refined ratio and the refining cost are unknown, and ore and refined prices are not in the same unit.",
            ],
            system_filter: star_system_name ?? "all systems",
            total_ranked: ranked.length,
            shown: Math.min(n, shown.length),
            ores: shown.slice(0, n),
            not_ranked: not_ranked.slice(0, Math.max(n, 5)),
            what_uex_does_not_have: NOT_IN_UEX,
            refined_reference_price:
              "From UEX's commodity list: an average sell price across terminals, undated. For real sell terminals use uex_get_commodity_prices.",
            stale_after_days: REFINING_STALE_DAYS,
          }));
        }

        const found = matchOre(ores, ore);
        if (found.kind === "several") {
          throw new Error(
            `"${ore}" matches several ores (${remoteText(found.candidates.map((o) => o.name).join("; "), "uex")}). Say which one.`,
          );
        }
        if (found.kind === "none") {
          throw new Error(
            `No ore called "${ore}" has refinery yield reports in UEX. Ores with reports: ${remoteText(found.suggestions.join("; "), "uex")}.`,
          );
        }
        const chosen = found.ore;
        const [capacitiesRes, methodsRes] = await Promise.all([
          fetchWithCache(uexClient, "/refineries_capacities"),
          include_methods === false
            ? Promise.resolve(null)
            : fetchWithCache(uexClient, "/refineries_methods"),
        ]);
        const capacities = capacityByTerminal(asRows(capacitiesRes.data.data));
        const { rows, source } = rankRefineries(chosen, capacities, now, star_system_name);
        const shown = rows.slice(0, cap);
        reportRowDates(source.slice(0, cap), "refinery yield reports");

        const bonuses = rows.map((r) => r.yield_bonus_percent);
        const refinedPrice = refinedReferencePrice(chosen.refined);
        return fitSteps(halvings(shown.length), (n, i) => ({
          mode: "refineries_ranked_for_one_ore",
          ...(i > 0
            ? {
                truncated: `Cut to fit the output size: ${n} of the ${shown.length} refineries asked for.`,
              }
            : {}),
          ore: chosen.name,
          ...(found.loose
            ? { note: `No exact match for "${ore}": showing the closest ore, ${chosen.name}.` }
            : {}),
          system_filter: star_system_name ?? "all systems",
          refined_product: chosen.refined
            ? {
                name: chosen.refined.name,
                reference_sell_price: refinedPrice,
                reference_price_is:
                  "UEX's commodity list: an average across terminals, undated. For sell terminals use uex_get_commodity_prices.",
              }
            : "UEX does not link this ore to a refined product.",
          refineries: {
            total: rows.length,
            shown: Math.min(n, shown.length),
            sorted_by: "yield_bonus_percent, highest first; equal bonuses share a rank.",
            yield_bonus_note:
              "A bonus relative to the game's base yield, reported by players (percent per UEX).",
            capacity_note:
              "capacity_value is shown as UEX gives it; its unit is unverified (UEX's docs say percentage, values reach 1075). It is NOT used to rank.",
            yield_bonus_spread: rows.length
              ? { best: Math.max(...bonuses), median: median(bonuses), worst: Math.min(...bonuses) }
              : null,
            rows: shown.slice(0, n),
          },
          ore_sale_prices_at_refineries: oreSalePrices(rawPrices, chosen.id, now),
          ore_sale_prices_note:
            "What a refinery's ore-sales terminal pays for the raw ore (commodities_raw_prices_all): patchy, often old, unit not stated by UEX. Not comparable with the refined price per unit.",
          ...(methodsRes
            ? {
                methods: {
                  note: "UEX's ratings from 1 to 3 per refining method; the direction of each scale is not stated by UEX. They are not numbers of aUEC or minutes, and UEX dates them October 2023.",
                  rows: methodRows(asRows(methodsRes.data.data)),
                },
              }
            : {}),
          what_uex_does_not_have: NOT_IN_UEX,
          stale_after_days: REFINING_STALE_DAYS,
        }));
      },
    },
  ];
}
