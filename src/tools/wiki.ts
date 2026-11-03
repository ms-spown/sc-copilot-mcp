import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import {
  formatOutput,
  formatRecord,
  isObject,
  optimizeData,
  summarizeItem,
  summarizeList,
  summarizeVehicle,
} from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import {
  fetchAllPages as fetchAllScwPages,
  SCW_MAX_PAGE_SIZE,
} from "../providers/wiki/pagination.js";
import {
  diffEntries,
  loadSnapshot,
  SNAPSHOT_DIR,
  snapshotFields,
  snapshotPath,
} from "../providers/wiki/snapshots.js";
import { shortPath } from "../core/paths.js";
import { cleanLabel } from "../core/untrusted.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Tools backed by the Star Citizen Wiki API, plus the local snapshots taken from it. */
export function wikiTools({ scwClient }: { scwClient: HttpClient }): ToolDefinition[] {
  const fetchAllPages = (endpoint: string, params: Record<string, unknown> = {}) =>
    fetchAllScwPages(scwClient, endpoint, params);

  return [
    {
      name: "scw_search",
      description:
        "Search page titles on the Star Citizen Wiki (star-citizen.wiki); returns up to 10 titles. Use it to find the exact name of a ship, item or topic before calling scw_get_vehicle or scw_get_item. Wiki text is community-written.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
        },
        required: ["query"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { query } = z.object({ query: z.string() }).parse(args);
        // Using MediaWiki API for search as it's more flexible for general queries
        const response = await fetchWithCache(scwClient, "https://star-citizen.wiki/api.php", {
          params: {
            action: "opensearch",
            search: query,
            format: "json",
            limit: 10,
          },
        });
        return {
          content: [{ type: "text", text: formatOutput(response.data) }],
        };
      },
    },
    {
      name: "scw_get_vehicle",
      description:
        "One ship or ground vehicle from the Star Citizen Wiki API: manufacturer, role, size, crew, cargo SCU, health, shields, speeds, price (the full record with hardpoints when it fits). Look it up by name, for example 'Carrack'. Most ships exceed the output limit, so you get the key figures (summary view) with a note; to compare several ships use scw_get_ship_comparison.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the vehicle (e.g., '300i', 'Carrack').",
          },
        },
        required: ["name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { name: vehicleName } = z.object({ name: z.string() }).parse(args);
        const response = await fetchWithCache(
          scwClient,
          `/vehicles/${encodeURIComponent(vehicleName)}`,
        );
        return {
          content: [{ type: "text", text: formatRecord(response.data.data, summarizeVehicle) }],
        };
      },
    },
    {
      name: "scw_get_item",
      description:
        "One item (weapon, armor, ship component) from the Star Citizen Wiki API, by name, for example 'FS-9 LMG': the full record, or a summary view when it is too large. To find the name use scw_search; to browse many items use scw_list_items.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the item (e.g., 'FS-9 LMG', 'Lynx Helmet').",
          },
        },
        required: ["name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { name: itemName } = z.object({ name: z.string() }).parse(args);
        const response = await fetchWithCache(scwClient, `/items/${encodeURIComponent(itemName)}`);
        return {
          content: [{ type: "text", text: formatRecord(response.data.data, summarizeItem) }],
        };
      },
    },
    {
      name: "scw_list_vehicles",
      description:
        "Browse/list ships and ground vehicles from the Star Citizen Wiki. Filter by manufacturer, role (e.g. 'Medical', 'Cargo'), career, or size. Use scw_get_filters to see all valid values.",
      inputSchema: {
        type: "object",
        properties: {
          manufacturer: {
            type: "string",
            description:
              "Optional: Manufacturer name (e.g., 'Aegis Dynamics', 'Drake Interplanetary').",
          },
          role: {
            type: "string",
            description:
              "Optional: Ship role (e.g., 'Medical', 'Cargo', 'Heavy Fighter', 'Light Mining').",
          },
          career: {
            type: "string",
            description:
              "Optional: Career category (e.g., 'Combat', 'Industrial', 'Support', 'Exploration').",
          },
          size: {
            type: "number",
            description: "Optional: Vehicle size class (1-6, 10).",
          },
          is_spaceship: {
            type: "boolean",
            description: "Optional: true for spaceships only, false for ground vehicles only.",
          },
          page: {
            type: "number",
            description: "Optional: Page number for pagination (default 1).",
          },
          per_page: {
            type: "number",
            description: "Optional: Results per page (default 20, max 50).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { manufacturer, role, career, size, is_spaceship, page, per_page } = z
          .object({
            manufacturer: z.string().optional(),
            role: z.string().optional(),
            career: z.string().optional(),
            size: z.number().optional(),
            is_spaceship: z.boolean().optional(),
            page: z.number().optional(),
            per_page: z.number().optional(),
          })
          .parse(args || {});

        const params: Record<string, unknown> = {
          // Both must use bracket form: a bare `page` silently voids `page[size]`.
          "page[number]": page ?? 1,
          "page[size]": Math.min(per_page ?? 20, SCW_MAX_PAGE_SIZE),
        };
        if (manufacturer) params["filter[manufacturer]"] = manufacturer;
        if (role) params["filter[role]"] = role;
        if (career) params["filter[career]"] = career;
        if (size !== undefined) params["filter[size]"] = size;
        if (is_spaceship !== undefined)
          params["filter[is_spaceship]"] = is_spaceship ? "Yes" : "No";

        const response = await fetchWithCache(scwClient, "/vehicles", { params });
        return {
          content: [
            { type: "text", text: formatOutput(summarizeList(response.data, summarizeVehicle)) },
          ],
        };
      },
    },
    {
      name: "scw_list_items",
      description:
        "Browse/list weapons, armor, and ship components from the Star Citizen Wiki. Pick a category endpoint and optionally filter by type, size, grade, class, or manufacturer. Use scw_get_filters to see valid values.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "items",
              "weapons",
              "weapon-attachments",
              "armor",
              "clothes",
              "food",
              "vehicle-weapons",
              "vehicle-items",
            ],
            description:
              "Which catalog to browse. 'vehicle-items' = ship components (shields, coolers, quantum drives), 'vehicle-weapons' = ship weapons, 'weapons' = FPS weapons. Defaults to 'items' (everything).",
          },
          type: {
            type: "string",
            description:
              "Optional: Item type (e.g., 'Shield', 'Cooler', 'Quantum Drive', 'Power Plant', 'Weapon Gun', 'Missile').",
          },
          sub_type: {
            type: "string",
            description: "Optional: Item sub-type (e.g., 'Gun', 'Manned Turret', 'Missile Rack').",
          },
          size: {
            type: "number",
            description: "Optional: Component size (0-12).",
          },
          grade: {
            type: "string",
            enum: ["A", "B", "C", "D"],
            description: "Optional: Component grade.",
          },
          class: {
            type: "string",
            description:
              "Optional: Component class (e.g., 'Military', 'Civilian', 'Stealth', 'Industrial', 'Competition').",
          },
          manufacturer: {
            type: "string",
            description: "Optional: Manufacturer name (e.g., 'Behring Applied Technology').",
          },
          page: {
            type: "number",
            description: "Optional: Page number for pagination (default 1).",
          },
          per_page: {
            type: "number",
            description: "Optional: Results per page (default 20, max 50).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const {
          category,
          type,
          sub_type,
          size,
          grade,
          class: itemClass,
          manufacturer,
          page,
          per_page,
        } = z
          .object({
            category: z
              .enum([
                "items",
                "weapons",
                "weapon-attachments",
                "armor",
                "clothes",
                "food",
                "vehicle-weapons",
                "vehicle-items",
              ])
              .optional(),
            type: z.string().optional(),
            sub_type: z.string().optional(),
            size: z.number().optional(),
            grade: z.enum(["A", "B", "C", "D"]).optional(),
            class: z.string().optional(),
            manufacturer: z.string().optional(),
            page: z.number().optional(),
            per_page: z.number().optional(),
          })
          .parse(args || {});

        const params: Record<string, unknown> = {
          // Both must use bracket form: a bare `page` silently voids `page[size]`.
          "page[number]": page ?? 1,
          "page[size]": Math.min(per_page ?? 20, SCW_MAX_PAGE_SIZE),
        };
        if (type) params["filter[type]"] = type;
        if (sub_type) params["filter[sub_type]"] = sub_type;
        if (size !== undefined) params["filter[size]"] = size;
        if (grade) params["filter[grade]"] = grade;
        if (itemClass) params["filter[class]"] = itemClass;
        if (manufacturer) params["filter[manufacturer]"] = manufacturer;

        const response = await fetchWithCache(scwClient, `/${category ?? "items"}`, { params });
        return {
          content: [
            { type: "text", text: formatOutput(summarizeList(response.data, summarizeItem)) },
          ],
        };
      },
    },
    {
      name: "scw_get_filters",
      description:
        "Get all valid filter names and allowed values for vehicles or items. Call this before filtering to use exact values.",
      inputSchema: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: ["vehicles", "items"],
            description: "Which dataset's filters to retrieve.",
          },
        },
        required: ["dataset"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { dataset } = z.object({ dataset: z.enum(["vehicles", "items"]) }).parse(args);
        const response = await fetchWithCache(scwClient, `/${dataset}/filters`);
        return {
          content: [{ type: "text", text: formatOutput(response.data.data ?? response.data) }],
        };
      },
    },
    {
      name: "scw_get_ship_comparison",
      description:
        "Compare two or more ships side by side (size, crew, cargo, speed, shields, price) from the Star Citizen Wiki API. A ship that cannot be found is reported as such rather than dropped.",
      inputSchema: {
        type: "object",
        properties: {
          ship_names: {
            type: "array",
            items: { type: "string" },
            description: "List of ship names to compare (e.g., ['Ursa Medivac', 'Cutlass Red']).",
            minItems: 2,
          },
        },
        required: ["ship_names"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { ship_names } = z.object({ ship_names: z.array(z.string()).min(2) }).parse(args);

        const results = await Promise.all(
          ship_names.map(async (shipName) => {
            try {
              const response = await fetchWithCache(
                scwClient,
                `/vehicles/${encodeURIComponent(shipName)}`,
              );
              const record = response.data.data;
              // The summary view, always: full records are 5x the output budget.
              return {
                ship: shipName,
                data: isObject(record) ? summarizeVehicle(record) : optimizeData(record),
              };
            } catch (error) {
              // Only a 404 means "no such ship"; an outage must not read as one.
              if (axios.isAxiosError(error) && error.response?.status === 404) {
                return { ship: shipName, error: "Ship not found" };
              }
              return {
                ship: shipName,
                error: `Could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }),
        );

        return {
          content: [{ type: "text", text: formatOutput({ comparison: results }) }],
        };
      },
    },
    {
      name: "scw_snapshot_save",
      description:
        "Save a snapshot of current ship or item data, keyed by game version, for later patch-to-patch comparison.",
      inputSchema: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: ["vehicles", "items"],
            description: "Which dataset to snapshot.",
          },
          label: {
            type: "string",
            description:
              "Optional: Label for this snapshot (defaults to the game_version reported by the API).",
          },
          type: {
            type: "string",
            description:
              "Optional (items only): Restrict snapshot to one item type (e.g., 'Shields', 'WeaponPersonal').",
          },
        },
        required: ["dataset"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { dataset, label, type } = z
          .object({
            dataset: z.enum(["vehicles", "items"]),
            label: z.string().optional(),
            type: z.string().optional(),
          })
          .parse(args);

        const params: Record<string, unknown> = {};
        if (dataset === "items" && type) params["filter[type]"] = type;

        const all = await fetchAllPages(`/${dataset}`, params);
        if (all.length === 0) {
          throw new Error(`No ${dataset} returned by the API — nothing to snapshot.`);
        }

        // The wiki's version string is third-party text: cleaned and bounded where it enters.
        const gameVersion = cleanLabel(all[0].version ?? all[0].game_version) ?? "unknown";
        const resolvedLabel = label || gameVersion;

        const entries: Record<string, Record<string, unknown>> = {};
        for (const entry of all) {
          const key = (entry.name as string) || (entry.uuid as string);
          if (key) entries[key] = snapshotFields(entry);
        }

        await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
        await fs.writeFile(
          snapshotPath(dataset, resolvedLabel),
          JSON.stringify(
            {
              dataset,
              label: resolvedLabel,
              game_version: gameVersion,
              captured_at: new Date().toISOString(),
              entries,
            },
            null,
            2,
          ),
        );

        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                saved: shortPath(snapshotPath(dataset, resolvedLabel)),
                dataset,
                label: resolvedLabel,
                game_version: gameVersion,
                entry_count: Object.keys(entries).length,
              }),
            },
          ],
        };
      },
    },
    {
      name: "scw_snapshot_list",
      description: "List all saved data snapshots available for patch comparison.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        let files: string[];
        try {
          files = await fs.readdir(SNAPSHOT_DIR);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: formatOutput({
                  snapshot_dir: shortPath(SNAPSHOT_DIR),
                  snapshots: [],
                  note: "No snapshots saved yet. Use scw_snapshot_save to capture one.",
                }),
              },
            ],
          };
        }

        const snapshots = [];
        for (const file of files.filter((f) => f.endsWith(".json"))) {
          try {
            const raw = JSON.parse(await fs.readFile(path.join(SNAPSHOT_DIR, file), "utf-8"));
            // A snapshot file is a local file whose labels came from the wiki: cleaned on the way out.
            snapshots.push({
              dataset: cleanLabel(raw.dataset),
              label: cleanLabel(raw.label),
              game_version: cleanLabel(raw.game_version),
              captured_at: cleanLabel(raw.captured_at),
              entry_count: Object.keys(raw.entries || {}).length,
            });
          } catch {
            continue;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: formatOutput({ snapshot_dir: shortPath(SNAPSHOT_DIR), snapshots }),
            },
          ],
        };
      },
    },
    {
      name: "scw_snapshot_diff",
      description:
        "Compare two saved snapshots to see what changed between patches (added, removed, and changed stats).",
      inputSchema: {
        type: "object",
        properties: {
          from_label: {
            type: "string",
            description: "Label of the older snapshot.",
          },
          to_label: {
            type: "string",
            description: "Label of the newer snapshot. Omit to compare against current live data.",
          },
          dataset: {
            type: "string",
            enum: ["vehicles", "items"],
            description: "Which dataset to diff.",
          },
        },
        required: ["from_label", "dataset"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { from_label, to_label, dataset } = z
          .object({
            from_label: z.string(),
            to_label: z.string().optional(),
            dataset: z.enum(["vehicles", "items"]),
          })
          .parse(args);

        const fromSnap = await loadSnapshot(dataset, from_label);

        let toEntries: Record<string, Record<string, unknown>>;
        let toDescription: string;

        if (to_label) {
          const toSnap = await loadSnapshot(dataset, to_label);
          toEntries = toSnap.entries;
          toDescription = `${toSnap.label} (${toSnap.game_version})`;
        } else {
          const all = await fetchAllPages(`/${dataset}`);
          toEntries = {};
          for (const entry of all) {
            const key = (entry.name as string) || (entry.uuid as string);
            if (key) toEntries[key] = snapshotFields(entry);
          }
          const liveVersion =
            all.length > 0
              ? (all[0].version as string) || (all[0].game_version as string)
              : "unknown";
          toDescription = `current live data (${liveVersion})`;
        }

        const { added, removed, changed } = diffEntries(fromSnap.entries, toEntries);

        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                dataset,
                from: `${fromSnap.label} (${fromSnap.game_version})`,
                to: toDescription,
                summary: {
                  added: added.length,
                  removed: removed.length,
                  changed: Object.keys(changed).length,
                },
                added,
                removed,
                changed,
              }),
            },
          ],
        };
      },
    },
  ];
}
