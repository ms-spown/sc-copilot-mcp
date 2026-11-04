import type { ToolResult } from "./types.js";

/**
 * Output budget of the UEX commerce tools. The repo limit is MAX_OUTPUT_CHARS (40,000, core/format.ts); the
 * registry adds a provenance block (about 1,000 characters) around the payload, so the payload gets less.
 * formatOutput's own fallback only shortens the longest top-level array and can give up with an error,
 * which is why these tools bound their answer themselves.
 */
export const OUTPUT_BUDGET = 35_000;

/**
 * Compose the answer from the fullest step to the leanest and keep the first one whose JSON fits the
 * budget. `compose` gets the step and its index (0 = nothing was cut) and must say what it cut. If even
 * the leanest step is too big (it should not be: steps end at one row), that one is returned anyway.
 * Not formatOutput: a rank of 1, a bonus of 0 or `stale: false` are information, not noise.
 */
export function fitSteps<S>(steps: S[], compose: (step: S, index: number) => unknown): ToolResult {
  let text = "";
  for (let i = 0; i < steps.length; i++) {
    text = JSON.stringify(compose(steps[i], i), null, 2);
    if (text.length <= OUTPUT_BUDGET) break;
  }
  return { content: [{ type: "text", text }] };
}

/** Halving steps from `max` down to 1: [30, 15, 7, 3, 1]. */
export function halvings(max: number): number[] {
  const out = [Math.max(1, max)];
  while (out[out.length - 1] > 1) out.push(Math.floor(out[out.length - 1] / 2));
  return out;
}
