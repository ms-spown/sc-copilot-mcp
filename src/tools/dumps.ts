import { z } from "zod";
import { formatOutput, formatOutputRaw } from "../core/format.js";
import {
  DATASETS,
  type DatasetName,
  diffDatasets,
  fetchDataset,
  listBuilds,
  resolveBuild,
} from "../providers/dumps/versions.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Tools that compare game data across patches, from the tagged data-dump repository. */
export function dumpTools(): ToolDefinition[] {
  return [
    {
      name: "sc_list_builds",
      description:
        "List the game builds (patch versions) for which historical data dumps exist, newest first. Use this to discover which versions can be compared.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "How many builds to return (default 40, max 100).",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { limit } = z
          .object({
            limit: z.number().optional(),
          })
          .parse(args || {});

        const builds = await listBuilds(limit ?? 40);
        return {
          content: [
            {
              type: "text",
              text: formatOutput({ datasets: Object.keys(DATASETS), builds }),
            },
          ],
        };
      },
    },
    {
      name: "sc_diff_versions",
      description:
        "Compare game data between any two patch versions. Reports what was added, removed, and changed. Pass item_name to get every changed field for one ship/weapon/component, otherwise returns a summary with the most-changed entries. This is the tool for questions like 'what changed for X between 4.9 and 4.10'.",
      inputSchema: {
        type: "object",
        properties: {
          dataset: {
            type: "string",
            enum: [
              "ships",
              "ship-components",
              "fps-weapons",
              "ammo",
              "mining",
              "mining-spawns",
              "blueprints",
              "missions",
              "reputation",
              "containers",
              "starmap",
              "manufacturers",
              "wikelo-trades",
              "strings",
            ],
            description:
              "Which dataset to diff. 'ship-components' covers ship weapons, shields, coolers, power plants, quantum drives and radars; 'strings' is the localisation table, useful for spotting renamed or newly added content.",
          },
          from_version: {
            type: "string",
            description:
              "Older version, e.g. '4.9' or a full build string like '4.9.0-LIVE.12344265'.",
          },
          to_version: {
            type: "string",
            description: "Newer version, e.g. '4.10'.",
          },
          collection: {
            type: "string",
            description:
              "Optional: which collection inside the dataset to diff. Defaults to the main one (e.g. 'weapons' for ship-components); pass 'shields', 'quantumDrives', 'radars' or 'missiles' to diff those instead.",
          },
          item_name: {
            type: "string",
            description:
              "Optional: restrict to entries matching this name or class name (e.g. 'AD5B', 'Mantis', 'Talon'). Returns field-level changes.",
          },
          limit: {
            type: "number",
            description: "Max entries listed per category in summary mode (default 50).",
          },
        },
        required: ["dataset", "from_version", "to_version"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { dataset, from_version, to_version, collection, item_name, limit } = z
          .object({
            dataset: z.enum([
              "ships",
              "ship-components",
              "fps-weapons",
              "ammo",
              "mining",
              "mining-spawns",
              "blueprints",
              "missions",
              "reputation",
              "containers",
              "starmap",
              "manufacturers",
              "wikelo-trades",
              "strings",
            ]),
            from_version: z.string(),
            to_version: z.string(),
            collection: z.string().optional(),
            item_name: z.string().optional(),
            limit: z.number().optional(),
          })
          .parse(args);

        const ds = dataset as DatasetName;
        const [fromBuild, toBuild] = await Promise.all([
          resolveBuild(from_version),
          resolveBuild(to_version),
        ]);

        if (fromBuild.sha === toBuild.sha) {
          throw new Error(
            `"${from_version}" and "${to_version}" both resolve to build ${fromBuild.version}.`,
          );
        }

        const [beforeEntries, afterEntries] = await Promise.all([
          fetchDataset(ds, fromBuild, collection),
          fetchDataset(ds, toBuild, collection),
        ]);

        const result = diffDatasets(ds, fromBuild, toBuild, beforeEntries, afterEntries, {
          itemQuery: item_name,
          limit,
        });

        return {
          content: [{ type: "text", text: formatOutputRaw(result) }],
        };
      },
    },
  ];
}
