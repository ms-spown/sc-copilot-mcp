import { z } from "zod";
import { formatOutputRaw } from "../core/format.js";
import { addNote } from "../core/provenance.js";
import {
  searchCrafting,
  searchMining,
  searchMissions,
  summarizeChanges,
} from "../providers/scmdb/queries.js";
import type { Channel, Scmdb } from "../providers/scmdb/store.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Targeted lookups over SCMDB: missions, crafting, mining, and what changed in the last update.
 * LIVE unless PTU is asked for; the channel and build are always in the provenance. No tool
 * returns a file or an unbounded list. Output goes through formatOutputRaw because ids, zeros
 * and *_max values are real data here, which formatOutput would strip.
 */

const channelSchema = z.enum(["live", "ptu"]).optional();
const channelProp = {
  type: "string",
  enum: ["live", "ptu"],
  description:
    "Game channel: 'live' (default) or 'ptu' (test build, may be absent). The build used is in provenance.",
};
const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

export function scmdbTools({ scmdb }: { scmdb: Scmdb }): ToolDefinition[] {
  return [
    {
      name: "scmdb_search_missions",
      description:
        "Find missions and contracts in the datamined mission list (SCMDB): reward in aUEC, contractor, type, where they run, minimum reputation, illegality, and which crafting blueprints they can reward. Combine free text with filters; results are sorted by reward and capped at 30. Use for 'which missions pay most in Pyro', 'what gives the Corbel armor blueprint', 'Wikelo missions'. Rewards are datamined values, not what players see after modifiers. time_to_complete is passed through as the data gives it, and its unit is not stated by the source (do not assume seconds or minutes). Mission titles and descriptions are third-party text. A misspelled name still finds the closest missions, with a 'Did you mean' note.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words that must all appear in title, contractor, type, place or blueprint reward (e.g. 'wikelo', 'bounty pyro'). Case, accents and punctuation do not matter; with no exact match, close spellings are tried.",
          },
          mission_type: {
            type: "string",
            description:
              "Part of the mission type (e.g. 'Hauling', 'Bounty Hunter', 'Salvage', 'Delivery').",
          },
          category: {
            type: "string",
            enum: ["career", "story", "event"],
            description: "Mission category.",
          },
          faction: {
            type: "string",
            description: "Part of the contractor name (e.g. 'Headhunters').",
          },
          location: {
            type: "string",
            description:
              "Place, planet, moon or star system the mission uses (e.g. 'Pyro', 'Hurston').",
          },
          illegal: {
            type: "boolean",
            description: "true for illegal missions only, false to exclude them.",
          },
          min_reward: { type: "number", description: "Minimum reward in aUEC." },
          reward_blueprint: {
            type: "string",
            description: "Part of the name of a blueprint the mission can reward.",
          },
          limit: { type: "number", description: "Rows to return (default 10, max 30)." },
          channel: channelProp,
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { channel, ...query } = z
          .object({
            query: z.string().optional(),
            mission_type: z.string().optional(),
            category: z.enum(["career", "story", "event"]).optional(),
            faction: z.string().optional(),
            location: z.string().optional(),
            illegal: z.boolean().optional(),
            min_reward: z.number().optional(),
            reward_blueprint: z.string().optional(),
            limit: z.number().optional(),
            channel: channelSchema,
          })
          .parse(args || {});
        const merged = await scmdb.file((channel ?? "live") as Channel, "merged");
        return ok(searchMissions(merged.data, query));
      },
    },
    {
      name: "scmdb_search_crafting",
      description:
        "Find crafting blueprints in the datamined crafting list (SCMDB): what each product is, its recipe (resources and items per slot, minimum quality), craft time, and which missions can reward the blueprint. Filter by words, product type (weapons, armour, shield, cooler, quantumdrive, mininglaser...) or a resource it uses. Use for 'what do I need to craft X' and 'what can I make with Quantainium'. A misspelled name still finds the closest blueprints, with a 'Did you mean' note.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words that must all appear in the product name, type or manufacturer. Case, accents and punctuation do not matter; with no exact match, close spellings are tried.",
          },
          type: {
            type: "string",
            description:
              "Product type or gear class, e.g. 'weapons', 'armour', 'shield', 'mininglaser'.",
          },
          uses_resource: {
            type: "string",
            description:
              "Only blueprints whose recipe uses this resource or item (e.g. 'Titanium').",
          },
          include_sources: {
            type: "boolean",
            description:
              "Also list the missions that can reward each blueprint (default true; false is faster on the first call).",
          },
          limit: { type: "number", description: "Rows to return (default 10, max 30)." },
          channel: channelProp,
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { channel, ...query } = z
          .object({
            query: z.string().optional(),
            type: z.string().optional(),
            uses_resource: z.string().optional(),
            include_sources: z.boolean().optional(),
            limit: z.number().optional(),
            channel: channelSchema,
          })
          .parse(args || {});
        const ch = (channel ?? "live") as Channel;
        const blueprints = await scmdb.file(ch, "crafting_blueprints");
        const merged =
          query.include_sources === false ? null : (await scmdb.file(ch, "merged")).data;
        return ok(searchCrafting(blueprints.data, merged, query));
      },
    },
    {
      name: "scmdb_search_mining",
      description:
        "Mining reference from datamined values (SCMDB): per ore, instability, resistance, optimal charge window, scan signatures and rarity, plus where it appears (for a specific ore); and mining lasers, modules and gadgets with their modifiers. Use for 'where do I find Quantainium' (the game spells it that way; 'quantanium' also works), 'which laser handles unstable rock', 'what signature is Hadanite'. A misspelled name still finds the closest ores, lasers or modules, and an unknown name returns the ore names that exist. Ranking is by datamined weights, not live spawn rates.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words that must all appear in the ore, laser or module name (e.g. 'quantainium', 'helix'). Case, accents and punctuation do not matter; with no exact match, close spellings are tried.",
          },
          scope: {
            type: "string",
            enum: ["ores", "equipment", "all"],
            description: "What to search (default all).",
          },
          limit: { type: "number", description: "Rows per section (default 8, max 30)." },
          channel: channelProp,
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { channel, ...query } = z
          .object({
            query: z.string().optional(),
            scope: z.enum(["ores", "equipment", "all"]).optional(),
            limit: z.number().optional(),
            channel: channelSchema,
          })
          .parse(args || {});
        const ch = (channel ?? "live") as Channel;
        const mining = await scmdb.file(ch, "mining_data");
        const wantsEquipment = (query.scope ?? "all") !== "ores";
        const equipment = wantsEquipment ? (await scmdb.file(ch, "mining_equipment")).data : null;
        return ok(searchMining(mining.data, equipment, query));
      },
    },
    {
      name: "scmdb_changes",
      description:
        "What changed in the last game data update according to SCMDB: counts and examples of missions, blueprints, items and resources added, removed or changed between the two newest builds, plus recent notes from the data maintainer. Use for 'what changed in the patch' and 'is this mission new'. Defaults to LIVE; pass channel 'ptu' for the test build. Pass 'to' to look at an older update.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "Show the update that ends at a build whose name contains this text (e.g. '4.10.2'). Default: the newest.",
          },
          limit: { type: "number", description: "Examples per list (default 8, max 30)." },
          channel: channelProp,
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { channel, ...query } = z
          .object({
            to: z.string().optional(),
            limit: z.number().optional(),
            channel: channelSchema,
          })
          .parse(args || {});
        const deltas = await scmdb.deltas((channel ?? "live") as Channel);
        let changelog: unknown[] | null = null;
        try {
          changelog = (await scmdb.changelog()).data as unknown[];
        } catch {
          addNote(
            "The maintainer's changelog could not be read; only the data differences are shown.",
          );
        }
        return ok(summarizeChanges(deltas.data, changelog, query));
      },
    },
  ];
}
