import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { remoteText } from "../core/untrusted.js";
import { reportRowDates } from "../providers/uex/freshness.js";
import {
  attributeViews,
  compareAttributes,
  ITEM_STALE_DAYS,
  itemView,
  matchCategories,
  matchItems,
  summarisePrices,
} from "../providers/uex/items.js";
import { asRows, boundedLimit, type Row } from "../providers/uex/rows.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/*
 * Why these tools never call UEX's `items_prices_all`: it dumps every shop price of every item (about
 * 24,000 rows, 6.4 MB), which is far over the output budget, slow, and cached for hours; the rows
 * of one item are 8 KB through `items_prices?id_item=`. Prices there (and elsewhere) can also be
 * two to three months old, so every row below carries its own age and a stale flag.
 *
 * `items` itself refuses a call without a filter, hence the category: the catalogue of one
 * category is 30 to 300 KB, filtered here by name.
 */

const json = (payload: unknown): ToolResult => ({
  // Not formatOutput: ids, zero and stale=false are information here.
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

/** UEX's LIVE game version, or null when it cannot say (then no row is called older than LIVE). */
async function liveVersion(uexClient: HttpClient): Promise<unknown> {
  try {
    const versions = await fetchWithCache(uexClient, "/game_versions", undefined, {
      record: false,
    });
    return versions.data?.data?.live ?? null;
  } catch {
    return null;
  }
}

/** The catalogue rows of the categories a typed category name stands for. */
async function categoryRows(uexClient: HttpClient, category: string): Promise<Row[]> {
  const categories = asRows((await fetchWithCache(uexClient, "/categories")).data.data);
  const match = matchCategories(categories, category);
  if (match.kind === "none") {
    throw new Error(
      `No UEX item category matches "${category}". Categories: ${remoteText(match.suggestions.join("; "), "uex")}.`,
    );
  }
  if (match.kind === "too_many") {
    throw new Error(
      `"${category}" covers too many categories (${remoteText(match.categories.map((c) => String(c.name)).join("; "), "uex")}). Name one of them.`,
    );
  }
  const lists = await Promise.all(
    match.categories.map((c) =>
      fetchWithCache(uexClient, "/items", { params: { id_category: c.id } }),
    ),
  );
  return lists.flatMap((l) => asRows(l.data.data));
}

const describeItem = (i: Row) =>
  `${String(i.name)} (${String(i.company_name ?? "unknown maker")}, size ${String(i.size ?? "n/a")})`;

export function uexItemTools({ uexClient }: { uexClient: HttpClient }): ToolDefinition[] {
  return [
    {
      name: "uex_get_item_prices",
      description:
        "Find a ship component, weapon, armor piece or food in UEX and say where to buy it cheapest. Needs `item_name` and its `category` (UEX item category: 'Quantum Drives', 'Shield Generators', 'Power Plants', 'Coolers', 'Guns', 'Missiles', 'Personal Weapons', 'Torso', 'Helmets', 'Foods'...). Returns the matching items, then per item the places that sell it (cheapest first) and the places that buy it, each with updated_at, data_age_days and a stale flag (older than 30 days) plus whether its game version is older than LIVE. Shop prices move rarely but rows can be months old: read the flags. Optional stats via with_attributes. To compare two items use uex_compare_items.",
      inputSchema: {
        type: "object",
        properties: {
          item_name: {
            type: "string",
            description:
              "Words of the item name (e.g. 'Burst', 'FR-66', 'P4-AR'). A close spelling is tried when nothing matches exactly.",
          },
          category: {
            type: "string",
            description:
              "UEX item category or section (e.g. 'Quantum Drives', 'Guns', 'Foods'). At most four categories are opened; a wrong name returns the list.",
          },
          company: { type: "string", description: "Optional: maker name (e.g. 'ArcCorp')." },
          size: { type: "number", description: "Optional: item size (e.g. 1, 2, 3)." },
          star_system_name: {
            type: "string",
            description: "Optional: only terminals in this system (exact, e.g. 'Stanton').",
          },
          limit: {
            type: "number",
            description: "Items to price when several match (default 3, max 8).",
          },
          locations: {
            type: "number",
            description: "Rows per side, buy and sell, per item (default 8, max 25).",
          },
          with_attributes: {
            type: "boolean",
            description:
              "Add the item's stats from UEX (one more request per item). Default false.",
          },
        },
        required: ["item_name", "category"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const {
          item_name,
          category,
          company,
          size,
          star_system_name,
          limit,
          locations,
          with_attributes,
        } = z
          .object({
            item_name: z.string(),
            category: z.string(),
            company: z.string().optional(),
            size: z.number().optional(),
            star_system_name: z.string().optional(),
            limit: z.number().optional(),
            locations: z.number().optional(),
            with_attributes: z.boolean().optional(),
          })
          .parse(args);
        const now = Date.now();
        const items = await categoryRows(uexClient, category);
        const { hits, loose } = matchItems(items, item_name, { company, size });
        if (hits.length === 0) {
          return json({
            query: { item_name, category },
            matched: 0,
            note: `No item named "${item_name}" in "${category}"${company ? ` from "${company}"` : ""}${size !== undefined ? ` of size ${size}` : ""}, even allowing for typos. Check the category, or search with fewer words.`,
          });
        }
        const live = await liveVersion(uexClient);
        const priced = hits.slice(0, boundedLimit(limit, 3, 8));
        const top = boundedLimit(locations, 8, 25);
        const used: Row[] = [];
        const out: unknown[] = [];
        for (const item of priced) {
          const priceRows = asRows(
            (await fetchWithCache(uexClient, "/items_prices", { params: { id_item: item.id } }))
              .data.data,
          );
          const { summary, used: shown } = summarisePrices(
            priceRows,
            now,
            live,
            top,
            star_system_name,
          );
          used.push(...shown);
          let attributes: unknown = undefined;
          if (with_attributes) {
            const attrRows = asRows(
              (
                await fetchWithCache(uexClient, "/items_attributes", {
                  params: { id_item: item.id },
                })
              ).data.data,
            );
            attributes = attributeViews(attrRows);
          }
          out.push({
            item: itemView(item),
            ...summary,
            ...(attributes ? { attributes } : {}),
            ...(summary.buy_locations_total === 0
              ? {
                  note: "No terminal in UEX sells this item (it may be a reward, a loot item or sold only for real money).",
                }
              : {}),
          });
        }
        reportRowDates(used, "item price rows");
        const rest = hits.slice(priced.length);
        return json({
          query: { item_name, category, company, size, star_system_name },
          ...(loose
            ? { note: `No exact match for "${item_name}": these are the closest names.` }
            : {}),
          matched: hits.length,
          priced: priced.length,
          ...(rest.length
            ? {
                other_matches: rest.slice(0, 15).map(describeItem),
                other_matches_note: `${rest.length} more matched; narrow with company, size or the full name to price them.`,
              }
            : {}),
          stale_after_days: ITEM_STALE_DAYS,
          price_note:
            "Shop prices from players' reports: stable between patches but not live. stale = older than 30 days; older_than_live = the row's game version is older than UEX's LIVE version.",
          items: out,
        });
      },
    },
    {
      name: "uex_compare_items",
      description:
        "Compare two shop items side by side with UEX stats and prices: each attribute (size, grade, mass, speed, damage reduction...) with the difference when both are numbers in the same unit, and each item's cheapest place to buy with its age and stale flag. Give both names and their category (e.g. 'Quantum Drives', 'Shield Generators', 'Guns'); category_b if the second item is in another one. It does not say which value is better (UEX does not), only the numbers. A name that fits several items (sizes, makers) is listed so you can narrow it with size_a, size_b.",
      inputSchema: {
        type: "object",
        properties: {
          item_a: { type: "string", description: "First item name (e.g. 'Burst')." },
          item_b: { type: "string", description: "Second item name (e.g. 'Voyage')." },
          category: {
            type: "string",
            description:
              "UEX item category of the first item (and of the second unless category_b).",
          },
          category_b: { type: "string", description: "Optional: category of the second item." },
          size_a: { type: "number", description: "Optional: size of the first item." },
          size_b: { type: "number", description: "Optional: size of the second item." },
        },
        required: ["item_a", "item_b", "category"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { item_a, item_b, category, category_b, size_a, size_b } = z
          .object({
            item_a: z.string(),
            item_b: z.string(),
            category: z.string(),
            category_b: z.string().optional(),
            size_a: z.number().optional(),
            size_b: z.number().optional(),
          })
          .parse(args);
        const now = Date.now();

        const resolve = (rows: Row[], name: string, size: number | undefined, label: string) => {
          const { hits } = matchItems(rows, name, { size });
          if (hits.length === 0) throw new Error(`No item "${name}" found for ${label}.`);
          if (hits.length === 1) return hits[0];
          const exact = hits.filter(
            (h) => String(h.name).toLowerCase() === name.trim().toLowerCase(),
          );
          if (exact.length === 1) return exact[0];
          throw new Error(
            `"${name}" fits several items (${remoteText(hits.slice(0, 8).map(describeItem).join("; "), "uex")}). Say which one (size_a / size_b, or the full name).`,
          );
        };
        const rowsA = await categoryRows(uexClient, category);
        const rowsB = category_b ? await categoryRows(uexClient, category_b) : rowsA;
        const a = resolve(rowsA, item_a, size_a, "the first item");
        const b = resolve(rowsB, item_b, size_b, "the second item");
        if (a.id === b.id)
          throw new Error("Both names point to the same item. Give two different items.");

        const live = await liveVersion(uexClient);
        const load = async (item: Row) => {
          const attrRows = asRows(
            (await fetchWithCache(uexClient, "/items_attributes", { params: { id_item: item.id } }))
              .data.data,
          );
          const priceRows = asRows(
            (await fetchWithCache(uexClient, "/items_prices", { params: { id_item: item.id } }))
              .data.data,
          );
          const { summary, used } = summarisePrices(priceRows, now, live, 3);
          return { attrs: attributeViews(attrRows), summary, used };
        };
        const [la, lb] = [await load(a), await load(b)];
        // Only the price rows date the answer: the attribute rows are datamined stats, a different clock.
        reportRowDates([...la.used, ...lb.used], "item price rows");

        const pa = la.summary.cheapest;
        const pb = lb.summary.cheapest;
        return json({
          items: { a: itemView(a), b: itemView(b) },
          ...(a.id_category !== b.id_category
            ? {
                note: "The two items are in different categories: only attributes with the same name are compared.",
              }
            : {}),
          attributes: compareAttributes(la.attrs, lb.attrs),
          attributes_note:
            "difference = b minus a, only for numbers in the same unit. UEX does not say whether a higher value is better; read each stat for what it means.",
          prices: {
            a: {
              cheapest: pa,
              cheapest_not_stale: la.summary.cheapest_not_stale,
              places_selling: la.summary.buy_locations_total,
            },
            b: {
              cheapest: pb,
              cheapest_not_stale: lb.summary.cheapest_not_stale,
              places_selling: lb.summary.buy_locations_total,
            },
            cheapest_price_difference_b_minus_a: pa && pb ? pb.price - pa.price : null,
            stale_after_days: ITEM_STALE_DAYS,
            note: "Prices are shop prices from players' reports; check stale and older_than_live before relying on a difference.",
          },
        });
      },
    },
  ];
}
