import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { formatOutput, isObject } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/** Tools backed by Star Citizen Tools (starcitizen.tools, a MediaWiki). */
export function sctTools({ sctClient }: { sctClient: HttpClient }): ToolDefinition[] {
  return [
    {
      name: "sct_search",
      description: "Search Star Citizen Tools (starcitizen.tools) for any topic.",
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
        const response = await fetchWithCache(sctClient, "/api.php", {
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
      name: "sct_get_article",
      description:
        "Get the text content of an article from Star Citizen Tools (starcitizen.tools).",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The title of the article (e.g., 'Wikelo', 'Carrack').",
          },
        },
        required: ["title"],
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { title } = z.object({ title: z.string() }).parse(args);
        const response = await fetchWithCache(sctClient, "/api.php", {
          params: {
            action: "query",
            prop: "extracts",
            explaintext: "1",
            format: "json",
            titles: title,
          },
        });

        let textContent = "";
        if (
          response.data &&
          isObject(response.data) &&
          isObject(response.data.query) &&
          isObject(response.data.query.pages)
        ) {
          const pages = response.data.query.pages;
          const pageId = Object.keys(pages)[0];
          if (pageId !== "-1" && isObject(pages[pageId])) {
            textContent = (pages[pageId].extract as string) || "";
          } else {
            textContent = "Article not found.";
          }
        }

        return {
          content: [{ type: "text", text: textContent || formatOutput(response.data) }],
        };
      },
    },
  ];
}
