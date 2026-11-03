import axios from "axios";
import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { formatOutputRaw } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import { addNote, recordFetch } from "../core/provenance.js";
import { FleetShipInput, type FleetShip, type FleetStore } from "../providers/fleet/store.js";
import { resolveShip, type VehicleRow } from "../providers/fleet/resolve.js";
import { shortPath } from "../providers/gamelog/reader.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The player's fleet: a local file the player (or Claude, when asked) edits, with the public
 * stats of each ship added on read. No price and no account data is stored, and nothing is
 * fetched from RSI: stats come from UEX (to resolve the name) and the Star Citizen Wiki.
 */

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

const originProp = {
  type: "string",
  enum: ["pledge", "in_game"],
  description: "'pledge' for a ship bought with real money, 'in_game' for one bought with aUEC.",
};

/** The public figures worth showing for a ship; no price. */
function publicStats(v: Record<string, unknown>) {
  const manufacturer = v.manufacturer as Record<string, unknown> | undefined;
  const speed = v.speed as Record<string, unknown> | undefined;
  const crew = v.crew as Record<string, unknown> | undefined;
  const size = v.size as Record<string, unknown> | string | undefined;
  return {
    name: v.name,
    manufacturer: manufacturer?.name,
    role: v.role,
    career: v.career,
    size: typeof size === "object" ? (size?.en_EN ?? size) : size,
    crew: crew ? { min: crew.min, max: crew.max } : undefined,
    cargo_scu: v.cargo_capacity,
    health: v.health,
    shield_hp: v.shield_hp,
    speed_scm: speed?.scm,
    speed_max: speed?.max,
  };
}

async function enrich(ship: FleetShip, vehicles: VehicleRow[], scwClient: HttpClient) {
  const base = { origin: ship.origin, name: ship.name, notes: ship.notes, added_at: ship.added_at };
  const r = resolveShip(ship.name, vehicles);
  if (r.match === "not_found") {
    return {
      ...base,
      match: "not_found",
      hint: "No ship with these words in UEX's list. Check the spelling, or use scw_search.",
    };
  }
  if (r.match === "ambiguous") {
    return {
      ...base,
      match: "ambiguous",
      candidates: r.candidates.map((c) => c.name_full ?? c.name),
      hint: "Several ships fit. Update the entry with the exact name of one of the candidates.",
    };
  }
  const v = r.vehicle;
  const resolved = {
    ...base,
    match: "found",
    resolved_as: v.name_full ?? v.name,
    uex: { scu: v.scu, crew: v.crew },
  };
  try {
    const stats = await fetchWithCache(scwClient, `/vehicles/${encodeURIComponent(v.name)}`);
    return { ...resolved, stats: publicStats(stats.data.data ?? {}) };
  } catch (error) {
    // Say so instead of dropping the stats silently; UEX's figures above still stand.
    const gone = axios.isAxiosError(error) && error.response?.status === 404;
    return {
      ...resolved,
      stats_error: gone
        ? "The wiki has no page for this exact name."
        : `The wiki could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function fleetTools({
  fleet,
  uexClient,
  scwClient,
}: {
  fleet: FleetStore;
  uexClient: HttpClient;
  scwClient: HttpClient;
}): ToolDefinition[] {
  return [
    {
      name: "sc_fleet_get",
      description:
        "The player's own ships, from a local file, each with its public stats (manufacturer, role, size, crew, cargo SCU, health, shields, speed) from UEX and the Star Citizen Wiki. Origin is 'pledge' (bought with real money) or 'in_game'. A name that fits several ships comes back with the candidates instead of a guess. Use it before suggesting ships, cargo plans or loadouts, so the advice fits what the player owns. Holds no price and no account data.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { ...originProp, description: "Only ships with this origin." },
          enrich: {
            type: "boolean",
            description:
              "Add public stats to each ship (default true). false lists the file as is, with no network.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { origin, enrich: wantStats } = z
          .object({
            origin: z.enum(["pledge", "in_game"]).optional(),
            enrich: z.boolean().optional(),
          })
          .parse(args || {});
        const ships = (await fleet.list()).filter((s) => !origin || s.origin === origin);
        // The file is the user's own data, read just now.
        recordFetch({ fetchedAt: Date.now(), cache: "network" });
        if (ships.length === 0) {
          return ok({
            file: shortPath(fleet.file),
            count: 0,
            ships: [],
            hint: "The fleet is empty. Add ships with sc_fleet_upsert.",
          });
        }
        if (wantStats === false) {
          return ok({ file: shortPath(fleet.file), count: ships.length, ships });
        }
        const vehicles = ((await fetchWithCache(uexClient, "/vehicles")).data.data ??
          []) as VehicleRow[];
        const rows = await Promise.all(ships.map((s) => enrich(s, vehicles, scwClient)));
        const unresolved = rows.filter((r) => r.match !== "found").length;
        if (unresolved)
          addNote(`${unresolved} ship name(s) could not be matched to one ship; see their hint.`);
        return ok({ file: shortPath(fleet.file), count: rows.length, ships: rows });
      },
    },
    {
      name: "sc_fleet_upsert",
      description:
        "Add a ship to the player's local fleet file, or change the note of one already there (same name and origin). Writes only a small JSON file on this PC: no website, no account, no price. Use the ship's name as the player says it; sc_fleet_get will match it to the exact ship. Ask the player for the origin if unclear.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Ship name, e.g. 'Drake Vulture' or 'C2 Hercules Starlifter'.",
          },
          origin: originProp,
          notes: {
            type: "string",
            description: "Optional note, up to 500 characters (loadout idea, role, location).",
          },
        },
        required: ["name", "origin"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const input = FleetShipInput.parse(args);
        const { ship, created } = await fleet.upsert(input);
        return ok({ saved: created ? "added" : "updated", ship, file: shortPath(fleet.file) });
      },
    },
    {
      name: "sc_fleet_remove",
      description:
        "Remove a ship from the player's local fleet file, by name. If the same name is listed as both pledge and in_game, say which with origin. Only the local file changes.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name exactly as listed in the fleet (case does not matter).",
          },
          origin: {
            ...originProp,
            description: "Needed only when the name exists under both origins.",
          },
        },
        required: ["name"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { name, origin } = z
          .object({ name: z.string(), origin: z.enum(["pledge", "in_game"]).optional() })
          .parse(args);
        const removed = await fleet.remove(name, origin);
        return ok({ removed, file: shortPath(fleet.file) });
      },
    },
  ];
}
