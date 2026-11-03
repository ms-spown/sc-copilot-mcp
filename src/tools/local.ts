import { z } from "zod";
import { formatOutput } from "../core/format.js";
import { listDatasets, readCollection, searchDataset } from "../providers/local/localdata.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Tools that read game data the user already has on disk (SCMCP_GAME_DATA_DIR). */
export function localTools(): ToolDefinition[] {
  return [
    {
      name: "sc_local_datasets",
      description:
        "List locally extracted game data (mining, blueprints, reputation, ordnance, components, lore) with the game build it came from. This data is extracted from the shipped game files and covers domains no public API exposes.",
      inputSchema: { type: "object", properties: {} },
      handler: async (): Promise<ToolResult> => {
        return { content: [{ type: "text", text: formatOutput(await listDatasets()) }] };
      },
    },
    {
      name: "sc_search_local",
      description:
        "Search locally extracted game data for records matching a term. Use for mining ore signatures and spawn locations, crafting blueprints, reputation and mission brokers, quality bands, and Wikelo trades.",
      inputSchema: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            description:
              "Dataset name, e.g. 'game-mining' or 'game-blueprints'. See sc_local_datasets.",
          },
          query: {
            type: "string",
            description: "Case-insensitive term to match against keys, names and record contents.",
          },
          collection: {
            type: "string",
            description: "Optional: restrict to one collection within the dataset.",
          },
          limit: {
            type: "number",
            description: "Max records to return (default 20).",
          },
        },
        required: ["dataset", "query"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { dataset, query, collection, limit } = z
          .object({
            dataset: z.string(),
            query: z.string(),
            collection: z.string().optional(),
            limit: z.number().optional(),
          })
          .parse(args);
        const result = await searchDataset(dataset, query, { collection, limit });
        return { content: [{ type: "text", text: formatOutput(result) }] };
      },
    },
    {
      name: "sc_read_local_collection",
      description:
        "Read one collection from a locally extracted dataset, with paging. Use after sc_local_datasets to browse in bulk.",
      inputSchema: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset name, e.g. 'game-mining'." },
          collection: {
            type: "string",
            description: "Collection within the dataset, e.g. 'oreSignatures'.",
          },
          offset: { type: "number", description: "Records to skip (default 0)." },
          limit: { type: "number", description: "Records to return (default 25, max 200)." },
        },
        required: ["dataset", "collection"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { dataset, collection, offset, limit } = z
          .object({
            dataset: z.string(),
            collection: z.string(),
            offset: z.number().optional(),
            limit: z.number().optional(),
          })
          .parse(args);
        const result = await readCollection(dataset, collection, { offset, limit });
        return { content: [{ type: "text", text: formatOutput(result) }] };
      },
    },
  ];
}
