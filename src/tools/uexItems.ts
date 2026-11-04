import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { remoteText } from "../core/untrusted.js";
import { reportRowDates } from "../providers/uex/freshness.js";
import {
  attributeViews,
  compareAttributes,
  ITEM_STALE_DAYS,
  itemCategories,
  itemView,
  MAX_CATEGORIES,
  matchCategories,
  matchItems,
  summarisePrices,
} from "../providers/uex/items.js";
import { asRows, boundedLimit, type Row } from "../providers/uex/rows.js";
import { fitSteps, halvings } from "./uexBounds.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/*
 * Why these tools never call UEX's `items_prices_all`: it dumps every shop price of every item (about
 * 24,000 rows, 6.4 MB), which is far over the output budget, slow, and cached for hours; the rows
 * of one item are 8 KB through `items_prices?id_item=`. Prices there (and elsewhere) can also be
 * two to three months old, so every row below carries its own age and a stale flag.
 *
 * `items` itself refuses a call without a filter, hence the category: the catalogue of one
 * category is 30 to 300 KB, filtered here by name.
 *
 * Requests per call (UEX allows 100 a minute to the whole server, shared with every other UEX tool):
 * uex_get_item_prices at most 1 (categories) + 3 (one catalogue per category) + 1 (game versions) + 4 items
 * x 2 (prices, attributes) = 13, usually 5 to 8; uex_compare_items at most 1 + 3 + 3 + 1 + 4 = 12. All of
 * them are cached for 5 minutes, so a second question on the same category costs only the item calls.
 *
 * Every string of an untrusted_text answer is cut at 200 characters (maxText in the catalog), our own notes
 * and warnings included: keep each one under 200 characters (a test fails on any "[truncated" marker).
 */

const MAX_ITEMS_PRICED = 4;
const MAX_LOCATIONS = 15;

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

type CategoryResult =
  { ok: true; rows: Row[] } | { ok: false; problem: "unknown" | "too_many"; names: string[] };

/** The catalogue rows of the categories a typed category name stands for, or the category names to choose from. */
async function categoryRows(uexClient: HttpClient, category: string): Promise<CategoryResult> {
  const categories = asRows((await fetchWithCache(uexClient, "/categories")).data.data);
  const match = matchCategories(categories, category);
  if (match.kind === "none") {
    return {
      ok: false,
      problem: "unknown",
      names: itemCategories(categories).map((c) => String(c.name)),
    };
  }
  if (match.kind === "too_many") {
    return { ok: false, problem: "too_many", names: match.categories.map((c) => String(c.name)) };
  }
  const lists = await Promise.all(
    match.categories.map((c) =>
      fetchWithCache(uexClient, "/items", { params: { id_category: c.id } }),
    ),
  );
  return { ok: true, rows: lists.flatMap((l) => asRows(l.data.data)) };
}

