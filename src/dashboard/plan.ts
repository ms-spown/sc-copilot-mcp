import { stripInvisible } from "../core/untrusted.js";
import { PLAN_TEXT_MAX } from "./constants.js";

/**
 * The optional route plan Claude passes when it opens the dashboard (after uex_get_trade_routes). It is text that
 * came from the model, and through it possibly from a website: every string is cleaned and capped here, unknown
 * fields are dropped without a word, and the View shows it with textContent only.
 */
export interface Plan {
  commodity?: string;
  buy_terminal?: string;
  sell_terminal?: string;
  note?: string;
  scu?: number;
  expected_profit_auec?: number;
}

const TEXT_FIELDS = ["commodity", "buy_terminal", "sell_terminal", "note"] as const;

export function cleanPlanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // The one rule of the server for invisible and direction-changing characters (core/untrusted.ts), then spaces.
  const cleaned = stripInvisible(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return [...cleaned].slice(0, PLAN_TEXT_MAX).join("");
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A plan from anything: only known fields survive, nothing throws. Undefined when nothing usable is left. */
export function parsePlan(input: unknown): Plan | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const plan: Plan = {};
  for (const key of TEXT_FIELDS) {
    const text = cleanPlanText(raw[key]);
    if (text) plan[key] = text;
  }
  const scu = boundedNumber(raw["scu"], 0, 1_000_000);
  if (scu !== undefined) plan.scu = scu;
  const profit = boundedNumber(raw["expected_profit_auec"], -1_000_000_000_000, 1_000_000_000_000);
  if (profit !== undefined) plan.expected_profit_auec = profit;
  return Object.keys(plan).length > 0 ? plan : undefined;
}
