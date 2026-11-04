import type { HttpClient } from "../core/http.js";
import type { ToolDefinition } from "./types.js";
import { uexItemTools } from "./uexItems.js";
import { uexMarketplaceTools } from "./uexMarketplace.js";
import { uexRefiningTools } from "./uexRefining.js";

/**
 * UEX tools for refining, shop items and the player marketplace. One entry point so the registry
 * has a single line for them; the tools are in their own files, apart from `uex.ts`.
 */
export function uexCommerceTools(clients: { uexClient: HttpClient }): ToolDefinition[] {
  return [...uexRefiningTools(clients), ...uexItemTools(clients), ...uexMarketplaceTools(clients)];
}
