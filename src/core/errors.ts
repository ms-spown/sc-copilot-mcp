import type { ToolResult } from "../tools/types.js";

/** Turn anything thrown by a tool into an MCP error result, keeping an HTTP error body when there is one. */
export function toErrorResult(error: unknown): ToolResult {
  let errorMessage = "Unknown error occurred";
  let details = "";

  if (error instanceof Error) {
    errorMessage = error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in error.response
  ) {
    details = JSON.stringify(error.response.data);
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${errorMessage}${details ? `\nDetails: ${details}` : ""}`,
      },
    ],
  };
}
