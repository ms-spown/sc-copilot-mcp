import type { BalancePoint } from "../providers/telemetry/service.js";
import type { Transaction } from "../providers/gamelog/trade.js";
import {
  buildMovementsSection,
  decomposeRun,
  explainMovements,
  type ContractEnd,
  type MovementEvent,
  type MovementsSection,
} from "./balanceMovements.js";
import type { TradeSection } from "./tradeRun.js";

/**
 * The glue between the commerce model and the balance movement explainer (both pure). Everything here is derived from
 * the aUEC balance: the callers (ledger.ts) use it ONLY when the View asked for the balance.
 */

export interface MovementSources {
  history: readonly BalancePoint[];
  transactions: readonly Transaction[] | undefined;
  contracts: readonly ContractEnd[];
  events: readonly MovementEvent[];
}

/**
 * Adds to every run whose net was measured the decomposition of that net: the balance changes of the very window the
 * net was read over, each labelled with at most one cause. The model's own figures are left as they are (the fees stay
 * what the reconciliation measured); the decomposition only says what the rest of the balance variation is made of.
 */
export function withDecompositions(trade: TradeSection, sources: MovementSources): TradeSection {
  if (trade.source !== "journal") return trade;
  return {
    ...trade,
    runs: trade.runs.map((run) => {
      const money = run.money;
      const net = money?.net;
      if (!money || !net || net.method !== "mesure" || net.auec === null || !net.window) return run;
      const e = explainMovements({
        ...sources,
        from: net.window.from,
        fromInclusive: net.window.from_inclusive,
        to: net.window.to,
      });
      const decomposition = decomposeRun(
        e,
        {
          net: net.auec,
          margin: money.gross_margin,
          marginPartial: money.cost_paired || run.prior_stock_scu > 0,
        },
        net.window.from,
        net.window.to,
      );
      return { ...run, money: { ...money, decomposition } };
    }),
  };
}

/** The session section, from the same sources; null when fewer than two balances were seen. */
export function movementsSectionFor(
  sources: MovementSources,
  nowMs: number,
): MovementsSection | null {
  return buildMovementsSection({ ...sources, nowMs });
}
