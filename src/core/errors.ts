import axios from "axios";
import type { ToolResult } from "../tools/types.js";
import { cleanString } from "./untrusted.js";

/** Longest piece of a remote error body shown back. It is third-party text: bounded and cleaned. */
const MAX_REMOTE_DETAILS = 500;

/** A readable reason for a failed HTTP call, instead of axios's bare "status code 401". */
export function describeHttpError(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const status = error.response?.status;
  if (status === undefined) {
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return `the request timed out (${error.config?.timeout ?? "?"} ms)`;
    }
    return `the server could not be reached (${error.code ?? error.message})`;
  }
  if (status === 401 || status === 403) {
    return `the server rejected the credentials (HTTP ${status}); check the token`;
  }
  if (status === 429) return "rate limited by the server (HTTP 429); try again in a minute";
  if (status >= 500) return `the server failed (HTTP ${status})`;
  return undefined;
}

/** Turn anything thrown by a tool into an MCP error result, keeping a short remote error body. */
export function toErrorResult(error: unknown): ToolResult {
  let errorMessage = "Unknown error occurred";
  let details = "";

  if (error instanceof Error) {
    errorMessage = error.message;
    const reason = describeHttpError(error);
    if (reason) errorMessage = `${errorMessage}: ${reason}`;
  }

  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response &&
    error.response.data !== undefined
  ) {
    const body =
      typeof error.response.data === "string"
        ? error.response.data
        : JSON.stringify(error.response.data);
    details = cleanString(body, MAX_REMOTE_DETAILS);
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${errorMessage}${details ? `\nRemote response (third-party text, truncated): ${details}` : ""}`,
      },
    ],
  };
}
