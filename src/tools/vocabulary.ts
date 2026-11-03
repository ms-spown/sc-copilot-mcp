import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { formatOutput } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import { collectLabels, GAME_DATA_DIR } from "../providers/local/localdata.js";
import { fetchAllPages as fetchAllScwPages } from "../providers/wiki/pagination.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** One tool that merges names from UEX, the wiki and local data, so it needs all three. */
export function vocabularyTools({
  uexClient,
  scwClient,
}: {
  uexClient: HttpClient;
  scwClient: HttpClient;
}): ToolDefinition[] {
  const fetchAllPages = (endpoint: string, params: Record<string, unknown> = {}) =>
    fetchAllScwPages(scwClient, endpoint, params);

  return [
    {
      name: "sc_get_vocabulary",
      description:
        "Distinct in-game names for biasing a speech recognizer's initial prompt - commodities, manufacturers, FPS and ship weapons, weapon attachments, and (when SCMCP_GAME_DATA_DIR is set) locally extracted names like ore signatures, blueprints, and Wikelo trades no public API exposes. Local and public sources are merged; local is preferred when both exist for the same term. Armor and clothes are excluded by default - thousands of cosmetic colour variants that dilute the prompt far more than they help. Always works with no local data configured - it just returns fewer terms.",
      inputSchema: {
        type: "object",
        properties: {
          include_commodities: {
            type: "boolean",
            description: "Include tradeable commodity names from UEX Corp (default true).",
          },
          include_manufacturers: {
            type: "boolean",
            description:
              "Include ship/vehicle manufacturer names from the Star Citizen Wiki (default true).",
          },
          include_weapons: {
            type: "boolean",
            description: "Include FPS and ship weapon names, ~580 terms (default true).",
          },
          include_attachments: {
            type: "boolean",
            description:
              "Include weapon attachment names (scopes, magazines, ...), ~106 terms (default true).",
          },
          include_armor: {
            type: "boolean",
            description:
              "Include armor piece names, ~2400 terms including colour variants (default false).",
          },
          include_clothes: {
            type: "boolean",
            description:
              "Include clothing item names, ~1900 terms including colour variants (default false).",
          },
          include_components: {
            type: "boolean",
            description:
              "Include ship component names (shields, coolers, quantum drives, ...), ~3300 terms (default false).",
          },
          limit: {
            type: "number",
            description: "Cap on locally extracted labels merged in (default 1000).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const {
          include_commodities,
          include_manufacturers,
          include_weapons,
          include_attachments,
          include_armor,
          include_clothes,
          include_components,
          limit,
        } = z
          .object({
            include_commodities: z.boolean().optional(),
            include_manufacturers: z.boolean().optional(),
            include_weapons: z.boolean().optional(),
            include_attachments: z.boolean().optional(),
            include_armor: z.boolean().optional(),
            include_clothes: z.boolean().optional(),
            include_components: z.boolean().optional(),
            limit: z.number().optional(),
          })
          .parse(args || {});

        const terms = new Set<string>();
        const sources: string[] = [];

        if (GAME_DATA_DIR) {
          try {
            const local = await collectLabels(undefined, { limit });
            for (const label of local.labels) terms.add(label);
            if (local.labels.length > 0) {
              sources.push(
                `local (${local.datasets_scanned.length} datasets, ${local.labels.length} terms)`,
              );
            }
          } catch {
            // SCMCP_GAME_DATA_DIR set but unreadable - fall through to the public API only,
            // the same degrade-gracefully behavior as the rest of the local-data tools.
          }
        }

        if (include_commodities !== false) {
          try {
            const response = await fetchWithCache(uexClient, "/commodities");
            let added = 0;
            for (const row of response.data.data as Record<string, unknown>[]) {
              if (!(row.is_sellable || row.is_buyable)) continue;
              const cleaned = String(row.name)
                .replace(/\s*\((Ore|Raw)\)\s*$/, "")
                .trim();
              if (!terms.has(cleaned)) added += 1;
              terms.add(cleaned);
            }
            sources.push(`UEX commodities (${added} new terms)`);
          } catch (err) {
            sources.push(
              `UEX commodities unavailable: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (include_manufacturers !== false) {
          try {
            const response = await fetchWithCache(scwClient, "/vehicles/filters");
            // This endpoint responds {filters: {...}} directly, with no `data` wrapper -
            // unlike every other scwClient call in this file.
            const filters = response.data.filters ?? response.data.data?.filters ?? {};
            let added = 0;
            for (const entry of (filters.manufacturer ?? []) as { value?: string }[]) {
              if (!entry.value || entry.value === "Unknown") continue;
              if (!terms.has(entry.value)) added += 1;
              terms.add(entry.value);
            }
            sources.push(`SCW manufacturers (${added} new terms)`);
          } catch (err) {
            sources.push(
              `SCW manufacturers unavailable: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const itemEndpoints: [string, string, boolean][] = [
          ["weapons", "/weapons", include_weapons !== false],
          ["vehicle-weapons", "/vehicle-weapons", include_weapons !== false],
          ["weapon-attachments", "/weapon-attachments", include_attachments !== false],
          ["armor", "/armor", include_armor === true],
          ["clothes", "/clothes", include_clothes === true],
          ["vehicle-items", "/vehicle-items", include_components === true],
        ];
        for (const [label, endpoint, wanted] of itemEndpoints) {
          if (!wanted) continue;
          try {
            const rows = await fetchAllPages(endpoint);
            let added = 0;
            for (const row of rows) {
              const itemName = (row as Record<string, unknown>).name;
              if (typeof itemName !== "string" || !itemName) continue;
              if (!terms.has(itemName)) added += 1;
              terms.add(itemName);
            }
            sources.push(`SCW ${label} (${added} new terms)`);
          } catch (err) {
            sources.push(
              `SCW ${label} unavailable: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const sorted = [...terms].sort();
        return {
          content: [
            {
              type: "text",
              // The default 40k-char cap is sized for browsing tools ("show a preview,
              // narrow your query") - here completeness is the entire point, and a
              // silent partial list is actively wrong for what this is used for (biasing
              // a speech recognizer against ALL of a game's names, not a sample of them).
              // 200k comfortably covers even every category on at once (~121k measured).
              text: formatOutput(
                {
                  term_count: sorted.length,
                  sources,
                  local_data_configured: Boolean(GAME_DATA_DIR),
                  terms: sorted,
                },
                200_000,
              ),
            },
          ],
        };
      },
    },
  ];
}
