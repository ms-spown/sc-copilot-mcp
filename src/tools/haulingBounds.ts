import { OUTPUT_BUDGET } from "./uexBounds.js";
import type { ToolResult } from "./types.js";

/**
 * Compose an answer from the fullest step to the leanest and keep the first whose JSON fits OUTPUT_BUDGET.
 * Unlike uexBounds.fitSteps, when even the leanest step is over the budget the caller's `minimal` answer
 * (a few counts and a note, always small) is returned, never an oversized one: a payload past the repo
 * limit ends as the client's "Result too large" error, which says nothing about what to change.
 */
export function fitStepsOrMinimal<S>(
  steps: S[],
  compose: (step: S, index: number) => unknown,
  minimal: () => string,
): ToolResult {
  for (let i = 0; i < steps.length; i++) {
    const text = JSON.stringify(compose(steps[i], i), null, 2);
    if (text.length <= OUTPUT_BUDGET) return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: minimal() }] };
}