/** A category problem as a sentence for an error: a few names, and how many are left out. */
function categoryError(category: string, problem: Extract<CategoryResult, { ok: false }>): Error {
  const shown = problem.names.slice(0, 10);
  const more = problem.names.length - shown.length;
  const head =
    problem.problem === "unknown"
      ? `No UEX item category matches "${category}". Some categories`
      : `"${category}" covers more than ${MAX_CATEGORIES} categories. They are`;
  return new Error(
    `${head}: ${remoteText(shown.join("; "), "uex")}${more > 0 ? ` and ${more} more` : ""}. Name one category.`,
  );
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
              "UEX item category or section (e.g. 'Quantum Drives', 'Guns', 'Foods'). At most three categories are opened. An unknown or too wide name returns the list of categories in `categories`.",
          },
          company: { type: "string", description: "Optional: maker name (e.g. 'ArcCorp')." },
          size: { type: "number", description: "Optional: item size (e.g. 1, 2, 3)." },
          star_system_name: {
            type: "string",
            description: "Optional: only terminals in this system (exact, e.g. 'Stanton').",
          },
          limit: {
            type: "number",
            description: `Items to price when several match (default 3, max ${MAX_ITEMS_PRICED}).`,
          },
          locations: {
            type: "number",
            description: `Rows per side, buy and sell, per item (default 8, max ${MAX_LOCATIONS}). The answer is cut, and says so, if it would be too large.`,
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
        const catalogue = await categoryRows(uexClient, category);
        if (!catalogue.ok) {
          // A bounded list of its own (strings of a few words), not an error text cut by the sanitizer.
          return fitSteps([0], () => ({
            query: { item_name, category },
            matched: 0,
            category_problem:
              catalogue.problem === "unknown"
                ? "No UEX item category matches that name. Pick one from `categories`."
                : `That name covers more than ${MAX_CATEGORIES} categories. Pick one from \`categories\`.`,
            categories: catalogue.names,
          }));
        }
        const { hits, loose } = matchItems(catalogue.rows, item_name, { company, size });
        if (hits.length === 0) {
          return fitSteps([0], () => ({
            query: { item_name, category },
            matched: 0,
            note: `No item named "${item_name}" in "${category}"${company ? ` from "${company}"` : ""}${size !== undefined ? ` of size ${size}` : ""}, even allowing for typos. Check the category, or search with fewer words.`,
          }));
        }
        const live = await liveVersion(uexClient);
        const priced = hits.slice(0, boundedLimit(limit, 3, MAX_ITEMS_PRICED));
        const top = boundedLimit(locations, 8, MAX_LOCATIONS);
        const used: Row[] = [];
        const full: {
          item: ReturnType<typeof itemView>;
          summary: ReturnType<typeof summarisePrices>["summary"];
          attributes?: ReturnType<typeof attributeViews>;
        }[] = [];
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
          const attributes = with_attributes
            ? attributeViews(
                asRows(
                  (
                    await fetchWithCache(uexClient, "/items_attributes", {
                      params: { id_item: item.id },
                    })
                  ).data.data,
                ),
              )
            : undefined;
          full.push({ item: itemView(item), summary, attributes });
        }
        reportRowDates(used, "item price rows");
        const rest = hits.slice(priced.length);

        // Fullest first; then fewer places per side, then no attributes, then one item: the first that fits.
        const steps = [
          ...halvings(top).map((rows) => ({ rows, attrs: true, items: full.length })),
          { rows: 1, attrs: false, items: full.length },
          ...(full.length > 1 ? [{ rows: 1, attrs: false, items: 1 }] : []),
        ];
        return fitSteps(steps, (step, i) => ({
          query: { item_name, category, company, size, star_system_name },
          ...(loose
            ? { note: `No exact match for "${item_name}": these are the closest names.` }
            : {}),
          matched: hits.length,
          priced: priced.length,
          ...(i > 0
            ? {
                truncated: `Cut to fit the output size: ${step.rows} places per side, ${step.items} of ${full.length} items${step.attrs ? "" : ", no attributes"}. Ask for fewer items or locations, or name a star system.`,
              }
            : {}),
          ...(rest.length
            ? {
                other_matches: rest.slice(0, 15).map(describeItem),
                other_matches_note: `${rest.length} more matched; narrow with company, size or the full name to price them.`,
              }
            : {}),
          stale_after_days: ITEM_STALE_DAYS,
          price_note:
            "Shop prices from players' reports: stable between patches but not live. stale = older than 30 days; older_than_live = the row's game version is older than UEX's LIVE version.",
          items: full.slice(0, step.items).map(({ item, summary, attributes }) => ({
            item,
            ...summary,
            buy_locations: summary.buy_locations.slice(0, step.rows),
            sell_locations: summary.sell_locations.slice(0, step.rows),
            ...(step.attrs && attributes ? { attributes } : {}),
            ...(summary.buy_locations_total === 0
              ? {
                  note: "No terminal in UEX sells this item (it may be a reward, a loot item or sold only for real money).",
                }
              : {}),
          })),
        }));
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
        const catA = await categoryRows(uexClient, category);
        if (!catA.ok) throw categoryError(category, catA);
        let rowsB = catA.rows;
        if (category_b) {
          const catB = await categoryRows(uexClient, category_b);
          if (!catB.ok) throw categoryError(category_b, catB);
          rowsB = catB.rows;
        }
        const a = resolve(catA.rows, item_a, size_a, "the first item");
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
        const attributes = compareAttributes(la.attrs, lb.attrs);
        return fitSteps(halvings(Math.max(attributes.length, 1)), (n, i) => ({
          items: { a: itemView(a), b: itemView(b) },
          ...(a.id_category !== b.id_category
            ? {
                note: "The two items are in different categories: only attributes with the same name are compared.",
              }
            : {}),
          ...(i > 0
            ? {
                truncated: `Cut to fit the output size: ${n} of ${attributes.length} attributes shown.`,
              }
            : {}),
          attributes: attributes.slice(0, n),
          attributes_note:
            "difference = b minus a, only for numbers in the same unit. UEX does not say whether a higher value is better; read each stat for what it means.",
          ...(attributes.some((x) => x.repeated_in.length > 0)
            ? {
                repeated_note:
                  "An attribute listed more than once on an item (repeated_in) shows its first value and is not compared.",
              }
            : {}),
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
        }));
      },
    },
  ];
}
