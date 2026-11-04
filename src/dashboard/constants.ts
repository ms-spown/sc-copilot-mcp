/** Shared names of the live dashboard (an MCP App: a View that Claude Desktop renders from this server). */

/** The extension a client declares in `capabilities.extensions` when it can render Views. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
/** The MIME type of a View. Exactly this string: the host refuses anything else. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";
/** The resource the tools point at. */
export const DASHBOARD_URI = "ui://sc-copilot/live-dashboard.html";

/** Polling bounds, in milliseconds. The View may ask less often, never more often. */
export const POLL_CACHE_MS = 500;
/** How many recent events every poll carries (the View de-duplicates by `seq`). */
export const POLL_EVENT_COUNT = 30;
/** Longest text of a plan field. */
export const PLAN_TEXT_MAX = 60;
/** Most price points of the "cours" curve a plan may carry. */
export const PLAN_PRICE_POINTS_MAX = 30;
