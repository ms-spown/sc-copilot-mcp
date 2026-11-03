import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { formatOutput } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Tools backed by the UEX Corp API. `scw_search_ships_by_vendor` lives here despite its
 * prefix: it resolves vendors from UEX terminals, and renaming it would break callers.
 */
export function uexTools({ uexClient }: { uexClient: HttpClient }): ToolDefinition[] {
  return [
    {
      name: "uex_get_commodities",
      description: "Get a list of all commodities in Star Citizen from UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        const response = await fetchWithCache(uexClient, "/commodities");
        return {
          content: [{ type: "text", text: formatOutput(response.data.data) }],
        };
      },
    },
    {
      name: "uex_get_commodity_prices",
      description:
        "Get current prices for a specific commodity from UEX Corp. Returns buy/sell prices at various terminals.",
      inputSchema: {
        type: "object",
        properties: {
          commodity_name: {
            type: "string",
            description: "The name of the commodity (e.g., 'Gold', 'Laranite').",
          },
          star_system_name: {
            type: "string",
            description: "Optional: Filter by star system (e.g., 'Stanton', 'Pyro').",
          },
          planet_name: {
            type: "string",
            description: "Optional: Filter by planet name.",
          },
          terminal_name: {
            type: "string",
            description: "Optional: Filter by terminal name.",
          },
        },
        required: ["commodity_name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { commodity_name, star_system_name, planet_name, terminal_name } = z
          .object({
            commodity_name: z.string(),
            star_system_name: z.string().optional(),
            planet_name: z.string().optional(),
            terminal_name: z.string().optional(),
          })
          .parse(args);
        const response = await fetchWithCache(uexClient, "/commodities_prices", {
          params: { commodity_name },
        });

        let data = response.data.data;
        if (Array.isArray(data)) {
          if (star_system_name) {
            data = data.filter(
              (d: Record<string, unknown>) =>
                typeof d.star_system_name === "string" &&
                d.star_system_name.toLowerCase() === star_system_name.toLowerCase(),
            );
          }
          if (planet_name) {
            data = data.filter(
              (d: Record<string, unknown>) =>
                typeof d.planet_name === "string" &&
                d.planet_name.toLowerCase() === planet_name.toLowerCase(),
            );
          }
          if (terminal_name) {
            data = data.filter(
              (d: Record<string, unknown>) =>
                typeof d.terminal_name === "string" &&
                d.terminal_name.toLowerCase() === terminal_name.toLowerCase(),
            );
          }
        }

        return {
          content: [{ type: "text", text: formatOutput(data) }],
        };
      },
    },
    {
      name: "uex_get_commodity_averages",
      description: "Get average prices for a specific commodity over time from UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {
          commodity_name: {
            type: "string",
            description: "The name of the commodity (e.g., 'Gold', 'Laranite').",
          },
        },
        required: ["commodity_name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { commodity_name } = z.object({ commodity_name: z.string() }).parse(args);
        const response = await fetchWithCache(uexClient, "/commodities_averages", {
          params: { commodity_name },
        });
        return {
          content: [{ type: "text", text: formatOutput(response.data.data) }],
        };
      },
    },
    {
      name: "uex_get_terminals",
      description: "Get a list of all terminals (locations) in Star Citizen from UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {
          star_system_name: {
            type: "string",
            description: "Optional: Filter by star system (e.g., 'Stanton', 'Pyro').",
          },
          planet_name: {
            type: "string",
            description: "Optional: Filter by planet name.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { star_system_name, planet_name } = z
          .object({
            star_system_name: z.string().optional(),
            planet_name: z.string().optional(),
          })
          .parse(args || {});
        const response = await fetchWithCache(uexClient, "/terminals");

        let data = response.data.data;
        if (Array.isArray(data)) {
          if (star_system_name) {
            data = data.filter(
              (d: Record<string, unknown>) =>
                typeof d.star_system_name === "string" &&
                d.star_system_name.toLowerCase() === star_system_name.toLowerCase(),
            );
          }
          if (planet_name) {
            data = data.filter(
              (d: Record<string, unknown>) =>
                typeof d.planet_name === "string" &&
                d.planet_name.toLowerCase() === planet_name.toLowerCase(),
            );
          }
        }

        return {
          content: [{ type: "text", text: formatOutput(data) }],
        };
      },
    },
    {
      name: "uex_get_trade_routes",
      description: "Get suggested trade routes based on current market data from UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {
          investment: {
            type: "number",
            description: "Available credits for investment.",
          },
          cargo_capacity: {
            type: "number",
            description: "Cargo capacity in SCU.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { investment, cargo_capacity } = z
          .object({
            investment: z.number().optional(),
            cargo_capacity: z.number().optional(),
          })
          .parse(args);
        const response = await fetchWithCache(uexClient, "/commodities_routes", {
          params: { investment, scu: cargo_capacity },
        });
        return {
          content: [{ type: "text", text: formatOutput(response.data.data) }],
        };
      },
    },
    {
      name: "uex_get_commodity_ranking",
      description:
        "Get ranking of commodities based on various metrics (e.g., profit) from UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        const response = await fetchWithCache(uexClient, "/commodities_ranking");
        return {
          content: [{ type: "text", text: formatOutput(response.data.data) }],
        };
      },
    },
    {
      name: "uex_search_marketplace",
      description:
        "Search the UEX Corp player marketplace (player-to-player buy/sell/service ads, not shop prices). " +
        "Matches query text against listing title/description. The API caps results at 100 unless " +
        "id_item + operation are both given, which unlocks 1,000; for a broad text search only the " +
        "first 100 active listings are visible to filter over.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to match against listing title/description (case-insensitive).",
          },
          operation: {
            type: "string",
            enum: ["buy", "sell"],
            description: "Optional: filter by transaction type.",
          },
          type: {
            type: "string",
            enum: ["item", "service", "contract"],
            description: "Optional: filter by ad type.",
          },
          id_item: {
            type: "number",
            description:
              "Optional: filter by UEX item id. Combine with operation to unlock the 1,000-row cap.",
          },
          username: {
            type: "string",
            description: "Optional: filter by advertiser in-game name.",
          },
          limit: {
            type: "number",
            description: "Optional: max listings to return (default 25).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { query, operation, type, id_item, username, limit } = z
          .object({
            query: z.string().optional(),
            operation: z.enum(["buy", "sell"]).optional(),
            type: z.enum(["item", "service", "contract"]).optional(),
            id_item: z.number().optional(),
            username: z.string().optional(),
            limit: z.number().optional(),
          })
          .parse(args || {});

        const response = await fetchWithCache(uexClient, "/marketplace_listings", {
          params: { id_item, operation, username },
        });

        let data = response.data.data;
        if (Array.isArray(data)) {
          if (query) {
            const needle = query.toLowerCase();
            data = data.filter((d: Record<string, unknown>) => {
              const title = typeof d.title === "string" ? d.title.toLowerCase() : "";
              const description =
                typeof d.description === "string" ? d.description.toLowerCase() : "";
              return title.includes(needle) || description.includes(needle);
            });
          }
          if (type) {
            data = data.filter((d: Record<string, unknown>) => d.type === type);
          }
          data = data.slice(0, limit ?? 25);
        }

        return {
          content: [{ type: "text", text: formatOutput(data) }],
        };
      },
    },
    {
      name: "uex_get_game_versions",
      description:
        "Get current Star Citizen game versions (LIVE and PTU build strings) tracked by UEX Corp.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async (): Promise<ToolResult> => {
        const response = await fetchWithCache(uexClient, "/game_versions");
        const versions = response.data.data ?? {};
        // A null ptu means no PTU build is live; formatOutput strips nulls, so say it explicitly.
        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                live: versions.live ?? "unknown",
                ptu: versions.ptu ?? "no active PTU build",
              }),
            },
          ],
        };
      },
    },
    {
      name: "uex_get_ship_prices",
      description:
        "Find where a ship can be bought or rented in game, with prices and terminal locations, from UEX Corp. This is the tool to answer 'where can I get ship X'.",
      inputSchema: {
        type: "object",
        properties: {
          vehicle_name: {
            type: "string",
            description: "The name of the ship (e.g., 'Ursa Medivac', 'Carrack').",
          },
          star_system_name: {
            type: "string",
            description: "Optional: Filter by star system (e.g., 'Pyro', 'Stanton').",
          },
          include_rentals: {
            type: "boolean",
            description: "Include rental locations as well as purchase locations (default true).",
          },
        },
        required: ["vehicle_name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { vehicle_name, star_system_name, include_rentals } = z
          .object({
            vehicle_name: z.string(),
            star_system_name: z.string().optional(),
            include_rentals: z.boolean().optional(),
          })
          .parse(args);

        // The price endpoints only filter by id_vehicle; vehicle_name is ignored server-side.
        const vehiclesResponse = await fetchWithCache(uexClient, "/vehicles");
        const vehicles: Record<string, unknown>[] = vehiclesResponse.data.data ?? [];
        const needle = vehicle_name.toLowerCase();

        const matches = vehicles.filter((v) => {
          const full = typeof v.name_full === "string" ? v.name_full.toLowerCase() : "";
          const short = typeof v.name === "string" ? v.name.toLowerCase() : "";
          return (
            full === needle || short === needle || full.includes(needle) || short.includes(needle)
          );
        });

        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: formatOutput({
                  query: vehicle_name,
                  error: "No vehicle matched that name in the UEX vehicle list.",
                }),
              },
            ],
          };
        }

        const exact = matches.find(
          (v) =>
            (typeof v.name_full === "string" && v.name_full.toLowerCase() === needle) ||
            (typeof v.name === "string" && v.name.toLowerCase() === needle),
        );
        const vehicle = exact ?? matches[0];

        const filterSystem = (rows: unknown) => {
          if (!Array.isArray(rows)) return [];
          if (!star_system_name) return rows;
          return rows.filter(
            (d: Record<string, unknown>) =>
              typeof d.star_system_name === "string" &&
              d.star_system_name.toLowerCase() === star_system_name.toLowerCase(),
          );
        };

        const purchaseResponse = await fetchWithCache(uexClient, "/vehicles_purchases_prices", {
          params: { id_vehicle: vehicle.id },
        });
        const purchases = filterSystem(purchaseResponse.data.data);

        let rentals: unknown[] = [];
        if (include_rentals !== false) {
          const rentalResponse = await fetchWithCache(uexClient, "/vehicles_rentals_prices", {
            params: { id_vehicle: vehicle.id },
          });
          rentals = filterSystem(rentalResponse.data.data);
        }

        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                vehicle: vehicle.name_full ?? vehicle.name,
                id_vehicle: vehicle.id,
                system_filter: star_system_name ?? "all systems",
                other_matches:
                  matches.length > 1
                    ? matches.filter((m) => m.id !== vehicle.id).map((m) => m.name_full ?? m.name)
                    : undefined,
                purchase_locations: purchases,
                rental_locations: rentals,
              }),
            },
          ],
        };
      },
    },
    {
      name: "uex_get_terminal_inventory",
      description:
        "Get inventory (items, ships, weapons) sold at a specific terminal from UEX data.",
      inputSchema: {
        type: "object",
        properties: {
          terminal_id: {
            type: "number",
            description: "The UEX terminal ID (e.g., 473 for Ruin Station Buy and Fly).",
          },
          terminal_name: {
            type: "string",
            description:
              "Optional: Terminal name to search for (e.g., 'Ruin Station', 'Checkmate').",
          },
          inventory_type: {
            type: "string",
            enum: ["ships", "weapons", "armor", "components", "all"],
            description:
              "Type of inventory to retrieve (ships, weapons, armor, components, or all).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { terminal_id, terminal_name, inventory_type } = z
          .object({
            terminal_id: z.number().optional(),
            terminal_name: z.string().optional(),
            inventory_type: z.enum(["ships", "weapons", "armor", "components", "all"]).optional(),
          })
          .parse(args);

        const response = await fetchWithCache(uexClient, "/terminals");
        let terminals = response.data.data;

        if (Array.isArray(terminals)) {
          if (terminal_id) {
            terminals = terminals.filter((t: Record<string, unknown>) => t.id === terminal_id);
          }
          if (terminal_name) {
            terminals = terminals.filter(
              (t: Record<string, unknown>) =>
                (typeof t.name === "string" &&
                  t.name.toLowerCase().includes(terminal_name.toLowerCase())) ||
                (typeof t.nickname === "string" &&
                  t.nickname.toLowerCase().includes(terminal_name.toLowerCase())),
            );
          }

          const inventoryFilter = inventory_type ?? "all";
          // UEX exposes shop capability flags per terminal, not per-item stock.
          const CAPABILITIES: { kind: string; flag: string }[] = [
            { kind: "ships", flag: "is_shop_vehicle" },
            { kind: "components", flag: "is_shop_vehicle" },
            { kind: "weapons", flag: "is_shop_fps" },
            { kind: "armor", flag: "is_shop_fps" },
          ];

          const terminalInventory = terminals.map((t: Record<string, unknown>) => {
            const sells: string[] = [];
            for (const { kind, flag } of CAPABILITIES) {
              if (inventoryFilter !== "all" && inventoryFilter !== kind) continue;
              if (t[flag] === 1) sells.push(kind);
            }

            return {
              terminal_id: t.id,
              terminal_name: t.nickname || t.name,
              full_name: t.fullname,
              location: [t.planet_name, t.space_station_name || t.orbit_name]
                .filter(Boolean)
                .join(" / "),
              system: t.star_system_name,
              sells: sells.length > 0 ? sells : "nothing matching that filter",
              faction: t.faction_name,
              game_version: t.game_version,
            };
          });

          return {
            content: [
              {
                type: "text",
                text: formatOutput({
                  query: {
                    terminal_id,
                    terminal_name,
                    inventory_type: inventoryFilter,
                  },
                  results: terminalInventory,
                  note: "These are shop capability flags, not live stock. For where a specific ship is sold, use uex_get_ship_prices.",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                message: "No terminals found",
                suggestion: "Use uex_get_terminals to find terminals",
              }),
            },
          ],
        };
      },
    },
    {
      name: "scw_search_ships_by_vendor",
      description:
        "Search for ships available at a specific vendor/location, optionally filtered by system.",
      inputSchema: {
        type: "object",
        properties: {
          vendor_name: {
            type: "string",
            description: "The vendor/dealer name (e.g., 'Ruin Station', 'Port Tressler').",
          },
          star_system_name: {
            type: "string",
            description: "Optional: Filter by star system (e.g., 'Pyro', 'Stanton').",
          },
        },
        required: ["vendor_name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { vendor_name, star_system_name } = z
          .object({
            vendor_name: z.string(),
            star_system_name: z.string().optional(),
          })
          .parse(args);

        // Get terminals by vendor name from UEX
        const terminalsResponse = await fetchWithCache(uexClient, "/terminals");
        let terminals = terminalsResponse.data.data;

        if (Array.isArray(terminals)) {
          terminals = terminals.filter(
            (t: Record<string, unknown>) =>
              (typeof t.name === "string" &&
                t.name.toLowerCase().includes(vendor_name.toLowerCase())) ||
              (typeof t.fullname === "string" &&
                t.fullname.toLowerCase().includes(vendor_name.toLowerCase())) ||
              (typeof t.nickname === "string" &&
                t.nickname.toLowerCase().includes(vendor_name.toLowerCase())),
          );

          if (star_system_name) {
            terminals = terminals.filter(
              (t: Record<string, unknown>) =>
                typeof t.star_system_name === "string" &&
                t.star_system_name.toLowerCase() === star_system_name.toLowerCase(),
            );
          }

          const vendorInfo = terminals.map((t: Record<string, unknown>) => ({
            vendor_name: t.nickname || t.name,
            full_name: t.fullname,
            location: `${t.planet_name || t.space_station_name || "Space"}`,
            system: t.star_system_name,
            has_ship_shop: t.is_shop_vehicle === 1,
            terminal_code: t.code,
            terminal_id: t.id,
          }));

          if (vendorInfo.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: formatOutput({
                    vendor_query: vendor_name,
                    system_filter: star_system_name || "All systems",
                    vendors_found: vendorInfo,
                    note: "Use scw_get_vehicle to get specific ship details and availability",
                  }),
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: formatOutput({
                vendor_query: vendor_name,
                message: "No vendors found matching query",
                suggestion: "Try using uex_get_terminals to list all terminals in a system",
              }),
            },
          ],
        };
      },
    },
  ];
}
